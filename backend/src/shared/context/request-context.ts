/**
 * 请求上下文 —— 用 AsyncLocalStorage 把 requestId / 用户信息
 * 贯穿整个调用链，中间件、Guard、Service、日志都能取到，不用层层传参。
 *
 * 为什么不挂到 req 上：Service 层不应该依赖 Express 的 Request 对象，
 * 否则换个传输层（WS / Kafka 消费者）就得改一圈业务代码。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
    requestId: string;
    /** 当前登录用户 id，未登录为 undefined */
    userId?: string;
    ip?: string;
    userAgent?: string;
    /** 请求开始时间，算耗时用 */
    startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const RequestContextStore = {
    /** 在一段逻辑里跑，期间 getContext() 都能拿到 ctx */
    run<T>(ctx: RequestContext, fn: () => T): T {
        return storage.run(ctx, fn);
    },

    getContext(): RequestContext | undefined {
        return storage.getStore();
    },

    /** 取 requestId，没有上下文时回退到 '-'，日志格式统一 */
    getRequestId(): string {
        return storage.getStore()?.requestId ?? '-';
    },

    getUserId(): string | undefined {
        return storage.getStore()?.userId;
    },

    /** 中途补上 userId（登录成功后调用） */
    setUserId(userId: string): void {
        const ctx = storage.getStore();
        if (ctx) ctx.userId = userId;
    },
};
