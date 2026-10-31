/**
 * HTTP 缓存拦截器 —— 强缓存 + 协商缓存。
 *
 * 两种模式：
 *   1. `etag: 'auto'`   —— 对响应体做 sha256 生成 ETag。省事，但大 body 有哈希成本。
 *   2. `etag: 'header'` —— controller 自己算好 ETag（比如文档快照的 contentHash），
 *                         拦截器只负责设置头和 304 短路。大对象用这个。
 *
 * 协商缓存流程：
 *   请求带 If-None-Match → 与当前 ETag 比对 → 一致就返回 304（不带 body）
 *   304 让「重复打开同一个文档」不再传几 MB 快照，这是云文档最有效的一处优化。
 */

import {
    CallHandler,
    ExecutionContext,
    Injectable,
    NestInterceptor,
    SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { Observable, of } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import type { Request, Response } from 'express';

export const HTTP_CACHE_METADATA = 'HTTP_CACHE_METADATA';
/** controller 算好的 ETag 写到 res.locals，拦截器读它 */
export const ETAG_LOCAL = 'etag';

export interface HttpCacheOptions {
    /**
     * `auto`   ：拦截器对响应体哈希
     * `header` ：controller 把 ETag 放进 res.locals.etag
     */
    etag: 'auto' | 'header';
    /** 强缓存秒数；0 表示 must-revalidate（每次都协商） */
    maxAgeSeconds?: number;
    /** 是否 private（用户私有数据必须 true，否则中间代理会串号） */
    private?: boolean;
    /** 强制每次都要回源验证 */
    mustRevalidate?: boolean;
}

/**
 * 标记接口的缓存策略。
 *
 * 用法：
 *   @HttpCache({ etag: 'header', maxAgeSeconds: 0, private: true, mustRevalidate: true })
 */
export const HttpCache = (options: HttpCacheOptions) => SetMetadata(HTTP_CACHE_METADATA, options);

@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
    constructor(private readonly reflector: Reflector) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const options = this.reflector.getAllAndOverride<HttpCacheOptions | undefined>(
            HTTP_CACHE_METADATA,
            [context.getHandler(), context.getClass()]
        );
        if (!options) return next.handle();

        const request = context.switchToHttp().getRequest<Request>();
        const response = context.switchToHttp().getResponse<Response>();

        // 强缓存策略头。maxAge=0 + must-revalidate = 「可以缓存，但用之前必须回来验证」
        const directives: string[] = [];
        directives.push(options.private ? 'private' : 'public');
        directives.push(`max-age=${options.maxAgeSeconds ?? 0}`);
        if (options.mustRevalidate ?? options.maxAgeSeconds === 0) {
            directives.push('must-revalidate');
        }
        response.setHeader('Cache-Control', directives.join(', '));
        response.setHeader('Vary', 'Accept-Encoding, Authorization');

        // ETag 的判定必须在 controller 跑完之后：
        // 'header' 模式下 controller 才知道 contentHash，
        // 提前判会让 res.locals.etag 永远是 undefined，304 永远不生效。
        return next.handle().pipe(
            switchMap((data) => {
                const etag =
                    options.etag === 'header'
                        ? (response.locals[ETAG_LOCAL] as string | undefined)
                        : `"${createHash('sha256')
                              .update(JSON.stringify(data ?? null))
                              .digest('base64url')}"`;

                if (etag && this.isFresh(request, etag)) {
                    response.status(304);
                    return of(null);
                }
                if (etag) response.setHeader('ETag', etag);
                return of(data);
            })
        );
    }

    /** If-None-Match 比对，支持逗号分隔的多个 ETag 和弱校验器 W/"..." */
    private isFresh(request: Request, etag: string): boolean {
        const header = request.headers['if-none-match'];
        if (!header) return false;
        const candidates = String(header)
            .split(',')
            .map((s) => s.trim().replace(/^W\//, ''));
        return candidates.includes(etag) || candidates.includes('*');
    }
}
