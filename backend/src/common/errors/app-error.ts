/**
 * 统一错误码。
 *
 * 客户端按 code 做分支，不按 message —— message 会被翻译/改写，code 是契约。
 */

export enum ErrorCode {
    // ── 认证 / 授权 ──
    UNAUTHORIZED = 'UNAUTHORIZED',
    INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
    TOKEN_EXPIRED = 'TOKEN_EXPIRED',
    TOKEN_INVALID = 'TOKEN_INVALID',
    TOKEN_REUSED = 'TOKEN_REUSED',
    FORBIDDEN = 'FORBIDDEN',

    // ── 资源 ──
    NOT_FOUND = 'NOT_FOUND',
    ALREADY_EXISTS = 'ALREADY_EXISTS',
    CONFLICT = 'CONFLICT',
    GONE = 'GONE',

    // ── 入参 ──
    VALIDATION_FAILED = 'VALIDATION_FAILED',
    BAD_REQUEST = 'BAD_REQUEST',
    PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',

    // ── 限流 / 可用性 ──
    RATE_LIMITED = 'RATE_LIMITED',
    SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
    DEPENDENCY_FAILED = 'DEPENDENCY_FAILED',

    // ── 兜底 ──
    INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/** code → HTTP status 的默认映射 */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
    [ErrorCode.UNAUTHORIZED]: 401,
    [ErrorCode.INVALID_CREDENTIALS]: 401,
    [ErrorCode.TOKEN_EXPIRED]: 401,
    [ErrorCode.TOKEN_INVALID]: 401,
    [ErrorCode.TOKEN_REUSED]: 401,
    [ErrorCode.FORBIDDEN]: 403,

    [ErrorCode.NOT_FOUND]: 404,
    [ErrorCode.ALREADY_EXISTS]: 409,
    [ErrorCode.CONFLICT]: 409,
    [ErrorCode.GONE]: 410,

    [ErrorCode.VALIDATION_FAILED]: 422,
    [ErrorCode.BAD_REQUEST]: 400,
    [ErrorCode.PAYLOAD_TOO_LARGE]: 413,

    [ErrorCode.RATE_LIMITED]: 429,
    [ErrorCode.SERVICE_UNAVAILABLE]: 503,
    [ErrorCode.DEPENDENCY_FAILED]: 502,

    [ErrorCode.INTERNAL_ERROR]: 500,
};

export interface AppErrorOptions {
    /** 面向开发者的补充信息，会原样返回给客户端（不放敏感数据） */
    details?: unknown;
    /** 覆盖默认 HTTP status */
    status?: number;
    /** 原始异常，只进日志不进响应 */
    cause?: unknown;
}

/** 业务异常。所有 controller/service 抛错都用它，不要裸 throw new Error */
export class AppError extends Error {
    readonly code: ErrorCode;
    readonly status: number;
    readonly details?: unknown;
    readonly cause?: unknown;

    constructor(code: ErrorCode, message?: string, options: AppErrorOptions = {}) {
        super(message ?? code);
        this.name = 'AppError';
        this.code = code;
        this.status = options.status ?? ERROR_HTTP_STATUS[code] ?? 500;
        this.details = options.details;
        this.cause = options.cause;
    }

    // ── 语法糖：最常用的几个 ──

    static notFound(message = '资源不存在', details?: unknown): AppError {
        return new AppError(ErrorCode.NOT_FOUND, message, { details });
    }

    static unauthorized(message = '未登录或登录已过期'): AppError {
        return new AppError(ErrorCode.UNAUTHORIZED, message);
    }

    static forbidden(message = '没有权限'): AppError {
        return new AppError(ErrorCode.FORBIDDEN, message);
    }

    static validation(message = '入参校验失败', details?: unknown): AppError {
        return new AppError(ErrorCode.VALIDATION_FAILED, message, { details });
    }

    static conflict(message = '资源冲突', details?: unknown): AppError {
        return new AppError(ErrorCode.CONFLICT, message, { details });
    }

    static badRequest(message = '请求不合法', details?: unknown): AppError {
        return new AppError(ErrorCode.BAD_REQUEST, message, { details });
    }

    static rateLimited(message = '请求过于频繁'): AppError {
        return new AppError(ErrorCode.RATE_LIMITED, message);
    }

    static internal(message = '服务器内部错误', cause?: unknown): AppError {
        return new AppError(ErrorCode.INTERNAL_ERROR, message, { cause });
    }
}
