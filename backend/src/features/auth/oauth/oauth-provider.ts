/**
 * OAuth2 / OIDC 第三方登录。
 *
 * 抽象成 `OAuthProvider` 接口是为了让「再接一个 provider」（企业 SSO、
 * GitHub、飞书…）只写一个实现类，不动 AuthService ——
 * 这就是 Open/Closed 在认证这块的具体形态。
 *
 * 走标准 Authorization Code 流：
 *   1. GET /auth/oauth/:provider          → 302 到 provider 的授权页
 *   2. provider 回调 GET /auth/oauth/:provider/callback?code=xxx
 *   3. 用 code 换 access_token，再拿 userinfo
 *   4. 按 (provider, providerUserId) 查 AuthIdentity：
 *        有  → 直接登录（首次绑定后无需再输密码）
 *        无  → 绑定到当前登录用户，或自动注册新用户
 *
 * state 参数必须校验：没有它就有一个 CSRF 漏洞 ——
 * 攻击者能把自己的 provider 账号绑到受害者账号上。
 */

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../../../config/app-config.service';
import { AppError, ErrorCode } from '../../../shared/errors/app-error';
import { RedisService } from '../../../infrastructure/redis/redis.service';

export interface OAuthUserInfo {
    provider: string;
    providerUserId: string;
    email?: string;
    displayName?: string;
    avatarUrl?: string;
    raw: unknown;
}

export interface OAuthProvider {
    readonly name: string;
    isEnabled(): boolean;
    /** 生成授权页 URL；state 由调用方生成并存起来 */
    buildAuthorizeUrl(state: string): string;
    /** 用授权码换用户信息 */
    exchangeCode(code: string): Promise<OAuthUserInfo>;
}

/**
 * state 的存取。放 Redis 带 TTL：
 *   - 一次性使用（用完即删），防止重放
 *   - 5 分钟过期，用户不完成授权就自动作废
 */
@Injectable()
export class OAuthStateStore {
    constructor(private readonly redis: RedisService) {}

    async issue(): Promise<string> {
        const state = randomUUID();
        await this.redis.set(`oauth:state:${state}`, '1', 5 * 60 * 1000);
        return state;
    }

    async consume(state: string): Promise<boolean> {
        const key = `oauth:state:${state}`;
        const exists = await this.redis.exists(key);
        if (exists) await this.redis.del(key);
        return exists;
    }
}

@Injectable()
export class GoogleOAuthProvider implements OAuthProvider {
    readonly name = 'google';

    private readonly authEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
    private readonly tokenEndpoint = 'https://oauth2.googleapis.com/token';
    private readonly userinfoEndpoint = 'https://openidconnect.googleapis.com/v1/userinfo';

    constructor(
        private readonly config: AppConfigService,
        private readonly stateStore: OAuthStateStore
    ) {}

    isEnabled(): boolean {
        return this.config.oauth.google.enabled;
    }

    buildAuthorizeUrl(state: string): string {
        const { google } = this.config.oauth;
        const params = new URLSearchParams({
            client_id: google.clientId,
            redirect_uri: google.redirectUri,
            response_type: 'code',
            scope: 'openid email profile',
            state,
            // 强制每次都要选账号，避免静默串号
            prompt: 'select_account',
            access_type: 'online',
        });
        return `${this.authEndpoint}?${params.toString()}`;
    }

    async exchangeCode(code: string): Promise<OAuthUserInfo> {
        const { google } = this.config.oauth;

        const tokenRes = await fetch(this.tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: google.clientId,
                client_secret: google.clientSecret,
                redirect_uri: google.redirectUri,
                grant_type: 'authorization_code',
            }),
        });

        if (!tokenRes.ok) {
            const body = await tokenRes.text();
            throw new AppError(ErrorCode.DEPENDENCY_FAILED, '第三方登录失败', {
                details: { status: tokenRes.status, body: body.slice(0, 500) },
            });
        }

        const tokens = (await tokenRes.json()) as { access_token: string };

        const userInfoRes = await fetch(this.userinfoEndpoint, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (!userInfoRes.ok) {
            throw new AppError(ErrorCode.DEPENDENCY_FAILED, '获取第三方用户信息失败');
        }

        const raw = (await userInfoRes.json()) as {
            sub: string;
            email?: string;
            name?: string;
            picture?: string;
        };

        return {
            provider: this.name,
            providerUserId: raw.sub,
            email: raw.email,
            displayName: raw.name,
            avatarUrl: raw.picture,
            raw,
        };
    }
}

/** provider 名 → 实现。AuthService 用它按 URL 参数分发 */
export const OAUTH_PROVIDERS = 'OAUTH_PROVIDERS';
