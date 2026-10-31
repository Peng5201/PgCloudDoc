/**
 * OAuth 编排：身份绑定 + 自动注册。
 *
 * 独立于 AuthService 是因为这套逻辑和「账号密码」那条路完全正交：
 * 两者最后都汇到 issueTokens，但中间的用户查找/创建策略不一样。
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { UserRepository } from '../../users/user.repository';
import { IdentityRepository } from './identity.repository';
import {
    OAuthProvider,
    OAuthStateStore,
    OAUTH_PROVIDERS,
    OAuthUserInfo,
} from './oauth-provider';
import { Inject } from '@nestjs/common';
import { AppError, ErrorCode } from '../../../shared/errors/app-error';

@Injectable()
export class OAuthService {
    private readonly logger = new Logger(OAuthService.name);

    constructor(
        @Inject(OAUTH_PROVIDERS) private readonly providers: OAuthProvider[],
        private readonly stateStore: OAuthStateStore,
        private readonly users: UserRepository,
        private readonly identities: IdentityRepository
    ) {}

    getProvider(name: string): OAuthProvider {
        const provider = this.providers.find((p) => p.name === name);
        if (!provider) {
            throw AppError.notFound(`不支持的登录方式：${name}`);
        }
        if (!provider.isEnabled()) {
            throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, `登录方式未启用：${name}`);
        }
        return provider;
    }

    /** 生成授权链接 + state */
    async begin(providerName: string): Promise<string> {
        const provider = this.getProvider(providerName);
        const state = await this.stateStore.issue();
        return provider.buildAuthorizeUrl(state);
    }

    /**
     * 回调处理：换用户信息 → 找/建用户。
     * 返回的是「用户 id」，token 签发交回调用方（AuthService），
     * 保持两条登录路径的令牌逻辑只有一份。
     */
    async complete(providerName: string, code: string, state: string): Promise<{
        userId: string;
        isNewUser: boolean;
    }> {
        const provider = this.getProvider(providerName);

        const stateOk = await this.stateStore.consume(state);
        if (!stateOk) {
            throw new AppError(ErrorCode.BAD_REQUEST, '登录状态已过期，请重试');
        }

        const info = await provider.exchangeCode(code);
        return this.resolveUser(info);
    }

    private async resolveUser(info: OAuthUserInfo): Promise<{
        userId: string;
        isNewUser: boolean;
    }> {
        // 1. 已绑定 → 直接登录
        const existing = await this.identities.findByProvider(
            info.provider,
            info.providerUserId
        );
        if (existing) {
            return { userId: existing.userId, isNewUser: false };
        }

        // 2. 没绑定，但邮箱已存在于系统 → 视为同一人，补绑定
        //    （用户用邮箱注册过，现在用同一邮箱的 Google 登录）
        if (info.email) {
            const byEmail = await this.users.findByEmail(info.email);
            if (byEmail) {
                await this.identities.bind({
                    provider: info.provider,
                    providerUserId: info.providerUserId,
                    userId: byEmail.id,
                    email: info.email,
                    raw: info.raw,
                });
                this.logger.log(`OAuth 身份已绑定到既有用户 ${byEmail.id}`);
                return { userId: byEmail.id, isNewUser: false };
            }
        }

        // 3. 全新用户 → 自动注册
        //    没有密码（passwordHash 为 null），只能走第三方登录
        const username = await this.allocateUsername(info);
        const user = await this.users.create({
            email: (info.email ?? `${info.provider}-${info.providerUserId}@oauth.local`).toLowerCase(),
            username,
            // OAuth 用户没有本地密码
            passwordHash: '',
            displayName: info.displayName ?? null,
        });

        await this.identities.bind({
            provider: info.provider,
            providerUserId: info.providerUserId,
            userId: user.id,
            email: info.email,
            raw: info.raw,
        });

        return { userId: user.id, isNewUser: true };
    }

    /** 用户名从 displayName 派生，撞了就加后缀，直到唯一 */
    private async allocateUsername(info: OAuthUserInfo): Promise<string> {
        const base =
            (info.displayName ?? info.email?.split('@')[0] ?? info.provider)
                .toLowerCase()
                .replace(/[^a-z0-9_]/g, '')
                .slice(0, 24) || 'user';

        const candidate = base.length >= 3 ? base : `${base}_user`;
        if (!(await this.users.findByUsername(candidate))) return candidate;

        for (let i = 2; i < 100; i++) {
            const next = `${candidate}_${i}`;
            if (!(await this.users.findByUsername(next))) return next;
        }
        return `${candidate}_${randomUUID().slice(0, 8)}`;
    }
}
