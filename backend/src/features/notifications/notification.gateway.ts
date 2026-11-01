/**
 * 用户级通知 WebSocket 网关。
 *
 * 与 collab 的差异：collab 按「文档」路由（/collab/:docId），
 * 通知按「用户」路由（/notifications）—— 不管用户此刻在看哪个文档，
 * 服务端都能把消息推到他的所有在线连接。
 *
 * 协议：纯 JSON 文本帧。客户端只收不主动发（已读走 REST）。
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { AuthService } from '../auth/auth.service';
import { startWsHeartbeat } from '../../shared/ws-heartbeat';

@Injectable()
export class NotificationGateway implements OnModuleDestroy {
    private readonly logger = new Logger(NotificationGateway.name);
    private readonly connections = new Map<string, Set<WebSocket>>();
    private wss: WebSocketServer | null = null;

    constructor(private readonly auth: AuthService) {}

    /** 由 main.ts 调用，挂到 HTTP server 的 upgrade 事件上 */
    attach(httpServer: HttpServer): void {
        this.wss = new WebSocketServer({ noServer: true });

        httpServer.on('upgrade', (request, socket, head) => {
            const url = new URL(request.url ?? '/', 'http://localhost');
            if (!url.pathname.startsWith('/notifications')) return;

            this.wss?.handleUpgrade(request, socket, head, (ws) => {
                this.wss?.emit('connection', ws, request);
            });
        });

        this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
            void this.onConnection(ws, request).catch((err: unknown) => {
                this.logger.error(`通知 WS 连接异常：${String(err)}`);
                ws.close(4000, '内部错误');
            });
        });

        this.logger.log('通知服务已挂载：/notifications');
    }

    private async onConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const token =
            url.searchParams.get('access_token') ??
            this.tokenFromCookie(request.headers['cookie']);

        if (!token) {
            ws.close(4001, '缺少访问令牌');
            return;
        }

        let userId: string;
        try {
            userId = (await this.auth.verifyAccess(token)).id;
        } catch {
            ws.close(4001, '登录已失效');
            return;
        }

        let set = this.connections.get(userId);
        if (!set) {
            set = new Set();
            this.connections.set(userId, set);
        }
        set.add(ws);

        // 和协同连接一样：没有心跳的话，空闲一小时会被 nginx 掐断
        startWsHeartbeat(ws);

        ws.on('close', () => {
            set?.delete(ws);
            if (set && set.size === 0) this.connections.delete(userId);
        });
        ws.on('error', () => {
            // close 会跟着触发，这里静默
        });
    }

    /** 推送给某用户的全部在线连接；不在线就跳过（消息已持久化，可回看） */
    async push(userId: string, payload: unknown): Promise<void> {
        const set = this.connections.get(userId);
        if (!set || set.size === 0) return;

        const data = JSON.stringify(payload);
        for (const ws of set) {
            if (ws.readyState === ws.OPEN) {
                ws.send(data);
            }
        }
    }

    onModuleDestroy(): void {
        for (const set of this.connections.values()) {
            for (const ws of set) ws.close();
        }
        this.connections.clear();
        this.wss?.close();
    }

    private tokenFromCookie(cookieHeader: string | undefined): string | undefined {
        if (!cookieHeader) return undefined;
        for (const part of cookieHeader.split(';')) {
            const [key, ...rest] = part.trim().split('=');
            if (key === 'access_token') return decodeURIComponent(rest.join('='));
        }
        return undefined;
    }
}
