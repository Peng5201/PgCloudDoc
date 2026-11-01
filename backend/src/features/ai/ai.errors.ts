/**
 * AI 错误 → SSE error payload。
 *
 * SSE 一旦开始就不能再换成 HTTP 错误响应，
 * 所以这里只暴露可编程的 code 和面向用户的 message，内部异常只进日志。
 */

import { AppError, ErrorCode } from '../../shared/errors/app-error';

export interface SseErrorPayload {
    code: string;
    message: string;
}

export function toSseErrorPayload(err: unknown): SseErrorPayload {
    if (err instanceof AppError) {
        return { code: err.code, message: err.message };
    }
    return { code: ErrorCode.INTERNAL_ERROR, message: 'AI 服务异常，请稍后重试' };
}
