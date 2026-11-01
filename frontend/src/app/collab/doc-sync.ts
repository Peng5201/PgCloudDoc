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
 *
 * ## 后台休眠
 *
 * 页面切到后台超过 10s 就主动关闭 WebSocket，回到前台立即重连。
 * 这里**只动传输层**：Y.Doc、引擎和已经渲染的快照都不变，所以页面上
 * 只有顶栏的连接状态图标会变（断开 → 连接中 → 已连接）。
 *
 * 断开的这段时间如果本地还有没发出去的 update，它们留在 Y.Doc 里；
 * 重连后的 syncStep1/2 握手会把两边缺的部分补齐，不会丢改动。
 */

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { getAccessToken, refreshAccessToken } from '../api/client';
import type { ICellData, ISelection, IStyleData, IWorkbookData, Worksheet } from '../spreadsheet/engine';
import type { SheetEngine } from '../spreadsheet/engine';
import type { ObjectArray } from '../spreadsheet/engine/model/object-matrix';
import {
    CELL_FIELDS,
    COLUMN_FIELDS,
    ROW_FIELDS,
    decodeCellKey,
    decodeIndexKey,
    encodeCellKey,
    encodeIndexKey,
    materialize,
    ROOT_META,
    ROOT_SHEETS,
    ROOT_STYLES,
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
    /**
     * 页面转到后台多久后主动断开 WebSocket（毫秒），回到前台立即重连。
     * 默认 10s；传 0 关闭该行为。
     */
    suspendWhenHiddenMs?: number;
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

    private readonly suspendWhenHiddenMs: number;
    /** 切后台的休眠计时器 */
    private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
    /** 是否正因切后台而主动断开了连接（此时不排退避重连） */
    private suspendedByVisibility = false;

    /** 页面可见性变化：后台计时、回前台立即重连 */
    private readonly _onVisibilityChange = (): void => {
        if (this.disposed) return;
        if (isDocumentHidden()) this.scheduleHiddenSuspend();
        else this.resumeFromHidden();
    };

    /**
     * 用户回到页面的兜底信号。
     *
     * 窗口被别的应用盖住再恢复、或页面被浏览器冻结后唤醒时，visibilitychange
     * 可能延迟到有用户输入才派发 —— 表现就是"鼠标动一下才重连"。
     * 能产生交互说明人已经看到页面了，直接按「回到前台」处理。
     */
    private readonly _onWake = (): void => {
        if (this.disposed || !this.suspendedByVisibility) return;
        this.resumeFromHidden();
    };

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
        this.suspendWhenHiddenMs = options.suspendWhenHiddenMs ?? HIDDEN_SUSPEND_MS;
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

        // 共享样式表变化：远端新增的样式要补进本地 workbook。
        // 少了这一步，单元格的 s 指向一个本地不存在的 id，样式就丢了。
        this.doc.getMap<unknown>(ROOT_STYLES).observe((event) => {
            if (event.transaction.origin === LOCAL_ORIGIN) return;
            this.applyRemoteStyles(event);
        });

        // 本地编辑 → 产生 update → 发给服务端，服务端再广播给其他协作者
        this.doc.on('update', this._onUpdate);

        // 切后台超过阈值就断 WS：省服务端连接/心跳，也避免后台标签页一直占着协同房间。
        // Y.Doc / 引擎 / 快照都不动，回前台只是重新握手。
        if (this.suspendWhenHiddenMs > 0 && typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this._onVisibilityChange);
            // 在后台标签页里打开时不会再触发一次 visibilitychange，启动即判断
            if (isDocumentHidden()) this.scheduleHiddenSuspend();
        }
        if (this.suspendWhenHiddenMs > 0 && typeof window !== 'undefined') {
            // 交互兜底：visibilitychange 迟到时也能立刻恢复连接。
            // pointermove 频率高，handler 只做一次布尔判断，标记 passive 不阻塞滚动
            window.addEventListener('pointermove', this._onWake, { passive: true });
            window.addEventListener('pointerdown', this._onWake, { passive: true });
            window.addEventListener('keydown', this._onWake);
            window.addEventListener('focus', this._onWake);
            window.addEventListener('pageshow', this._onWake);
        }
    }

    // ─────────────────────────── 连接 ───────────────────────────

    /**
     * 强制重连：丢掉当前连接（哪怕卡在 CONNECTING）再建一条。
     * 「重新加载」按钮用它 —— 普通 connect() 对 CONNECTING/OPEN 是幂等的，
     * 连接卡死时点重试会毫无反应。
     */
    reconnect(): void {
        if (this.disposed) return;
        // 强制重连是「明确要连」：后台休眠状态和它的计时器都作废
        this.suspendedByVisibility = false;
        this.clearHiddenTimer();
        this.reconnectAttempts = 0;
        this.clearReconnectTimer();
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

        // 在后台标签页里建连（比如节流后的强制重连）也要照常计时
        if (this.suspendWhenHiddenMs > 0 && isDocumentHidden()) this.scheduleHiddenSuspend();
    }

    private scheduleReconnect(): void {
        // 后台休眠中不重连 —— 回到前台由 resumeFromHidden 立即建连
        if (this.disposed || this.reconnectTimer || this.suspendedByVisibility) return;
        // 指数退避，最多 10s 一次 —— 后端重启时别把服务端锤爆
        const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 10_000);
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    // ─────────────────────── 后台休眠 ───────────────────────

    private scheduleHiddenSuspend(): void {
        if (this.disposed || this.suspendedByVisibility || this.hiddenTimer) return;
        this.hiddenTimer = setTimeout(() => {
            this.hiddenTimer = null;
            // 后台定时器会被浏览器节流，醒来时再确认一次：已经回到前台就不断
            if (this.disposed || !isDocumentHidden()) return;
            this.suspendForHidden();
        }, this.suspendWhenHiddenMs);
    }

    /**
     * 主动断掉 WebSocket —— 只动传输层。
     *
     * Y.Doc、引擎和已经交给 React 的快照都不碰，所以页面上只有顶栏的
     * 连接状态图标会变成"已断开"，没有任何数据或布局变化。
     *
     * 断线期间本地产生的 update 留在 Y.Doc 里；回到前台后 syncStep1/2
     * 握手会把两边缺的补齐，不会丢改动。
     */
    private suspendForHidden(): void {
        if (this.disposed || this.suspendedByVisibility) return;
        this.suspendedByVisibility = true;
        this.clearReconnectTimer();

        const ws = this.ws;
        this.ws = null;
        if (ws) {
            // 摘掉回调：这是主动断开，不能走「断线 → 指数退避重连」那条路
            ws.onopen = null;
            ws.onmessage = null;
            ws.onerror = null;
            ws.onclose = null;
            try {
                ws.close(1000, 'page-hidden');
            } catch {
                // 已经关了就不用管
            }
        }
        this.setStatus({ status: 'disconnected' });
    }

    /** 回到前台：不等退避，立即重连 */
    private resumeFromHidden(): void {
        if (this.disposed) return;
        this.clearHiddenTimer();
        if (!this.suspendedByVisibility) return;

        this.suspendedByVisibility = false;
        this.reconnectAttempts = 0;
        this.connect();
    }

    private clearHiddenTimer(): void {
        if (!this.hiddenTimer) return;
        clearTimeout(this.hiddenTimer);
        this.hiddenTimer = null;
    }

    private clearReconnectTimer(): void {
        if (!this.reconnectTimer) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
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
        const alive = new Set<string>();

        for (const sheet of sheets.toArray()) {
            const sheetId = sheet.get('id');
            if (typeof sheetId !== 'string') continue;
            alive.add(sheetId);
            if (this.sheetMaps.has(sheetId)) continue;

            const cellData = sheet.get('cellData') as Y.Map<unknown> | undefined;
            const rowData = sheet.get('rowData') as Y.Map<unknown> | undefined;
            const columnData = sheet.get('columnData') as Y.Map<unknown> | undefined;
            if (!cellData || !rowData || !columnData) continue;

            this.sheetMaps.set(sheetId, { sheet, cellData, rowData, columnData });

            // 表级元信息（名字等）是 sheet Y.Map 上的标量键，不会触发 sheets 数组的
            // observer —— 数组 observer 只管增删表，必须在这里单独观察。
            sheet.observe((event) => this.onRemoteSheetChange(sheetId, event));

            cellData.observe((event) => this.onRemoteCellChange(sheetId, event));
            rowData.observe((event) => this.onRemoteIndexChange(sheetId, event, 'row'));
            columnData.observe((event) => this.onRemoteIndexChange(sheetId, event, 'column'));
        }

        // 远端删表后清掉索引，避免残留（新表若复用同 id 会被 has() 挡住）
        for (const sheetId of [...this.sheetMaps.keys()]) {
            if (!alive.has(sheetId)) this.sheetMaps.delete(sheetId);
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

    /**
     * 远端共享样式变化 → 补进本地 workbook。
     *
     * 样式只增不删：删掉一个仍被 cell.s 引用的样式会让格子直接失色，
     * 所以删除动作在这里直接忽略。
     */
    private applyRemoteStyles(event: Y.YMapEvent<unknown>): void {
        const engine = this.engine;
        if (!engine) return;

        let touched = false;
        for (const [id, change] of event.changes.keys) {
            if (change.action === 'delete') continue;
            const style = event.target.get(id);
            if (style && typeof style === 'object') {
                engine.workbook.addStyle(id, style as IStyleData);
                touched = true;
            }
        }
        if (touched) engine.notifyExternalChange();
    }

    /**
     * 远端改了表级元信息（名字 / tabColor / hidden）。
     *
     * 这类改动落在 sheet Y.Map 的**标量键**上，不会触发 sheets 数组的 observer，
     * 所以必须单独观察每张表。数组 observer 只负责增删表。
     */
    private onRemoteSheetChange(sheetId: string, event: Y.YMapEvent<unknown>): void {
        if (event.transaction.origin === LOCAL_ORIGIN) return;
        const engine = this.engine;
        if (!engine) return;
        const worksheet = engine.workbook.getSheet(sheetId);
        if (!worksheet) return;

        let changed = false;
        for (const key of event.changes.keys.keys()) {
            const value = event.target.get(key);
            if (key === 'name') {
                if (typeof value === 'string') {
                    worksheet.name = value;
                    changed = true;
                }
            } else if (key === 'tabColor') {
                if (typeof value === 'string') {
                    worksheet.tabColor = value;
                    changed = true;
                }
            } else if (key === 'hidden') {
                worksheet.hidden = value === 1 ? 1 : 0;
                changed = true;
            }
        }

        if (changed) engine.notifySheetMetaChange();
    }

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
            onSheetAdd: (sheet, index) => {
                this.pushSheetAdd(sheet, index);
            },
            onSheetRemove: (sheetId) => {
                this.pushSheetRemove(sheetId);
            },
            onSheetRename: (sheetId, name) => {
                this.pushSheetRename(sheetId, name);
            },
        });

        // 本地新样式 → 写进共享样式表。没有这一步，工具栏改样式只同步了
        // cell.s（id），别人手里没有对应样式，看起来就是「操作没同步」。
        engine.workbook.onStyleRegister = (id, style) => this.pushStyle(id, style);

        // 防御性补齐：样式可能在引擎就绪前就到达（engine 为 null 时 observer 会跳过）
        for (const [id, style] of this.doc.getMap<unknown>(ROOT_STYLES).entries()) {
            if (style && typeof style === 'object') {
                engine.workbook.addStyle(id, style as IStyleData);
            }
        }

        // 同理补齐表名（重命名可能发生在引擎构建与 attach 之间）
        for (const [sheetId, maps] of this.sheetMaps) {
            const name = maps.sheet.get('name');
            const worksheet = engine.workbook.getSheet(sheetId);
            if (worksheet && typeof name === 'string') worksheet.name = name;
        }
    }

    detach(): void {
        if (this.engine) this.engine.workbook.onStyleRegister = null;
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

    /**
     * 新样式 → Y.Doc 的共享样式表。
     *
     * id 是内容寻址的（`sh<hash>`），两端对同一份样式算出的 id 一致，
     * 所以「先到先写」没有冲突；已经存在就不重复写。
     */
    private pushStyle(id: string, style: IStyleData): void {
        const styles = this.doc.getMap<unknown>(ROOT_STYLES);
        if (styles.get(id) !== undefined) return;
        this.doc.transact(() => {
            styles.set(id, cloneJson(style));
        }, LOCAL_ORIGIN);
    }

    // ─────────────────────────── 结构性改动（增删 / 重命名 sheet）───────────────────────────

    /**
     * 本地新建 sheet → 在 Y.Doc 的 sheets 数组里插入同样的结构。
     *
     * `index` 来自引擎（本地已加好），并发下 Y.Array 可能已变过，这里夹紧到合法范围。
     * LOCAL_ORIGIN 不会触发数组 observer，所以要手动 `indexSheets()`，
     * 让新表的 cell/row/column 增量也能同步。
     */
    private pushSheetAdd(sheet: Worksheet, index: number): void {
        const sheets = this.doc.getArray<Y.Map<unknown>>(ROOT_SHEETS);
        const map = buildSheetYMap(sheet);
        this.doc.transact(() => {
            const at = Math.min(Math.max(index, 0), sheets.length);
            sheets.insert(at, [map]);
        }, LOCAL_ORIGIN);
        this.indexSheets();
    }

    /** 本地删除 sheet → 从 Y.Doc 的 sheets 数组删掉 */
    private pushSheetRemove(sheetId: string): void {
        const sheets = this.doc.getArray<Y.Map<unknown>>(ROOT_SHEETS);
        const at = findSheetIndex(sheets, sheetId);
        if (at < 0) return;

        // 先摘索引：这张表不再需要增量观察
        this.sheetMaps.delete(sheetId);
        this.doc.transact(() => {
            sheets.delete(at, 1);
        }, LOCAL_ORIGIN);
    }

    /** 本地重命名 sheet → 改 Y.Doc 里对应表的名字 */
    private pushSheetRename(sheetId: string, name: string): void {
        const sheets = this.doc.getArray<Y.Map<unknown>>(ROOT_SHEETS);
        const at = findSheetIndex(sheets, sheetId);
        if (at < 0) return;
        const sheet = sheets.get(at);
        if (!sheet) return;
        this.doc.transact(() => {
            sheet.set('name', name);
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
        this.suspendedByVisibility = false;
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
        }
        if (typeof window !== 'undefined') {
            window.removeEventListener('pointermove', this._onWake);
            window.removeEventListener('pointerdown', this._onWake);
            window.removeEventListener('keydown', this._onWake);
            window.removeEventListener('focus', this._onWake);
            window.removeEventListener('pageshow', this._onWake);
        }
        this.clearHiddenTimer();
        this.clearReconnectTimer();
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

/** 页面切到后台多久后主动断开协同连接（毫秒） */
const HIDDEN_SUSPEND_MS = 10_000;

/**
 * 页面是否在后台。
 *
 * 用 document.visibilityState 而不是 window 的 blur：blur 在「点了别的窗口
 * 但本页还完整可见」时也会触发，那样会把正常查看的用户误断。
 * 没有 document 的环境（SSR / 单元测试）一律按前台处理。
 */
function isDocumentHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

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

// ─────────────────────────── 工作表结构 ───────────────────────────

/** 在 sheets 数组里按 id 找下标 */
function findSheetIndex(sheets: Y.Array<Y.Map<unknown>>, sheetId: string): number {
    const list = sheets.toArray();
    for (let i = 0; i < list.length; i += 1) {
        if (list[i].get('id') === sheetId) return i;
    }
    return -1;
}

/**
 * 引擎的 Worksheet → doc-shape 约定的 Y.Map 结构。
 *
 * 新建表一般是空的，但这里按完整结构生成，将来「复制表」可以直接复用。
 * 必须在挂进 doc 之前把内容写完（未归属 doc 的 Y.Map 读自己的内容是 undefined）。
 */
function buildSheetYMap(sheet: Worksheet): Y.Map<unknown> {
    const map = new Y.Map<unknown>();
    map.set('id', sheet.id);
    map.set('name', sheet.name);
    map.set('tabColor', sheet.tabColor);
    map.set('hidden', sheet.hidden);
    map.set('rowCount', sheet.rowCount);
    map.set('columnCount', sheet.columnCount);
    map.set('zoomRatio', sheet.zoomRatio);
    map.set('scrollTop', sheet.scrollTop);
    map.set('scrollLeft', sheet.scrollLeft);
    map.set('defaultRowHeight', sheet.defaultRowHeight);
    map.set('defaultColumnWidth', sheet.defaultColumnWidth);
    map.set('showGridlines', sheet.showGridlines);
    map.set('gridlinesColor', sheet.gridlinesColor);

    const freeze = new Y.Map<unknown>();
    freeze.set('xSplit', sheet.freeze.xSplit);
    freeze.set('ySplit', sheet.freeze.ySplit);
    freeze.set('startRow', sheet.freeze.startRow);
    freeze.set('startColumn', sheet.freeze.startColumn);
    map.set('freeze', freeze);

    const rowHeader = new Y.Map<unknown>();
    rowHeader.set('width', sheet.rowHeaderWidth);
    rowHeader.set('hidden', 0);
    map.set('rowHeader', rowHeader);

    const columnHeader = new Y.Map<unknown>();
    columnHeader.set('height', sheet.columnHeaderHeight);
    columnHeader.set('hidden', 0);
    map.set('columnHeader', columnHeader);

    const cellData = new Y.Map<unknown>();
    sheet.cellData.forEach((row, column, cell) => {
        const record = cell as unknown as Record<string, unknown>;
        for (const field of CELL_FIELDS) {
            const value = record[field];
            if (value !== undefined && value !== null) {
                cellData.set(encodeCellKey(row, column, field), cloneJson(value));
            }
        }
    });
    map.set('cellData', cellData);

    const rowData = new Y.Map<unknown>();
    sheet.rowData.forEach((index, meta) => {
        const record = meta as unknown as Record<string, unknown>;
        for (const field of ROW_FIELDS) {
            const value = record[field];
            if (value !== undefined && value !== null) {
                rowData.set(encodeIndexKey(index, field), cloneJson(value));
            }
        }
    });
    map.set('rowData', rowData);

    const columnData = new Y.Map<unknown>();
    sheet.columnData.forEach((index, meta) => {
        const record = meta as unknown as Record<string, unknown>;
        for (const field of COLUMN_FIELDS) {
            const value = record[field];
            if (value !== undefined && value !== null) {
                columnData.set(encodeIndexKey(index, field), cloneJson(value));
            }
        }
    });
    map.set('columnData', columnData);

    const mergeData = new Y.Map<unknown>();
    for (const merge of sheet.mergeData) {
        mergeData.set(
            `${merge.startRow}:${merge.startColumn}:${merge.endRow}:${merge.endColumn}`,
            cloneJson(merge)
        );
    }
    map.set('mergeData', mergeData);

    return map;
}
