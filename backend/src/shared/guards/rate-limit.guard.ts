/**
 * 限流装饰器 + Guard。
 *
 * 覆盖全局限流覆盖不到的场景：登录接口被爆破时要单独收紧，
 * 不能因为全局是 300/min 就让攻击者一分钟试 300 个密码。
 *
 * 限流主体优先用 userId（登录后），没有就退到 IP ——
 * 只按 IP 限流会让整个公司出口 IP 的正常用户互相拖累。
 */

import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { RateLimitService } from '../../infrastructure/redis/rate-limit.service';
import { AppError } from '../errors/app-error';

export interface RateLimitOptions {
    /** 桶名，如 'auth:login'。同一路由的不同动作要用不同桶 */
    bucket: string;
    /** 窗口长度（毫秒） */
    windowMs: number;
    /** 窗口内最大次数 */
    limit: number;
}

export const RATE_LIMIT_METADATA = 'RATE_LIMIT_METADATA';

export const RateLimit = (options: RateLimitOptions) =>
    SetMetadata(RATE_LIMIT_METADATA, options);

@Injectable()
export class RateLimitGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly rateLimit: RateLimitService
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(
            RATE_LIMIT_METADATA,
            [context.getHandler(), context.getClass()]
        );
        if (!options) return true;

        const request = context.switchToHttp().getRequest<Request & { user?: { id: string } }>();
        const response = context.switchToHttp().getResponse<Response>();

        // 登录后按用户限流，登录前按 IP —— 两者都不能是 undefined
        const subject = request.user?.id ?? request.ip ?? 'unknown';

        const result = await this.rateLimit.consume(
            options.bucket,
            subject,
            options.limit,
            options.windowMs
        );

        response.setHeader('X-RateLimit-Limit', String(options.limit));
        response.setHeader('X-RateLimit-Remaining', String(result.remaining));

        if (!result.allowed) {
            response.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
            throw AppError.rateLimited(
                `请求过于频繁，请 ${Math.ceil(result.retryAfterMs / 1000)} 秒后重试`
            );
        }

        return true;
    }
}
