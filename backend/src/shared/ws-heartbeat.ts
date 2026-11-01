/**
 * WebSocket 心跳（服务端主动 ping）。
 *
 * 为什么必须由服务端发：
 *   - JS 的 WebSocket API 不能主动发 ping 帧，浏览器只在收到 ping 时自动回 pong；
 *   - nginx 的 proxy_read_timeout 等的是「上游有没有数据」，客户端发来的帧不算。
 *     当前部署里 /collab/ 和 /notifications 都是 3600s，没有心跳的话，
 *     文档挂着不动一小时就会被 nginx 掐断。
 *
 * 顺带解决半开连接：上一轮 ping 没等到 pong 就 terminate。否则 NAT 超时、
 * 拔网线这类没有 FIN 的断线，服务端会一直以为这个客户端还在线。
 */

import type { WebSocket } from 'ws';

/** 25s：远小于 nginx 的 3600s，也小于常见云 NAT 的 60s 空闲回收 */
export const WS_HEARTBEAT_MS = 25_000;

/**
 * 给一条连接开心跳。返回停止函数；连接 close 时会自动停，
 * 调用方不需要额外清理。
 */
export function startWsHeartbeat(ws: WebSocket, intervalMs = WS_HEARTBEAT_MS): () => void {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const onPong = (): void => {
        alive = true;
    };

    const stop = (): void => {
        if (timer) clearInterval(timer);
        timer = null;
        ws.off('pong', onPong);
    };

    ws.on('pong', onPong);

    timer = setInterval(() => {
        if (ws.readyState !== ws.OPEN) {
            stop();
            return;
        }
        // 上一轮到这一轮之间没收到 pong：连接实际上已经死了
        if (!alive) {
            ws.terminate();
            stop();
            return;
        }
        alive = false;
        try {
            ws.ping();
        } catch {
            ws.terminate();
            stop();
        }
    }, intervalMs);

    ws.once('close', stop);

    return stop;
}
