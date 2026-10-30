/**
 * 站内消息。
 *
 * 双通道：REST 拉历史 / 已读，WebSocket 收实时增量（左下角弹框靠它即时弹出）。
 */

import { api, getAccessToken, refreshAccessToken } from './client';

export interface Notification {
    id: string;
    type: string;
    title: string;
    body: string | null;
    payload: { documentId?: string; documentName?: string; role?: string } | null;
    read: boolean;
    createdAt: string;
}

export const notificationsApi = {
    list(): Promise<Notification[]> {
        return api.get<Notification[]>('/api/v1/notifications');
    },

    unreadCount(): Promise<number> {
        return api.get<number>('/api/v1/notifications/unread-count');
    },

    markRead(ids: string[]): Promise<void> {
        return api.post<void>('/api/v1/notifications/read', { ids });
    },

    markAllRead(): Promise<void> {
        return api.post<void>('/api/v1/notifications/read-all');
    },
};

/**
 * 建立通知 WebSocket，服务端推消息时回调 onMessage。
 * 返回断开函数。断线自动指数退避重连。
 */
export function connectNotifications(
    onMessage: (notification: Notification) => void
): () => void {
    let ws: WebSocket | null = null;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

    function scheduleReconnect(): void {
        if (disposed) return;
        const delay = Math.min(1000 * 2 ** attempts, 10_000);
        attempts++;
        retryTimer = setTimeout(connect, delay);
    }

    function connect(): void {
        if (disposed) return;

        // 每次（重）连都现取 token：access token 只有 15 分钟，
        // 用建连时的旧 token 重连会被服务端 4001 拒掉
        const token = getAccessToken();
        if (!token) {
            scheduleReconnect();
            return;
        }

        ws = new WebSocket(`${base}/notifications?access_token=${encodeURIComponent(token)}`);

        ws.onopen = () => {
            // 连上了就把退避清零，下次断线重新从 1s 开始
            attempts = 0;
        };

        ws.onmessage = (event) => {
            if (typeof event.data !== 'string') return;
            try {
                onMessage(JSON.parse(event.data) as Notification);
            } catch {
                // 解不出来的帧直接丢，不影响连接
            }
        };

        ws.onclose = (event) => {
            if (disposed) return;
            // 4001 = 登录失效，先刷 token，下一次重连才带得上
            if (event.code === 4001) {
                void refreshAccessToken().catch(() => undefined);
            }
            scheduleReconnect();
        };

        ws.onerror = () => {
            // onclose 会跟着触发，这里只负责兜底
        };
    }

    connect();

    return () => {
        disposed = true;
        if (retryTimer) clearTimeout(retryTimer);
        try {
            ws?.close();
        } catch {
            // 已关闭
        }
        ws = null;
    };
}
