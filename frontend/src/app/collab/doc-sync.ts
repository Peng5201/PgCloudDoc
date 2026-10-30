/**
 * 协同同步 —— Y.Doc ↔ 引擎的双向桥 + WebSocket 传输。
 *
 * ## 协议
 *
 * 与 y-websocket 完全兼容（后端 `collab.server.ts` 同一套）：
 *   帧 = 1 字节消息类型 + payload
 *     0 = sync      （内含 syncStep1 / syncStep2 / update 三种子消息）
 *     1 = awareness （在线状态：用户、光标）
 *     2 = control   （服务端通知，如「已自动归档」）
 *
 * ## 双向桥
 *
 * 本地 → 远端：引擎的 `IEngineChangeHooks` 回调 → diff 出字段增删 → 写 Y.Doc
 *             → 自然产生 update → 发给服务端
 * 远端 → 本地：Y.Map observer → 写引擎矩阵（`applySilently` 抑制回声）
 *             → `engine.notifyExternalChange()` 刷新 UI
 *
 * 用 observer 而不是「整份重算」：一条 update 可能只改 3 个格子，
 * 全量 materialize 是 O(整个文档)，高频协同下会卡。
 *
 * ## 为什么不回声
 *
 * 收到远端 update → 写本地矩阵 → 若触发 onChange → 又写回 Y.Doc → 又广播。
 * 每条远端改动都会被自己复制一份，指数放大。
 * 所以两处都做了标记：远端写入走 `applySilently`，本地写入带 `LOCAL_ORIGIN`，
 * observer 看到本地 origin 直接跳过。
 */

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { getAccessToken, refreshAccessToken } from '../api/client';
import type { ICellData, ISelection, IWorkbookData, Worksheet } from '../spreadsheet/engine';
import type { SheetEngine } from '../spreadsheet/engine';
import type { ObjectArray } from '../spreadsheet/engine/model/object-matrix';
import {
    decodeCellKey,
    decodeIndexKey,
    encodeCellKey,
    encodeIndexKey,
    materialize,
    ROOT_META,
    ROOT_SHEETS,
} from './doc-shape';

/** 与 y-websocket / 后端一致的消息类型 */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_CONTROL = 2;

/** 本地写入的 transaction origin，observer 据此跳过，避免回声 */
const LOCAL_ORIGIN = Symbol('doc-sync:local');

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface Peer {
    clientId: number;
    userId: string;
    username: string;
    displayName: string;
    color: string;
    /** 当前选区（含活动格），渲染远端选区用 */
    selection?: {
        active: { row: number; column: number };
        ranges: Array<{ startRow: number; startColumn: number; endRow: number; endColumn: number }>;
    };
}

export interface SyncStatus {
    status: ConnectionStatus;
    /** 服务端推送的通知（已自动归档等） */
    notice?: { type: string; data: unknown } | null;
}

/** awareness 里广播的「我是谁」 */
interface AwarenessUser {
    id: string;
    username: string;
    displayName: string;
}

export interface DocSyncOptions {
    documentId: string;
    /** access token，WS 握手走 query */
    token: string;
    user: { id: string; username: string; displayName: string | null };
    /** 默认按当前页面地址推导，走 vite 的 /collab 代理 */
    url?: string;
    /** 结构性改动（增删 sheet）后回调，让上层重建引擎 */
    onStructureChange?: () => void;
}

export class DocSync {
    readonly doc = new Y.Doc();
    readonly awareness: awarenessProtocol.Awareness;

    private readonly options: DocSyncOptions;
    private ws: WebSocket | null = null;
    private disposed = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempts = 0;
    private engine: SheetEngine | null = null;

    /**
     * 本地 update → 发服务端。origin='remote' 的是远端 apply 进来的，
     * 不再发回去，否则 A→B→A 无限回声。
     */
    private readonly _onUpdate = (update: Uint8Array, origin: unknown): void => {
        if (origin === 'remote') return;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeUpdate(encoder, update);
        this.send(encoding.toUint8Array(encoder));
    };

    /**
     * 本地 awareness 变化（选区、光标、用户信息）→ 发服务端。
     *
     * 少了这一步，只有握手时那一次状态能到达别人；之后选区怎么变都发不出去。
     * origin='remote' 的是远端 apply 进来的，发回去会造成回环。
     */
    private readonly _onAwarenessUpdate = (
        changes: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown
    ): void => {
        if (origin === 'remote') return;
        const changed = [...changes.added, ...changes.updated, ...changes.removed];
        if (changed.length === 0) return;
        const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
        this.send(encodeFrame(MESSAGE_AWARENESS, update));
    };

    /** sheetId → 该表的三个 Y.Map */
    private readonly sheetMaps = new Map<
        string,
        {
            sheet: Y.Map<unknown>;
            cellData: Y.Map<unknown>;
            rowData: Y.Map<unknown>;
            columnData: Y.Map<unknown>;
        }
    >();

    private readonly statusListeners = new Set<(status: SyncStatus) => void>();
    private readonly peerListeners = new Set<(peers: Peer[]) => void>();
    private status: SyncStatus = { status: 'connecting', notice: null };
    private peerFlushTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(options: DocSyncOptions) {
        this.options = options;
        this.awareness = new awarenessProtocol.Awareness(this.doc);
        this.awareness.setLocalStateField('user', {
            id: options.user.id,
            username: options.user.username,
            displayName: options.user.displayName ?? options.user.username,
        });
        this.awareness.setLocalStateField('color', collabColor(options.user.id));

        this.awareness.on('change', () => this.emitPeers());
        this.awareness.on('update', this._onAwarenessUpdate);

        // sheets 数组变化 = 增删 sheet，属于结构性改动
        this.doc.getArray<Y.Map<unknown>>(ROOT_SHEETS).observe((event) => {
            if (event.transaction.origin === LOCAL_ORIGIN) return;
            this.indexSheets();
            this.options.onStructureChange?.();
        });

        this.indexSheets();
        this.doc.getMap(ROOT_META).observe((event) => {
            if (event.transaction.origin === LOCAL_ORIGIN) return;
            this.options.onStructureChange?.();
        });

        // 本地编辑 → 产生 update → 发给服务端，服务端再广播给其他协作者
        this.doc.on('update', this._onUpdate);
    }

    // ─────────────────────────── 连接 ───────────────────────────

    /**
     * 强制重连：丢掉当前连接（哪怕卡在 CONNECTING）再建一条。
     * 「重新加载」按钮用它 —— 普通 connect() 对 CONNECTING/OPEN 是幂等的，
     * 连接卡死时点重试会毫无反应。
     */
    reconnect(): void {
        if (this.disposed) return;
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const previous = this.ws;
        this.ws = null;
        if (previous) {
            // 先把回调摘掉，否则 close 会触发 onclose → 再排一次重连
            previous.onclose = null;
            previous.onerror = null;
            try {
                previous.close();
            } catch {
                // 已经关了就不用管
            }
        }
        this.connect();
    }

    connect(): void {
        if (this.disposed) return;
        // 幂等：已在连接中或已连上时不再重复建连。
        // React StrictMode 会双跑 effect，编排层也会重入，这里兜底防止开多条 WS。
        if (
            this.ws &&
            (this.ws.readyState === WebSocket.CONNECTING ||
                this.ws.readyState === WebSocket.OPEN)
        ) {
            return;
        }
        this.setStatus({ status: 'connecting' });

        const base =
            this.options.url ??
            `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
        // 每次（重）连都现取 token：access token 只有 15 分钟，
        // 拿建连时的旧 token 重连会被服务端 4001 拒掉
        const token = getAccessToken() ?? this.options.token;
        const url = `${base}/collab/${this.options.documentId}?access_token=${encodeURIComponent(
            token
        )}`;

        const ws = new WebSocket(url);
        // Yjs 的帧是二进制，必须按 ArrayBuffer 收，否则会被当 utf8 文本解坏
        ws.binaryType = 'arraybuffer';
        this.ws = ws;

        ws.onopen = () => {
            this.reconnectAttempts = 0;
            this.setStatus({ status: 'connected' });

            // 标准握手：先发 syncStep1 报上自己的状态向量，等对方回 syncStep2
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_SYNC);
            syncProtocol.writeSyncStep1(encoder, this.doc);
            this.send(encoding.toUint8Array(encoder));

            // 把本地 awareness 推上去，别人才能看到「谁在线」
            const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
                this.awareness,
                [this.awareness.clientID]
            );
            this.send(encodeFrame(MESSAGE_AWARENESS, awarenessUpdate));
        };

        ws.onmessage = (event) => {
            if (typeof event.data === 'string') return;
            this.onMessage(new Uint8Array(event.data as ArrayBuffer));
        };

        ws.onclose = (event) => {
            if (this.disposed) return;
            this.setStatus({ status: 'disconnected' });
            // 4001 = 服务端认为登录失效（多半是 access token 过期）。
            // 先刷一次 token，下一次重连才能带上新的，否则会拿旧 token 空转
            if (event.code === 4001) {
                void refreshAccessToken().catch(() => undefined);
            }
            this.scheduleReconnect();
        };

        ws.onerror = () => {
            // onclose 会跟着触发，这里只记日志
            console.warn('[collab] WebSocket 错误');
        };
    }

    private scheduleReconnect(): void {
        if (this.disposed || this.reconnectTimer) return;
        // 指数退避，最多 10s 一次 —— 后端重启时别把服务端锤爆
        const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 10_000);
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    private onMessage(data: Uint8Array): void {
        if (data.byteLength === 0) return;
        const type = data[0];
        const payload = data.subarray(1);

        switch (type) {
            case MESSAGE_SYNC:
                this.handleSync(payload);
                break;
            case MESSAGE_AWARENESS:
                awarenessProtocol.applyAwarenessUpdate(this.awareness, payload, 'remote');
                break;
            case MESSAGE_CONTROL:
                this.handleControl(payload);
                break;
            default:
                break;
        }
    }

    private handleSync(payload: Uint8Array): void {
        const decoder = decoding.createDecoder(payload);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);

        // 第四个参数是 transactionOrigin：update 应用进 doc 时带的标记。
        // 用 'remote' 作为 origin，observer 就知道这不是自己写的
        syncProtocol.readSyncMessage(decoder, encoder, this.doc, 'remote');

        // encoder 有内容说明对端发的是 syncStep1，我们要回 syncStep2
        if (encoding.length(encoder) > 1) {
            this.send(encoding.toUint8Array(encoder));
        }
    }

    private handleControl(payload: Uint8Array): void {
        try {
            const message = JSON.parse(new TextDecoder().decode(payload)) as {
                type: string;
                data: unknown;
            };
            this.setStatus({ ...this.status, notice: message });
        } catch {
            // 控制消息解不出来不影响协同
        }
    }

    private send(bytes: Uint8Array): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            // 编码结果底层一定是 ArrayBuffer（lib0 / encodeFrame 都是 new Uint8Array），
            // 这里收窄类型以匹配 DOM 的 send 签名
            this.ws.send(bytes as Uint8Array<ArrayBuffer>);
        }
    }

    // ─────────────────────────── 索引 ───────────────────────────

    /** 把 sheets 数组里的每张表的三个 Y.Map 建立索引 + 挂 observer */
    private indexSheets(): void {
        const sheets = this.doc.getArray<Y.Map<unknown>>(ROOT_SHEETS);
        for (const sheet of sheets.toArray()) {
            const sheetId = sheet.get('id');
            if (typeof sheetId !== 'string' || this.sheetMaps.has(sheetId)) continue;

            const cellData = sheet.get('cellData') as Y.Map<unknown> | undefined;
            const rowData = sheet.get('rowData') as Y.Map<unknown> | undefined;
            const columnData = sheet.get('columnData') as Y.Map<unknown> | undefined;
            if (!cellData || !rowData || !columnData) continue;

            this.sheetMaps.set(sheetId, { sheet, cellData, rowData, columnData });

            cellData.observe((event) => this.onRemoteCellChange(sheetId, event));
            rowData.observe((event) => this.onRemoteIndexChange(sheetId, event, 'row'));
            columnData.observe((event) => this.onRemoteIndexChange(sheetId, event, 'column'));
        }
    }

    private cellMapFor(sheetId: string): Y.Map<unknown> | null {
        return this.sheetMaps.get(sheetId)?.cellData ?? null;
    }

    private rowMapFor(sheetId: string): Y.Map<unknown> | null {
        return this.sheetMaps.get(sheetId)?.rowData ?? null;
    }

    private columnMapFor(sheetId: string): Y.Map<unknown> | null {
        return this.sheetMaps.get(sheetId)?.columnData ?? null;
    }

    // ─────────────────────────── 远端 → 本地 ───────────────────────────

    private onRemoteCellChange(
        sheetId: string,
        event: Y.YMapEvent<unknown>
    ): void {
        // 自己写的直接跳过（否则会把刚发出去的改动再应用一遍）
        if (event.transaction.origin === LOCAL_ORIGIN) return;
        const engine = this.engine;
        if (!engine) return;

        const worksheet = this.worksheetOf(engine, sheetId);
        if (!worksheet) return;

        let touched = false;
        worksheet.cellData.applySilently(() => {
            for (const [key, change] of event.changes.keys) {
                const [row, column, field] = decodeCellKey(key);
                const existing = worksheet.cellData.getValue(row, column);
                const next: Record<string, unknown> = { ...(existing ?? {}) };

                if (change.action === 'delete') {
                    delete next[field];
                } else {
                    next[field] = event.target.get(key);
                }

                if (Object.keys(next).length === 0) {
                    worksheet.cellData.realDeleteValue(row, column);
                } else {
                    worksheet.cellData.setValue(row, column, next as ICellData);
                }
                touched = true;
            }
        });

        if (touched) engine.notifyExternalChange();
    }

    private onRemoteIndexChange(
        sheetId: string,
        event: Y.YMapEvent<unknown>,
        kind: 'row' | 'column'
    ): void {
        if (event.transaction.origin === LOCAL_ORIGIN) return;
        const engine = this.engine;
        if (!engine) return;

        const worksheet = this.worksheetOf(engine, sheetId);
        if (!worksheet) return;

        // rowData / columnData 是两个不同的 ObjectArray 泛型，
        // 在这个函数里字段形状是一样的，统一按 Record 处理，避免联合类型的 set() 报错
        const target = (
            kind === 'row' ? worksheet.rowData : worksheet.columnData
        ) as unknown as ObjectArray<Record<string, unknown>>;

        let touched = false;
        target.applySilently(() => {
            for (const [key, change] of event.changes.keys) {
                const [index, field] = decodeIndexKey(key);
                const next: Record<string, unknown> = { ...(target.get(index) ?? {}) };

                if (change.action === 'delete') {
                    delete next[field];
                } else {
                    next[field] = event.target.get(key);
                }

                if (Object.keys(next).length === 0) {
                    target.delete(index);
                } else {
                    target.set(index, next);
                }
                touched = true;
            }
        });

        if (touched) engine.notifyExternalChange();
    }

    private worksheetOf(engine: SheetEngine, sheetId: string): Worksheet | undefined {
        return engine.workbook.getSheet(sheetId);
    }

    // ─────────────────────────── 本地 → 远端 ───────────────────────────

    /** 把引擎接上来。之后所有本地数据变更都会同步出去 */
    attach(engine: SheetEngine): void {
        this.engine = engine;
        engine.attachChangeHooks({
            onCellChange: (sheetId, row, column, next, before) => {
                this.pushCell(sheetId, row, column, next, before);
            },
            onRowChange: (sheetId, index, next, before) => {
                this.pushIndex(this.rowMapFor(sheetId), index, next, before);
            },
            onColumnChange: (sheetId, index, next, before) => {
                this.pushIndex(this.columnMapFor(sheetId), index, next, before);
            },
        });
    }

    detach(): void {
        this.engine?.attachChangeHooks(null);
        this.engine = null;
    }

    /**
     * 写一个格子。
     *
     * `before` 有而 `next` 没有的字段要**删掉** —— 只写不删的话，
     * 清空一个格子的值会把旧值永远留在 Y.Doc 里。
     */
    private pushCell(
        sheetId: string,
        row: number,
        column: number,
        next: ICellData | undefined,
        before: ICellData | undefined
    ): void {
        const map = this.cellMapFor(sheetId);
        if (!map) return;

        const fields = new Set([
            ...Object.keys(before ?? {}),
            ...Object.keys(next ?? {}),
        ]);
        if (fields.size === 0) return;

        this.doc.transact(() => {
            for (const field of fields) {
                const key = encodeCellKey(row, column, field);
                const value = (next as Record<string, unknown> | undefined)?.[field];
                if (value === undefined || value === null) {
                    map.delete(key);
                } else {
                    map.set(key, cloneJson(value));
                }
            }
        }, LOCAL_ORIGIN);
    }

    /** rowData / columnData 的字段形状是 IRowData / IColumnData，这里统一按对象处理 */
    private pushIndex(
        map: Y.Map<unknown> | null,
        index: number,
        next: object | undefined,
        before: object | undefined
    ): void {
        if (!map) return;

        const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(next ?? {})]);
        if (fields.size === 0) return;

        const source = next as Record<string, unknown> | undefined;
        this.doc.transact(() => {
            for (const field of fields) {
                const key = encodeIndexKey(index, field);
                const value = source?.[field];
                if (value === undefined || value === null) {
                    map.delete(key);
                } else {
                    map.set(key, cloneJson(value));
                }
            }
        }, LOCAL_ORIGIN);
    }

    // ─────────────────────────── 对外 ───────────────────────────

    /** 从 Y.Doc 物化出引擎能吃的快照 */
    materialize(): IWorkbookData {
        return materialize(this.doc, this.options.documentId);
    }

    /** 文档名（也同步给协作者） */
    setName(name: string): void {
        this.doc.transact(() => {
            this.doc.getMap(ROOT_META).set('name', name);
        }, LOCAL_ORIGIN);
    }

    getName(): string {
        const name = this.doc.getMap(ROOT_META).get('name');
        return typeof name === 'string' ? name : '';
    }

    /** 把当前选区（含活动格）推给协作者，别人才能看到我在选哪片区域 */
    setLocalSelection(selection: ISelection): void {
        this.awareness.setLocalStateField('selection', {
            active: selection.active,
            // 只传必要的四个角，别把内部结构原样广播
            ranges: selection.ranges.map((r) => ({
                startRow: r.startRow,
                startColumn: r.startColumn,
                endRow: r.endRow,
                endColumn: r.endColumn,
            })),
        });
    }

    getPeers(): Peer[] {
        const me = this.awareness.clientID;
        const myUserId = this.options.user.id;
        /** 同一个用户可能有多条 awareness（多标签页/旧连接没清干净），只保留一条 */
        const seen = new Set<string>();
        const out: Peer[] = [];
        for (const [clientId, state] of this.awareness.getStates()) {
            // 排除自己这个连接
            if (clientId === me) continue;
            const raw = state as {
                user?: Partial<AwarenessUser>;
                color?: string;
                selection?: Peer['selection'];
            };
            const user = raw.user;
            if (!user?.id) continue;
            // 同一账号的另一个标签页也算"自己"：否则会在自己选中的地方
            // 再画一层同色选区，看起来像重复绘制
            if (user.id === myUserId) continue;
            if (seen.has(user.id)) continue;
            seen.add(user.id);
            out.push({
                clientId,
                userId: user.id,
                username: user.username ?? '',
                displayName: user.displayName ?? user.username ?? '匿名',
                color: raw.color ?? '#3370ff',
                selection: normalizeSelection(raw.selection),
            });
        }
        return out;
    }

    onStatus(listener: (status: SyncStatus) => void): () => void {
        this.statusListeners.add(listener);
        listener(this.status);
        return () => this.statusListeners.delete(listener);
    }

    onPeers(listener: (peers: Peer[]) => void): () => void {
        this.peerListeners.add(listener);
        listener(this.getPeers());
        return () => this.peerListeners.delete(listener);
    }

    private setStatus(next: SyncStatus): void {
        this.status = next;
        for (const listener of this.statusListeners) listener(next);
    }

    /**
     * peers 变化通知。选区拖拽时 awareness 一秒能变几十次，
     * 每次都会触发 React 重渲染 + 一次重绘，所以按帧合并（~50ms 一次）。
     */
    private emitPeers(): void {
        if (this.peerFlushTimer !== null) return;
        this.peerFlushTimer = setTimeout(() => {
            this.peerFlushTimer = null;
            if (this.disposed) return;
            const peers = this.getPeers();
            for (const listener of this.peerListeners) listener(peers);
        }, PEER_FLUSH_MS);
    }

    destroy(): void {
        this.disposed = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.peerFlushTimer !== null) {
            clearTimeout(this.peerFlushTimer);
            this.peerFlushTimer = null;
        }
        this.detach();

        // 标记自己下线，别人才会把头像和选区摘掉。
        // 先摘状态再解监听：这条"我下线了"的 awareness 也要发出去
        awarenessProtocol.removeAwarenessStates(
            this.awareness,
            [this.awareness.clientID],
            'unmount'
        );
        this.awareness.off('update', this._onAwarenessUpdate);
        this.awareness.destroy();

        try {
            this.ws?.close();
        } catch {
            // 已经关了就不用管
        }
        this.ws = null;
        this.doc.off('update', this._onUpdate);
        this.doc.destroy();
        this.statusListeners.clear();
        this.peerListeners.clear();
    }
}

// ─────────────────────────── 工具 ───────────────────────────

/** peers 通知的合并窗口：拖选时 awareness 一秒变几十次，没必要每次都重渲染 */
const PEER_FLUSH_MS = 50;

function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(payload.byteLength + 1);
    out[0] = type;
    out.set(payload, 1);
    return out;
}

/** JSON 往返深拷贝。不能用 structuredClone：Yjs 按 constructor 分发，跨 realm 会抛 */
function cloneJson<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value)) as T;
}

/** 远端选区的归一化：形状不对就当没有，别让一个坏包画花整块画布 */
function normalizeSelection(raw: Peer['selection'] | undefined): Peer['selection'] {
    if (!raw || !Array.isArray(raw.ranges)) return undefined;

    const ranges = raw.ranges.filter(
        (r) =>
            r &&
            Number.isFinite(r.startRow) &&
            Number.isFinite(r.startColumn) &&
            Number.isFinite(r.endRow) &&
            Number.isFinite(r.endColumn)
    );
    if (ranges.length === 0) return undefined;

    const active =
        raw.active &&
        Number.isFinite(raw.active.row) &&
        Number.isFinite(raw.active.column)
            ? raw.active
            : { row: ranges[0]!.startRow, column: ranges[0]!.startColumn };

    return { active, ranges };
}

/**
 * 按 userId 稳定分配一个协作者颜色。
 *
 * 选区底色、顶栏头像、成员列表共用同一个颜色，所以调色板要「亮但不刺眼」：
 * 底色以 12% 透明度铺在单元格上，描边 55%，太艳会挡住单元格内容。
 */
export function collabColor(id: string): string {
    const palette = [
        '#5B8FF9', // 柔蓝
        '#5AD8A6', // 薄荷绿
        '#F6BD16', // 暖黄
        '#F6903D', // 杏橙
        '#7262FD', // 紫罗兰
        '#78D3F8', // 天蓝
        '#9661BC', // 紫
        '#F08BB4', // 粉
    ];
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    return palette[Math.abs(hash) % palette.length];
}
