/**
 * 实时协同 WebSocket 服务。
 *
 * ## 为什么不用 Nest 的 @WebSocketGateway
 *
 * Nest 的 WS 网关要求每条消息是 `{ event, data }` 的 JSON 信封，
 * 而 Yjs 的 y-websocket 协议发的是**裸二进制帧**（1 字节类型 + payload）。
 * 用网关就得让前端自带一层信封封装，白白放弃 `y-websocket` 那套现成 provider。
 *
 * 所以这里直接挂原生 `ws` 服务到 HTTP server 的 `upgrade` 事件上 ——
 * 和 HTTP 共用同一个 TCP 端口（清单里的「tcp」就是指这个），
 * 前端可以用标准的 `WebsocketProvider`，一行接入。
 *
 * ## 协议（与 y-websocket 完全兼容）
 *
 * 帧 = 1 字节 message type + payload
 *   0 = sync      同步文档状态（syncStep1/2/update 三种子消息）
 *   1 = awareness 在线状态（谁在看、光标在哪）
 *   2 = control   本服务自定义（归档完成通知等）
 *
 * ## 职责划分
 *
 *   YDocStore   —— 持久化（挂在 Y.Doc 的 update 事件上，与连接无关）
 *   CollabServer —— 连接管理 + 转发（只管谁在线、消息给谁）
 *
 * 服务端不做任何冲突变换：CRDT 的合并由客户端各自完成，
 * 服务端只是「收到 → 落库 → 转发给别人」。
 *
 * ## awareness 不落库
 *
 * 光标位置是瞬时状态，没有历史价值，而且每秒几十次更新。
 * 它只在在线连接之间流转，断线即失效。
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { YDocStore } from '../../infrastructure/yjs/ydoc-store';
import { DocumentService } from '../documents/document.service';
import { AuthService } from '../auth/auth.service';
import { AppConfigService } from '../../config/app-config.service';

/** 与 y-websocket 一致的消息类型 */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_CONTROL = 2;

/** 自定义控制消息 */
export const CONTROL_SNAPSHOT_SAVED = 'snapshot-saved';

interface ClientState {
    id: string;
    socket: WebSocket;
    documentId: string;
    userId: string;
    username: string;
    /** 该用户在这个文档里的角色，VIEWER 的写入会被丢弃 */
    role: 'OWNER' | 'EDITOR' | 'VIEWER';
    /**
     * 这个连接在 awareness 里用过的 clientID。
     * 断线时要按它们精确摘除 —— 用服务端 awareness 自己的 clientID 是错的，
     * 那会导致对方的"幽灵选区"一直留到 30 秒超时。
     */
    awarenessIds: Set<number>;
}

interface Room {
    documentId: string;
    doc: Y.Doc;
    awareness: awarenessProtocol.Awareness;
    clients: Set<ClientState>;
    /** 该文档 update 的广播器，整个房间只挂一个（挂 N 个会重复广播） */
    onUpdate: (update: Uint8Array, origin: unknown) => void;
    /** 空闲快照刷新计时器 */
    idleTimer?: NodeJS.Timeout;
}

@Injectable()
export class CollabServer implements OnModuleDestroy {
    private readonly logger = new Logger(CollabServer.name);
    private readonly rooms = new Map<string, Room>();
    private wss: WebSocketServer | null = null;
    private httpServer: HttpServer | null = null;

    constructor(
        private readonly ydocStore: YDocStore,
        private readonly documents: DocumentService,
        private readonly auth: AuthService,
        private readonly config: AppConfigService
    ) {}

    /**
     * 由 main.ts 调用，把 WS 服务挂到 Nest 的 HTTP server 上。
     * 不能在构造函数里做 —— 那时 HTTP server 还没起来。
     */
    attach(httpServer: HttpServer): void {
        this.httpServer = httpServer;
        this.wss = new WebSocketServer({ noServer: true });

        httpServer.on('upgrade', (request, socket, head) => {
            const url = new URL(request.url ?? '/', 'http://localhost');
            // 只接管 /collab/*，其它 upgrade 请求留给别的处理器
            if (!url.pathname.startsWith('/collab/')) return;

            this.wss?.handleUpgrade(request, socket, head, (ws) => {
                this.wss?.emit('connection', ws, request);
            });
        });

        this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
            void this.onConnection(ws, request).catch((err: unknown) => {
                this.logger.error(`WS 连接异常：${String(err)}`);
                this.close(ws, 4000, '内部错误');
            });
        });

        this.logger.log('协同服务已挂载：/collab/:documentId');
    }

    onModuleDestroy(): void {
        for (const room of this.rooms.values()) {
            this.teardownRoom(room);
        }
        this.rooms.clear();
        this.wss?.close();
    }

    // ─────────────────────────── 连接 ───────────────────────────

    private async onConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const documentId = url.pathname.replace(/^\/collab\//, '').split('/')[0];

        if (!documentId) {
            this.close(ws, 4000, '缺少文档 id');
            return;
        }

        // ── 鉴权 ──
        // WS 握手带不了 Authorization 头，token 走 query 或 cookie
        const token =
            url.searchParams.get('access_token') ??
            this.tokenFromCookie(request.headers['cookie']);

        if (!token) {
            this.close(ws, 4001, '缺少访问令牌');
            return;
        }

        let userId: string;
        let username: string;
        try {
            const user = await this.auth.verifyAccess(token);
            userId = user.id;
            username = user.username;
        } catch {
            this.close(ws, 4001, '登录已失效');
            return;
        }

        // ── 文档访问权（越权与不存在同语义，防探测） ──
        let role: 'OWNER' | 'EDITOR' | 'VIEWER';
        try {
            ({ role } = await this.documents.getAccessibleRow(userId, documentId));
        } catch {
            this.close(ws, 4004, '文档不存在');
            return;
        }

        const room = await this.getOrCreateRoom(documentId);
        const client: ClientState = {
            id: randomUUID(),
            socket: ws,
            documentId,
            userId,
            username,
            role,
            awarenessIds: new Set(),
        };
        room.clients.add(client);

        // 先推一份完整状态给新来的客户端
        this.sendSyncStep1(ws, room.doc);
        this.sendSyncStep2(ws, room.doc);
        this.sendAwareness(ws, room.awareness);

        ws.on('message', (data: Buffer) => {
            void this.onMessage(room, client, data).catch((err: unknown) => {
                this.logger.error(`消息处理失败：${String(err)}`);
            });
        });

        ws.on('close', () => this.onDisconnect(room, client));
        ws.on('error', (err: Error) => {
            this.logger.debug(`WS 错误 ${client.username}：${err.message}`);
        });

        this.logger.log(
            `接入协同 ${documentId} user=${username} 在线=${room.clients.size}`
        );
    }

    private onDisconnect(room: Room, client: ClientState): void {
        room.clients.delete(client);

        // 把这个人的 awareness 状态撤掉并广播，别人才会立刻看到他下线。
        // 只摘掉这个连接自己的 clientID；用 room.awareness.clientID 会删错对象，
        // 对方的选区会以"幽灵"形式一直留到 30 秒超时。
        const ids = [...client.awarenessIds];
        if (ids.length > 0) {
            awarenessProtocol.removeAwarenessStates(room.awareness, ids, 'disconnect');
            // 摘除本身也要广播：否则其他客户端要等自己的超时才清掉
            const removal = awarenessProtocol.encodeAwarenessUpdate(room.awareness, ids);
            this.broadcast(room, encodeFrame(MESSAGE_AWARENESS, removal));
        }

        this.logger.log(
            `断开协同 ${room.documentId} user=${client.username} 在线=${room.clients.size}`
        );

        if (room.clients.size === 0) {
            // 最后一个人走了：刷新一次快照元数据（不产生版本），然后拆房间释放内存
            if (room.idleTimer) clearTimeout(room.idleTimer);
            void this.documents
                .requestArchive(room.documentId, undefined, 'idle')
                .catch(() => undefined);
            this.teardownRoom(room);
            this.rooms.delete(room.documentId);
        }
    }

    // ─────────────────────────── 消息 ───────────────────────────

    private async onMessage(room: Room, client: ClientState, data: Buffer): Promise<void> {
        if (data.byteLength === 0) return;

        const messageType = data[0];
        const payload = new Uint8Array(data.subarray(1));

        switch (messageType) {
            case MESSAGE_SYNC:
                this.handleSync(room, client, payload);
                break;
            case MESSAGE_AWARENESS:
                this.handleAwareness(room, client, payload);
                break;
            case MESSAGE_CONTROL:
                this.logger.debug(
                    `控制消息 from ${client.username}：${new TextDecoder().decode(payload).slice(0, 200)}`
                );
                break;
            default:
                this.logger.debug(`未知消息类型 ${messageType}，忽略`);
        }

        // 有编辑活动，重置空闲归档计时
        this.scheduleIdleSnapshot(room);
    }

    /**
     * sync 协议：syncStep1 / syncStep2 / update 三种子消息。
     *
     * `readSyncMessage` 会把 update 应用到 doc 上，触发 doc 的 'update' 事件；
     * 那个事件里 YDocStore 负责落库，房间的 onUpdate 负责广播给别人。
     * 服务端不做任何变换 —— CRDT 的合并由客户端各自完成。
     */
    private handleSync(room: Room, client: ClientState, payload: Uint8Array): void {
        // 只读用户只能拉状态（syncStep1），不能提交 update。
        // 前端虽然用 readOnly 引擎拦了输入，但 WS 才是真正的边界。
        const subType = decoding.readVarUint(decoding.createDecoder(payload));
        if (client.role === 'VIEWER' && subType === syncProtocol.messageYjsUpdate) {
            this.logger.debug(`丢弃只读用户 ${client.username} 的 update`);
            return;
        }

        const decoder = decoding.createDecoder(payload);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);

        // 第四个参数是 transactionOrigin，会在 doc.on('update') 的 origin 里传出来，
        // 广播时据此排除「发出这条 update 的人」
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, client);

        // encoder 里有内容说明对方发的是 syncStep1，我们要回 syncStep2
        if (encoding.length(encoder) > 1) {
            this.send(client.socket, encoding.toUint8Array(encoder));
        }
    }

    private handleAwareness(room: Room, client: ClientState, payload: Uint8Array): void {
        // 记下这个连接用过的 awareness clientID，断线时按它精确摘除
        for (const id of readAwarenessClientIds(payload)) {
            client.awarenessIds.add(id);
        }
        awarenessProtocol.applyAwarenessUpdate(room.awareness, payload, client);
        // 原样转发给别人
        this.broadcast(room, encodeFrame(MESSAGE_AWARENESS, payload), client.socket);
    }

    // ─────────────────────────── 房间 ───────────────────────────

    private async getOrCreateRoom(documentId: string): Promise<Room> {
        const existing = this.rooms.get(documentId);
        if (existing) return existing;

        const { doc } = await this.ydocStore.load(documentId);

        const awareness = new awarenessProtocol.Awareness(doc);
        awareness.setLocalState(null);

        const room: Room = {
            documentId,
            doc,
            awareness,
            clients: new Set(),
            onUpdate: (update, origin) => {
                // 转发原始 sync update（包裹成 type=0 的 update 子消息），
                // 排除 origin —— 那是发起这次编辑的客户端，它本地已经应用过了
                const frame = encodeFrame(MESSAGE_SYNC, encodeSyncUpdate(update));
                this.broadcast(room, frame, origin instanceof Object ? (origin as ClientState).socket : undefined);
            },
        };

        // 整个房间只挂一个广播器，挂 N 个（每连接一个）会重复广播 N 倍
        doc.on('update', room.onUpdate);
        this.rooms.set(documentId, room);
        return room;
    }

    private teardownRoom(room: Room): void {
        room.doc.off('update', room.onUpdate);
        room.awareness.destroy();
        if (room.idleTimer) clearTimeout(room.idleTimer);
    }

    // ─────────────────────────── 快照刷新 ───────────────────────────

    /**
     * 空闲检测：文档连续 N 毫秒没有 update，就异步刷新一次快照元数据。
     *
     * **不产生版本** —— 版本只由用户显式「保存为版本」创建。
     * 刷新只为了让列表里的体积、统计、更新时间保持准确。
     */
    private scheduleIdleSnapshot(room: Room): void {
        if (room.idleTimer) clearTimeout(room.idleTimer);

        room.idleTimer = setTimeout(() => {
            void this.documents
                .requestArchive(room.documentId, undefined, 'idle')
                .catch((err: unknown) =>
                    this.logger.warn(`空闲快照刷新触发失败：${String(err)}`)
                );
        }, this.config.collab.idleSnapshotMs);
    }

    /** 归档完成后通知房间（前端可以提示「已保存为版本 N」） */
    notifySnapshotSaved(documentId: string, versionNo: number): void {
        const room = this.rooms.get(documentId);
        if (!room) return;
        const payload = new TextEncoder().encode(
            JSON.stringify({ type: CONTROL_SNAPSHOT_SAVED, data: { versionNo } })
        );
        this.broadcast(room, encodeFrame(MESSAGE_CONTROL, payload));
    }

    onlineCount(documentId?: string): number {
        if (documentId) return this.rooms.get(documentId)?.clients.size ?? 0;
        let total = 0;
        for (const room of this.rooms.values()) total += room.clients.size;
        return total;
    }

    // ─────────────────────────── 发送 ───────────────────────────

    private sendSyncStep1(ws: WebSocket, doc: Y.Doc): void {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoder, doc);
        this.send(ws, encoding.toUint8Array(encoder));
    }

    private sendSyncStep2(ws: WebSocket, doc: Y.Doc): void {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep2(encoder, doc);
        this.send(ws, encoding.toUint8Array(encoder));
    }

    private sendAwareness(ws: WebSocket, awareness: awarenessProtocol.Awareness): void {
        const update = awarenessProtocol.encodeAwarenessUpdate(
            awareness,
            Array.from(awareness.getStates().keys())
        );
        this.send(ws, encodeFrame(MESSAGE_AWARENESS, update));
    }

    private broadcast(room: Room, frame: Uint8Array, except?: WebSocket): void {
        for (const client of room.clients) {
            if (client.socket === except) continue;
            this.send(client.socket, frame);
        }
    }

    private send(ws: WebSocket, data: Uint8Array): void {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(Buffer.from(data), { binary: true }, (err) => {
            if (err) this.logger.debug(`WS 发送失败：${err.message}`);
        });
    }

    private close(ws: WebSocket, code: number, reason: string): void {
        try {
            ws.close(code, reason);
        } catch {
            // 已经关了就不用管
        }
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

// ─────────────────────────── 帧编解码 ───────────────────────────

function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(payload.byteLength + 1);
    out[0] = type;
    out.set(payload, 1);
    return out;
}

/** 把一条 update 包装成 sync 协议的 update 子消息（子类型 = messageYjsUpdate） */
function encodeSyncUpdate(update: Uint8Array): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, syncProtocol.messageYjsUpdate);
    encoding.writeVarUint8Array(encoder, update);
    return encoding.toUint8Array(encoder);
}

/**
 * 从 awareness update 里读出涉及的 clientID。
 *
 * 格式（y-protocols/awareness）：
 *   varUint 条目数，然后每条 [clientID, clock, state(JSON)]
 */
function readAwarenessClientIds(payload: Uint8Array): number[] {
    try {
        const decoder = decoding.createDecoder(payload);
        const len = decoding.readVarUint(decoder);
        const ids: number[] = [];
        for (let i = 0; i < len; i++) {
            ids.push(decoding.readVarUint(decoder));
            decoding.readVarUint(decoder); // clock
            decoding.readVarString(decoder); // state JSON
        }
        return ids;
    } catch {
        return [];
    }
}
