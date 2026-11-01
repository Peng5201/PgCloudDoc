/**
 * SSE 写出器。
 *
 * 关键点：
 *   - 响应头在第一次 send 时才写：这样「会话不存在 / 配额超限」这类
 *     前置错误还能走统一 JSON 错误响应，而不是先 200 再 SSE error；
 *   - X-Accel-Buffering: no 让 nginx 不缓冲；
 *   - 15s 心跳防止中间代理把空闲连接掐掉；
 *   - 客户端断开后所有 write 都静默丢弃。
 */

import type { Response } from 'express';

export interface SseWriter {
    readonly started: boolean;
    readonly closed: boolean;
    send(event: string, data: unknown): void;
    comment(text: string): void;
    end(): void;
}

export function createSseWriter(res: Response): SseWriter {
    let started = false;
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const stop = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
        }
    };

    res.on('close', stop);
    res.on('error', stop);

    const ensureStarted = (): void => {
        if (started || closed) return;
        started = true;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();

        heartbeat = setInterval(() => {
            if (closed) return;
            res.write(': ping\n\n');
        }, 15_000);
        heartbeat.unref?.();
    };

    return {
        get started() {
            return started;
        },
        get closed() {
            return closed;
        },
        send(event, data) {
            if (closed) return;
            ensureStarted();
            if (closed) return;
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        },
        comment(text) {
            if (closed) return;
            ensureStarted();
            if (closed) return;
            res.write(`: ${text}\n\n`);
        },
        end() {
            if (closed) return;
            if (!started) return;
            stop();
            try {
                res.end();
            } catch {
                // 客户端已经断开
            }
        },
    };
}
