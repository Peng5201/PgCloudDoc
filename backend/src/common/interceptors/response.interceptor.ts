/**
 * 统一响应包装拦截器。
 *
 * 除少数需要完全控制响应体的接口（304、二进制下载）外，
 * 所有返回值都包成 { success: true, data, requestId }。
 *
 * 用 SetMetadata + Reflector 让个别接口 opt-out（@SkipWrap()），
 * 比在每个 controller 里手动包装干净得多。
 */

import {
    CallHandler,
    ExecutionContext,
    Injectable,
    NestInterceptor,
    SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { RequestContextStore } from '../context/request-context';

export const SKIP_RESPONSE_WRAP = 'SKIP_RESPONSE_WRAP';

/** 标记该接口自己负责响应体（304 / 文件流等） */
export const SkipWrap = () => SetMetadata(SKIP_RESPONSE_WRAP, true);

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
    constructor(private readonly reflector: Reflector) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RESPONSE_WRAP, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (skip) return next.handle();

        return next.handle().pipe(
            map((data) => {
                const request = context.switchToHttp().getRequest<Request>();
                const response = context.switchToHttp().getResponse<Response>();
                const requestId =
                    (request as Request & { requestId?: string }).requestId ??
                    response.getHeader('X-Request-Id')?.toString() ??
                    RequestContextStore.getRequestId();

                return {
                    success: true as const,
                    data: data ?? null,
                    requestId,
                };
            })
        );
    }
}
