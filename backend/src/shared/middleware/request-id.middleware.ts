/**
 * requestId 中间件。
 *
 * 两件事：
 *   1. 保证每个响应都带 X-Request-Id（客户端给的沿用，否则新生成）
 *      —— 出问题时用户报一个 id，日志里就能定位到那次请求的完整链路
 *   2. 把 requestId / ip / ua 放进 AsyncLocalStorage，
 *      后续任意深度的 Service 都能取到，不用层层传参
 */

import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { RequestContextStore } from '../context/request-context';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
    use(req: Request, res: Response, next: NextFunction): void {
        const incoming = req.headers['x-request-id'];
        // 只接受形态合法的外部 requestId，避免被塞进日志的脏字符
        const requestId =
            typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming)
                ? incoming
                : randomUUID();

        res.setHeader('X-Request-Id', requestId);
        (req as Request & { requestId?: string }).requestId = requestId;

        RequestContextStore.run(
            {
                requestId,
                ip: req.ip,
                userAgent: req.headers['user-agent'],
                startedAt: Date.now(),
            },
            () => next()
        );
    }
}
