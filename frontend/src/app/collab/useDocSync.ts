/**
 * 协同的 React 封装。
 *
 * 管三件事：
 *   1. DocSync 的生命周期（挂载建、卸载销毁）
 *   2. 把 status / peers 同步成 React 状态
 *   3. `load()`：把「建连 → 获取数据 → 序列化 → 交给渲染」串成一条流程，
 *      编辑器只需 `await load()` 拿快照去渲染，不用关心中间每一步。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { DocSync, type ConnectionStatus, type Peer, type SyncStatus } from './doc-sync';
import type { IWorkbookData, SheetEngine } from '../spreadsheet/engine';
import { getAccessToken } from '../api/client';
import { documentsApi } from '../api/documents';
import { useAuth } from '../auth/AuthContext';

/** 加载完成后交给渲染层的东西：序列化好的快照 + 元信息 */
export interface LoadedDocument {
    /** 序列化好的本地快照对象，直接喂给引擎渲染 */
    snapshot: IWorkbookData;
    docName: string;
    /** 数据来自实时协同还是离线快照 */
    source: 'collab' | 'snapshot';
}

export interface UseDocSyncResult {
    docSync: DocSync | null;
    status: ConnectionStatus;
    notice: SyncStatus['notice'];
    peers: Peer[];
    /** 引擎接上协同后，本地改动才会实时同步出去 */
    attach: (engine: SheetEngine | null) => void;
    /** 建连 → 获取数据 → 序列化 → 返回快照，一条流程走完 */
    load: () => Promise<LoadedDocument>;
    /** 强制重连（丢掉可能卡死的连接再建一条） */
    reconnect: () => void;
}

export interface UseDocSyncOptions {
    /**
     * 结构性改动（远端增删 sheet、改文档名）后回调。
     * 用 ref 转发，调用方不必关心引用稳定性。
     */
    onStructureChange?: () => void;
}

export function useDocSync(
    documentId: string,
    options: UseDocSyncOptions = {}
): UseDocSyncResult {
    const { user } = useAuth();
    const docSyncRef = useRef<DocSync | null>(null);
    const structureRef = useRef(options.onStructureChange);
    structureRef.current = options.onStructureChange;
    const [docSync, setDocSync] = useState<DocSync | null>(null);
    const [status, setStatus] = useState<ConnectionStatus>('connecting');
    const [notice, setNotice] = useState<SyncStatus['notice']>(null);
    const [peers, setPeers] = useState<Peer[]>([]);

    useEffect(() => {
        const token = getAccessToken();
        if (!token || !user) return;

        const sync = new DocSync({
            documentId,
            token,
            user: {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
            },
            onStructureChange: () => structureRef.current?.(),
        });

        docSyncRef.current = sync;
        setDocSync(sync);

        const offStatus = sync.onStatus((next) => {
            setStatus(next.status);
            setNotice(next.notice);
        });
        const offPeers = sync.onPeers(setPeers);

        // 这里只建实例、订状态，不连网 —— 建连是 load() 流程的第一步
        return () => {
            offStatus();
            offPeers();
            sync.destroy();
            docSyncRef.current = null;
            setDocSync(null);
        };
        // user.id / username 变了就重建（换账号了）
    }, [documentId, user?.id, user?.username, user?.displayName, user]);

    /**
     * 等首次同步。
     *
     * 协同通道拿不到数据时（后端没起、WS 被拦）要能降级去拉快照，
     * 所以这里给个超时而不是无限等。
     */
    const waitUntilReady = useCallback((timeoutMs = 3000) => {
        const sync = docSyncRef.current;
        return new Promise<boolean>((resolve) => {
            if (!sync) {
                resolve(false);
                return;
            }

            let settled = false;
            const finish = (ok: boolean) => {
                if (settled) return;
                settled = true;
                off();
                clearTimeout(timer);
                resolve(ok);
            };

            // 已经连上就直接放行
            if (isDocPopulated(sync)) {
                finish(true);
                return;
            }

            const off = sync.onStatus((next) => {
                if (next.status === 'connected' && isDocPopulated(sync)) {
                    finish(true);
                }
            });
            const timer = setTimeout(() => {
                // 超时了也算「能用」，只要 doc 里有东西就走协同，没有就降级
                finish(isDocPopulated(sync));
            }, timeoutMs);
        });
    }, []);

    /**
     * 文档加载流程，编辑器只需 `await load()` 拿快照去渲染。
     *
     *   ① 建连：建立 WebSocket、完成 Yjs 握手
     *   ② 获取数据：等首次同步完成（3s 超时）
     *   ③ 序列化为本地对象：Y.Doc → 引擎能吃的 IWorkbookData 快照
     *   ④ 交给渲染：返回 LoadedDocument，调用方 setSnapshot 即触发渲染
     *
     * 协同通道拿不到数据时，② 会降级去拉 REST 快照（③ 直接返回快照内容）。
     */
    const load = useCallback(async (): Promise<LoadedDocument> => {
        const sync = docSyncRef.current;
        if (!sync) {
            // 正常不会走到：调用方应在 docSync 就绪后再 load。防御性断言。
            throw new Error('协同实例尚未就绪');
        }

        // ① 建连
        sync.connect();

        // ② 获取数据
        const viaSync = await waitUntilReady();

        // ③ 序列化为本地对象 + ④ 返回给调用方渲染
        if (viaSync) {
            return {
                snapshot: sync.materialize(),
                docName: sync.getName(),
                source: 'collab',
            };
        }

        // 降级：协同通道不可用，至少让文档能打开（只读式编辑，改动不共享）
        const [detail, snap] = await Promise.all([
            documentsApi.detail(documentId),
            documentsApi.snapshot(documentId),
        ]);
        return {
            snapshot: snap,
            docName: detail.name,
            source: 'snapshot',
        };
    }, [docSync, waitUntilReady, documentId]);

    const attach = useCallback((engine: SheetEngine | null) => {
        const sync = docSyncRef.current;
        if (!sync) return;
        if (engine) {
            sync.attach(engine);
        } else {
            sync.detach();
        }
    }, []);

    /** 强制重连（「重新加载」用）：连接卡在 CONNECTING 时也要能重建 */
    const reconnect = useCallback(() => {
        docSyncRef.current?.reconnect();
    }, []);

    return { docSync, status, notice, peers, attach, load, reconnect };
}

/** doc 里是否已经有内容（服务端会推一张默认表过来） */
function isDocPopulated(sync: DocSync): boolean {
    return sync.doc.getArray('sheets').length > 0;
}
