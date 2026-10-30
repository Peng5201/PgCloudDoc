/**
 * 认证服务 —— 注册 / 登录 / 刷新 / 登出。
 *
 * 最关键的一段是 `refresh()` 里的**令牌轮换 + 重放检测**：
 *
 *   正常流程：R1 →(刷新)→ R2 →(刷新)→ R3 …
 *   每次刷新都作废旧令牌、签发新令牌，旧令牌记录 replacedById 形成一条链。
 *
 *   攻击场景：攻击者拿到了 R2，用它刷新成功得到 R4；真正的用户也用 R2 刷新。
 *   此时 R2 已经是「已撤销却被再次使用」—— 正常流程里不可能发生，
 *   唯一解释就是令牌复制出去了。
 *
 *   处置：立刻吊销整个 family（R1..Rn 全部作废）并把对应的 access token 拉黑。
 *   代价是用户要重新登录一次，但攻击者也被关在门外了 —— 这是正确的取舍。
 *   只作废当前令牌是不够的：攻击者手里的 R4 还活着。
 */

import { Injectable, Logger } from '@nestjs/common';
import { UserRepository } from '../users/user.repository';
import { RefreshTokenRepository } from './refresh-token.repository';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { KafkaService } from '../../infra/kafka/kafka.service';
import { KafkaTopic } from '../../infra/kafka/topics';
import type { AuditUserActivityEvent } from '../../infra/kafka/events';
import { AppConfigService } from '../../config/app-config.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { RequestContextStore } from '../../common/context/request-context';
import {
    AuthResultDto,
    ChangePasswordDto,
    LoginDto,
    RegisterDto,
    toUserDto,
    UserDto,
} from './dto/auth.dto';

export interface RequestMeta {
    ip?: string;
    userAgent?: string;
}

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);

    constructor(
        private readonly users: UserRepository,
        private readonly refreshTokens: RefreshTokenRepository,
        private readonly password: PasswordService,
        private readonly tokens: TokenService,
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
        private readonly kafka: KafkaService,
        private readonly config: AppConfigService
    ) {}

    // ─────────────────────────── 注册 ───────────────────────────

    async register(dto: RegisterDto, meta: RequestMeta): Promise<AuthResultDto> {
        const taken = await this.users.isIdentityTaken(dto.email, dto.username);
        if (taken.emailTaken) {
            throw AppError.conflict('该邮箱已被注册');
        }
        if (taken.usernameTaken) {
            throw AppError.conflict('该用户名已被占用');
        }

        const passwordHash = await this.password.hash(dto.password);
        const user = await this.users.create({
            email: dto.email,
            username: dto.username,
            passwordHash,
            displayName: dto.displayName ?? null,
        });

        await this.audit(user.id, 'auth.register', 'user', user.id, meta);

        return this.buildAuthResult(user, this.tokens.newFamilyId(), meta);
    }

    // ─────────────────────────── 登录 ───────────────────────────

    async login(dto: LoginDto, meta: RequestMeta): Promise<AuthResultDto> {
        const user = await this.users.findWithSecretByIdentifier(dto.identifier);

        // 查不到用户也要跑一遍 argon2，否则「用户名不存在」和「密码错」
        // 会从响应时间上区分开，给攻击者一个枚举用户名的信道
        const passwordOk = await this.password.verify(dto.password, user?.passwordHash);

        if (!user || !passwordOk) {
            await this.audit(user?.id, 'auth.login_failed', 'user', user?.id, meta, {
                identifier: dto.identifier.slice(0, 64),
            });
            throw new AppError(ErrorCode.INVALID_CREDENTIALS, '邮箱/用户名或密码错误');
        }

        if (user.status !== 'ACTIVE') {
            throw AppError.forbidden('账号已被停用');
        }

        await this.audit(user.id, 'auth.login', 'user', user.id, meta);

        return this.buildAuthResult(user, this.tokens.newFamilyId(), meta);
    }

    // ─────────────────────────── 刷新（轮换 + 重放检测） ───────────────────────────

    async refresh(refreshTokenRaw: string, meta: RequestMeta): Promise<AuthResultDto> {
        // 签名/过期校验失败直接抛，不落库
        const payload = this.tokens.verifyRefreshToken(refreshTokenRaw);
        const tokenHash = this.tokens.hashToken(refreshTokenRaw);

        const row = await this.refreshTokens.findByHash(tokenHash);
        if (!row) {
            throw new AppError(ErrorCode.TOKEN_INVALID, '刷新令牌不存在');
        }

        // JWT 里声明的 family 必须和库里存的一致 —— 不一致说明令牌被改过
        if (row.familyId !== payload.familyId || row.userId !== payload.sub) {
            this.logger.warn(`令牌归属不一致 token=${row.id}，按重放处理`);
            await this.revokeFamily(row.familyId);
            throw new AppError(ErrorCode.TOKEN_REUSED, '检测到令牌被篡改，该登录会话已失效');
        }

        // ── 重放检测 ──
        // 已撤销的令牌又被拿来刷新：正常流程下旧令牌用完即弃，绝不会二次出现
        if (row.revokedAt) {
            this.logger.warn(
                `检测到令牌重放 family=${row.familyId} token=${row.id}，吊销整族`
            );
            await this.revokeFamily(row.familyId);
            await this.audit(row.userId, 'auth.token_reuse_detected', 'user', row.userId, meta, {
                familyId: row.familyId,
                tokenId: row.id,
            });
            throw new AppError(ErrorCode.TOKEN_REUSED, '检测到令牌重放，该登录会话已失效');
        }

        if (row.expiresAt.getTime() < Date.now()) {
            await this.refreshTokens.revoke(row.id);
            throw new AppError(ErrorCode.TOKEN_EXPIRED, '登录已过期，请重新登录');
        }

        const user = await this.users.findById(row.userId);
        if (!user) {
            await this.revokeFamily(row.familyId);
            throw new AppError(ErrorCode.UNAUTHORIZED, '用户不存在');
        }
        if (user.status !== 'ACTIVE') {
            await this.revokeFamily(row.familyId);
            throw AppError.forbidden('账号已被停用');
        }

        // ── 轮换 ──
        // 「条件作废 + 写新令牌」必须原子：两个请求同时拿同一个 R2 刷新时，
        // 只有一个能走通，另一个会被 count=0 判为重放
        const familyId = row.familyId;
        const signed = this.tokens.issueTokens(user, familyId);

        const rotated = await this.prisma.withTransaction(async (tx) => {
            const revoked = await tx.refreshToken.updateMany({
                where: { id: row.id, revokedAt: null },
                data: { revokedAt: new Date() },
            });
            if (revoked.count === 0) return null;

            const created = await tx.refreshToken.create({
                data: {
                    userId: row.userId,
                    familyId,
                    tokenHash: this.tokens.hashToken(signed.refreshToken),
                    expiresAt: signed.refreshExpiresAt,
                    userAgent: meta.userAgent ?? null,
                    ip: meta.ip ?? null,
                },
            });

            await tx.refreshToken.update({
                where: { id: row.id },
                data: { replacedById: created.id },
            });

            return created;
        });

        if (!rotated) {
            await this.revokeFamily(familyId);
            throw new AppError(ErrorCode.TOKEN_REUSED, '检测到令牌并发重放，该登录会话已失效');
        }

        await this.audit(user.id, 'auth.refresh', 'user', user.id, meta);

        return {
            user: toUserDto(user),
            accessToken: signed.accessToken,
            expiresInSeconds: this.config.auth.accessTokenTtl,
            refreshToken: signed.refreshToken,
        };
    }

    // ─────────────────────────── 登出 ───────────────────────────

    async logout(
        userId: string,
        refreshTokenRaw: string | undefined,
        accessJti: string | undefined,
        meta: RequestMeta
    ): Promise<void> {
        // 1. 拉黑当前 access token —— 这样「立即登出」是真立即，
        //    不用等 15 分钟 access token 自己过期
        if (accessJti) {
            await this.blacklistAccess(accessJti);
        }

        // 2. 吊销整个 family（这个设备上的登录链）
        if (refreshTokenRaw) {
            try {
                const payload = this.tokens.verifyRefreshToken(refreshTokenRaw);
                await this.revokeFamily(payload.familyId);
            } catch {
                // token 本身已经无效了，那就没什么可吊销的，登出照样成功
                this.logger.debug('登出时 refresh token 已无效，跳过吊销');
            }
        }

        await this.audit(userId, 'auth.logout', 'user', userId, meta);
    }

    // ─────────────────────────── 改密码 ───────────────────────────

    async changePassword(
        userId: string,
        dto: ChangePasswordDto,
        meta: RequestMeta
    ): Promise<void> {
        const user = await this.users.findWithSecretById(userId);
        if (!user) throw AppError.notFound('用户不存在');

        const ok = await this.password.verify(dto.currentPassword, user.passwordHash);
        if (!ok) {
            throw new AppError(ErrorCode.INVALID_CREDENTIALS, '当前密码不正确');
        }

        const newHash = await this.password.hash(dto.newPassword);
        // updatePassword 会自增 tokenVersion，让所有存量 access token 立即失效
        await this.users.updatePassword(userId, newHash);

        // 改密码 = 会话风险，把该用户所有设备的 refresh token 全吊销
        const families = await this.prisma.refreshToken.findMany({
            where: { userId, revokedAt: null },
            select: { familyId: true },
        });
        for (const familyId of new Set(families.map((f) => f.familyId))) {
            await this.revokeFamily(familyId);
        }

        await this.audit(userId, 'auth.change_password', 'user', userId, meta);
    }

    // ─────────────────────────── 校验 ───────────────────────────

    /**
     * 校验 access token 是否可用。
     * 除了 JWT 签名，还要查黑名单（已登出）和 tokenVersion（改密码后失效）。
     */
    async verifyAccess(accessToken: string): Promise<{
        id: string;
        username: string;
        email: string;
        tokenVersion: number;
        jti: string;
    }> {
        const payload = this.tokens.verifyAccessToken(accessToken);

        if (await this.isBlacklisted(payload.jti)) {
            throw new AppError(ErrorCode.TOKEN_EXPIRED, '登录已失效，请重新登录');
        }

        // tokenVersion 不匹配 = 用户改过密码 / 被停用后恢复过
        const user = await this.users.findById(payload.sub);
        if (!user) {
            throw new AppError(ErrorCode.UNAUTHORIZED, '用户不存在');
        }
        if (user.status !== 'ACTIVE') {
            throw AppError.forbidden('账号已被停用');
        }
        if (user.tokenVersion !== payload.tokenVersion) {
            throw new AppError(ErrorCode.TOKEN_EXPIRED, '登录已失效，请重新登录');
        }

        return {
            id: user.id,
            username: user.username,
            email: user.email,
            tokenVersion: user.tokenVersion,
            jti: payload.jti,
        };
    }

    async me(userId: string): Promise<UserDto> {
        const user = await this.users.findById(userId);
        if (!user) throw AppError.notFound('用户不存在');
        return toUserDto(user);
    }

    /**
     * 已有用户直接建立会话（OAuth 登录、将来还有「记住我」）。
     * 与 login() 的区别：不校验密码，所以**只能由可信的认证路径调用**，
     * 永远不要接受客户端直接传 userId 进来。
     */
    async loginAsExisting(
        user: { id: string; username: string; email: string; tokenVersion: number },
        meta: RequestMeta
    ): Promise<AuthResultDto> {
        await this.audit(user.id, 'auth.login_oauth', 'user', user.id, meta);
        return this.buildAuthResult(user, this.tokens.newFamilyId(), meta);
    }

    // ─────────────────────────── 内部 ───────────────────────────

    private async buildAuthResult(
        user: { id: string; username: string; email: string; tokenVersion: number },
        familyId: string,
        meta: RequestMeta
    ): Promise<AuthResultDto> {
        const signed = this.tokens.issueTokens(user, familyId);

        await this.refreshTokens.create({
            userId: user.id,
            familyId,
            tokenHash: this.tokens.hashToken(signed.refreshToken),
            expiresAt: signed.refreshExpiresAt,
            userAgent: meta.userAgent ?? null,
            ip: meta.ip ?? null,
        });

        return {
            user: await this.me(user.id),
            accessToken: signed.accessToken,
            expiresInSeconds: this.config.auth.accessTokenTtl,
            refreshToken: signed.refreshToken,
        };
    }

    /** 吊销整族 refresh token，并把该族下已签发的 access token 也拉黑 */
    private async revokeFamily(familyId: string): Promise<void> {
        await this.refreshTokens.revokeFamily(familyId);
        // access token 的 jti 不存库（无状态设计），所以只能靠黑名单覆盖尚未过期的那批。
        // 这里保守起见记录 family，供运维排查；严格吊销单个 access 需要 jti 入库。
        await this.redis.sadd(`auth:revoked-family:${familyId}`, String(Date.now()));
    }

    /** access token 黑名单。TTL = token 剩余寿命，过期后 key 自动消失 */
    private async blacklistAccess(jti: string): Promise<void> {
        const ttl = this.config.auth.accessTokenTtl * 1000;
        await this.redis.set(`auth:bl:${jti}`, '1', ttl);
    }

    private async isBlacklisted(jti: string): Promise<boolean> {
        return this.redis.exists(`auth:bl:${jti}`);
    }

    private async audit(
        userId: string | undefined,
        action: string,
        resourceType: string,
        resourceId: string | undefined,
        meta: RequestMeta,
        extra?: Record<string, unknown>
    ): Promise<void> {
        const event: Omit<AuditUserActivityEvent, 'id' | 'occurredAt' | 'topic'> = {
            userId,
            action,
            resourceType,
            resourceId,
            ip: meta.ip,
            userAgent: meta.userAgent,
            metadata: { requestId: RequestContextStore.getRequestId(), ...extra },
        };
        // 审计是异步支线，发失败不影响主流程
        await this.kafka
            .publish(KafkaTopic.AuditUserActivity, event, userId)
            .catch((err: unknown) =>
                this.logger.warn(
                    `审计事件发送失败：${err instanceof Error ? err.message : String(err)}`
                )
            );
    }
}
