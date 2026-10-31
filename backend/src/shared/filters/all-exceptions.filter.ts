/**
 * 全局异常过滤器 —— 把任何异常翻译成统一错误体。
 *
 * 三条硬规则：
 *   1. **不泄漏内部细节**：未知异常的 message / stack 只进日志，
 *      返回给客户端的一律是「服务器内部错误」。用户不需要知道你的 SQL 长什么样。
 *   2. **AppError 是唯一合法的业务抛错方式**：code / status / details 由它带下来。
 *   3. **Prisma 错误要翻译**：唯一键冲突不能把 `P2002` 直接丢给前端。
 */

import {
    ArgumentsHost,
    Catch,
    ExceptionFilter,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '../errors/app-error';
import { RequestContextStore } from '../context/request-context';

interface ErrorBody {
    success: false;
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
    private readonly logger = new Logger(AllExceptionsFilter.name);

    catch(exception: unknown, host: ArgumentsHost): void {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();
        const requestId =
            (request as Request & { requestId?: string }).requestId ??
            RequestContextStore.getRequestId();

        const { status, body } = this.normalize(exception, requestId);

        // 5xx 记 error（带 stack），4xx 记 warn 就够了 —— 用户输错密码不是服务端的错
        const logPayload = {
            requestId,
            method: request.method,
            path: request.url,
            status,
            code: body.code,
            userId: RequestContextStore.getUserId(),
        };

        if (status >= 500) {
            this.logger.error(
                `${logPayload.method} ${logPayload.path} ${status} ${body.code}`,
                exception instanceof Error ? exception.stack : String(exception)
            );
        } else if (status >= 400) {
            this.logger.warn(
                `${logPayload.method} ${logPayload.path} ${status} ${body.code} :: ${body.message}`
            );
        }

        response.status(status).json(body);
    }

    private normalize(
        exception: unknown,
        requestId: string
    ): { status: number; body: ErrorBody } {
        // 1) 业务异常
        if (exception instanceof AppError) {
            return {
                status: exception.status,
                body: {
                    success: false,
                    code: exception.code,
                    message: exception.message,
                    details: exception.details,
                    requestId,
                },
            };
        }

        // 2) Nest 的 HttpException（含 ValidationPipe 抛出的）
        if (exception instanceof HttpException) {
            const status = exception.getStatus();
            const payload = exception.getResponse();
            const message =
                typeof payload === 'string'
                    ? payload
                    : ((payload as { message?: string | string[] }).message ?? exception.message);
            const code = this.codeForStatus(status);

            return {
                status,
                body: {
                    success: false,
                    code,
                    message: Array.isArray(message) ? message.join('; ') : message,
                    details: typeof payload === 'object' ? payload : undefined,
                    requestId,
                },
            };
        }

        // 3) Prisma 错误（结构化判断，避免 common 层依赖 infra）
        const prisma = this.asPrismaError(exception);
        if (prisma) {
            const mapped = this.fromPrisma(prisma);
            return {
                status: mapped.status,
                body: {
                    success: false,
                    code: mapped.code,
                    message: mapped.message,
                    details: mapped.details,
                    requestId,
                },
            };
        }

        // 4) 兜底：什么都不返回，只留 requestId 便于在日志里翻出真因
        return {
            status: HttpStatus.INTERNAL_SERVER_ERROR,
            body: {
                success: false,
                code: ErrorCode.INTERNAL_ERROR,
                message: '服务器内部错误',
                requestId,
            },
        };
    }

    private codeForStatus(status: number): ErrorCode {
        switch (status) {
            case 400:
                return ErrorCode.BAD_REQUEST;
            case 401:
                return ErrorCode.UNAUTHORIZED;
            case 403:
                return ErrorCode.FORBIDDEN;
            case 404:
                return ErrorCode.NOT_FOUND;
            case 409:
                return ErrorCode.CONFLICT;
            case 413:
                return ErrorCode.PAYLOAD_TOO_LARGE;
            case 422:
                return ErrorCode.VALIDATION_FAILED;
            case 429:
                return ErrorCode.RATE_LIMITED;
            case 503:
                return ErrorCode.SERVICE_UNAVAILABLE;
            default:
                return status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.BAD_REQUEST;
        }
    }

    /** Prisma 的错误有 code 字段（P2xxx），据此判断，不引入具体类型依赖 */
    private asPrismaError(err: unknown): { code: string; meta?: unknown } | null {
        if (typeof err !== 'object' || err === null) return null;
        const code = (err as { code?: unknown }).code;
        if (typeof code === 'string' && /^P\d{4}$/.test(code)) {
            return err as { code: string; meta?: unknown };
        }
        return null;
    }

    private fromPrisma(err: { code: string; meta?: unknown }): {
        status: number;
        code: ErrorCode;
        message: string;
        details?: unknown;
    } {
        switch (err.code) {
            case 'P2002': {
                const target = (err.meta as { target?: string[] } | undefined)?.target;
                return {
                    status: HttpStatus.CONFLICT,
                    code: ErrorCode.ALREADY_EXISTS,
                    message: `已存在相同记录${target ? `：${target.join(', ')}` : ''}`,
                    details: { constraint: target },
                };
            }
            case 'P2025':
                return {
                    status: HttpStatus.NOT_FOUND,
                    code: ErrorCode.NOT_FOUND,
                    message: '记录不存在',
                };
            case 'P2003':
                return {
                    status: HttpStatus.CONFLICT,
                    code: ErrorCode.CONFLICT,
                    message: '关联数据约束冲突',
                    details: err.meta,
                };
            case 'P2024':
                return {
                    status: HttpStatus.SERVICE_UNAVAILABLE,
                    code: ErrorCode.DEPENDENCY_FAILED,
                    message: '数据库连接超时',
                };
            default:
                return {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    code: ErrorCode.DEPENDENCY_FAILED,
                    message: '数据库操作失败',
                };
        }
    }
}
