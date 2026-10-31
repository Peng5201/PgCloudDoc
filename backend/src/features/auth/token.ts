/**
 * 双 token 的签发与校验 —— **框架无关的核心**。
 *
 * 这里刻意不 import 任何 Nest / DI 的东西：签发和验签就是纯函数式逻辑，
 * 抽出来之后可以脱离容器直接单测（Nest 12 是纯 ESM 包，jest 在 Node 22 上
 * 连 `@Injectable` 都装不进来，见 token.service.ts 的说明）。
 * 装配交给 token.service.ts 那层薄薄的 `@Injectable` 包装。
 *
 * ## 双 token 的意义
 *
 * access token：短命（默认 15min）、无状态、放在 `Authorization: Bearer`
 *   → 服务端不查库就能验证，代价是签发后无法立即吊销
 *
 * refresh token：长命（默认 30d）、有状态（库 + Redis 黑名单）、放 httpOnly cookie
 *   → 浏览器脚本读不到，CSRF 靠 SameSite + 双重提交防御
 *
 * 「双 token」的意义：access 泄漏的影响被限制在 15 分钟内，
 * 而 refresh 泄漏能被轮换机制发现并整族吊销。
 *
 * JWT payload 只放标识信息，**不放权限列表** ——
 * 权限一变，JWT 还没过期就等于拿到了过期的权限。身份从 JWT 来，权限从库查。
 *
 * 用 `jsonwebtoken` 而不是 `@nestjs/jwt`：双 token 用两个不同的 secret，
 * 每次签发都要显式传，`JwtModule.register()` 那套「模块级统一配置」根本用不上，
 * 反而多一层间接。
 */

import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
import { AppError, ErrorCode } from '../../shared/errors/app-error';

export interface TokenConfig {
    accessSecret: string;
    refreshSecret: string;
    accessTokenTtl: number;
    refreshTokenTtl: number;
    issuer: string;
    audience: string;
}

export interface AccessTokenPayload {
    sub: string;
    username: string;
    email: string;
    tokenVersion: number;
    jti: string;
    type: 'access';
    /** 过期时间戳（秒），jsonwebtoken 校验时自动填 */
    exp?: number;
    iat?: number;
}

export interface RefreshTokenPayload {
    sub: string;
    familyId: string;
    jti: string;
    type: 'refresh';
    exp?: number;
    iat?: number;
}

export interface SignedTokens {
    accessToken: string;
    refreshToken: string;
    /** access token 的 jti，登出时写黑名单用 */
    accessJti: string;
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
}

export class TokenIssuer {
    constructor(private readonly config: TokenConfig) {}

    /** 签发一对 token */
    issueTokens(
        user: {
            id: string;
            username: string;
            email: string;
            tokenVersion: number;
        },
        familyId: string
    ): SignedTokens {
        const { config } = this;
        const now = Date.now();

        const accessJti = randomUUID();
        const accessToken = jwt.sign(
            {
                sub: user.id,
                username: user.username,
                email: user.email,
                tokenVersion: user.tokenVersion,
                jti: accessJti,
                type: 'access',
            },
            config.accessSecret,
            {
                expiresIn: config.accessTokenTtl,
                issuer: config.issuer,
                audience: config.audience,
            }
        );

        const refreshJti = randomUUID();
        const refreshToken = jwt.sign(
            {
                sub: user.id,
                familyId,
                jti: refreshJti,
                type: 'refresh',
            },
            config.refreshSecret,
            {
                expiresIn: config.refreshTokenTtl,
                issuer: config.issuer,
                audience: config.audience,
            }
        );

        return {
            accessToken,
            refreshToken,
            accessJti,
            accessExpiresAt: new Date(now + config.accessTokenTtl * 1000),
            refreshExpiresAt: new Date(now + config.refreshTokenTtl * 1000),
        };
    }

    /** 新建一个「登录会话」用的 familyId */
    newFamilyId(): string {
        return randomUUID();
    }

    verifyAccessToken(token: string): AccessTokenPayload {
        const payload = this.verify<AccessTokenPayload>(token, this.config.accessSecret);
        if (payload.type !== 'access') {
            throw new AppError(ErrorCode.TOKEN_INVALID, '令牌类型不正确');
        }
        return payload;
    }

    verifyRefreshToken(token: string): RefreshTokenPayload {
        const payload = this.verify<RefreshTokenPayload>(token, this.config.refreshSecret);
        if (payload.type !== 'refresh') {
            throw new AppError(ErrorCode.TOKEN_INVALID, '令牌类型不正确');
        }
        return payload;
    }

    /**
     * refresh token 的明文 → 库里存的哈希。
     *
     * 用 sha256 而不是 argon2：这里防的是「库被拖走后反查明文」，
     * 不需要抗暴力破解（token 本身就是高熵随机串，枚举不可行），
     * 而登录/刷新是热路径，argon2 的 3 轮计算会把 QPS 打下去。
     */
    hashToken(token: string): string {
        return createHash('sha256').update(token).digest('hex');
    }

    private verify<T extends object>(token: string, secret: string): T {
        try {
            return jwt.verify(token, secret, {
                issuer: this.config.issuer,
                audience: this.config.audience,
            }) as T;
        } catch (err) {
            // jsonwebtoken 用 err.name 区分：TokenExpiredError / JsonWebTokenError …
            const name = err instanceof Error ? err.name : '';
            if (name === 'TokenExpiredError' || /expired/i.test(String(name))) {
                throw new AppError(ErrorCode.TOKEN_EXPIRED, '登录已过期，请重新登录');
            }
            throw new AppError(ErrorCode.TOKEN_INVALID, '令牌无效');
        }
    }
}
