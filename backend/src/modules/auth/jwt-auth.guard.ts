/**
 * JWT 认证 Guard。
 *
 * **默认拒绝**：全局注册后，只有显式 `@Public()` 的路由放行。
 * 反过来（默认放行、逐个加 guard）会导致「新加接口忘了加 guard」这种事故，
 * 而默认拒绝最坏只是忘了加 @Public —— 多写一行，不会漏掉一整个接口的鉴权。
 */

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC, REQUEST_USER_KEY, type AuthUser } from '../../common/decorators/auth.decorators';
import { AppError } from '../../common/errors/app-error';
import { RequestContextStore } from '../../common/context/request-context';
import { AuthService } from './auth.service';

export const REFRESH_COOKIE_NAME = 'pgclouddoc_rt';

@Injectable()
export class JwtAuthGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly auth: AuthService
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
            context.getHandler(),
            context.getClass(),
        ]);

        const request = context
            .switchToHttp()
            .getRequest<Request & { [REQUEST_USER_KEY]?: AuthUser }>();

        const token = extractAccessToken(request);
        if (!token) {
            // 公开路由允许匿名访问；受保护路由直接拦下
            if (isPublic) return true;
            throw AppError.unauthorized('缺少访问令牌');
        }

        try {
            const verified = await this.auth.verifyAccess(token);
            request[REQUEST_USER_KEY] = {
                id: verified.id,
                username: verified.username,
                email: verified.email,
                tokenVersion: verified.tokenVersion,
            };
            // 让日志/审计能在任意深度拿到 userId
            RequestContextStore.setUserId(verified.id);
            return true;
        } catch (err) {
            // 公开路由上带着一个坏 token：不要因为 token 坏就拒绝访问，
            // 但也不能把坏 token 当成已登录（否则匿名用户会拿到别人的身份）
            if (isPublic) return true;
            throw err;
        }
    }
}

/**
 * 取 access token，两个来源：
 *   1. `Authorization: Bearer <token>` —— 浏览器/常规客户端
 *   2. `?access_token=<token>`        —— WebSocket 握手、`<img>`/`<a>` 这类
 *                                         无法自定义 header 的场景
 *
 * query 里的 token 会被打进访问日志，所以只在不得不的时候用，
 * 且服务端日志一律做脱敏（见 pino 的 redact 配置）。
 */
function extractAccessToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (header) {
        const [scheme, value] = header.split(' ');
        if (scheme?.toLowerCase() === 'bearer' && value) return value.trim();
    }

    const query = request.query['access_token'];
    if (typeof query === 'string' && query.length > 0) return query;

    return undefined;
}

export { extractAccessToken };
