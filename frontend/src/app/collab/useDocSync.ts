/**
 * 协同的 React 封装。
 *
 * 管三件事：
 *   1. DocSync 的生命周期（挂载建、卸载销毁）
 *   2. 把 status / peers 同步成 React 状态
 *   3. 提供「等首次同步完成」的 Promise —— 编辑器要等数据到了才渲染引擎
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { DocSync, type ConnectionStatus, type Peer, type SyncStatus } from './doc-sync';
import type { SheetEngine } from '../spreadsheet/engine';
import { getAccessToken } from '../api/client';
import { useAuth } from '../auth/AuthContext';

export interface UseDocSyncResult {
    docSync: DocSync | null;
    status: ConnectionStatus;
    notice: SyncStatus['notice'];
    peers: Peer[];
    /** 等首次同步（或超时）完成。返回是否真的从协同通道拿到了数据 */
    waitUntilReady: (timeoutMs?: number) => Promise<boolean>;
    attach: (engine: SheetEngine | null) => void;
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

        sync.connect();

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

    const attach = useCallback((engine: SheetEngine | null) => {
        const sync = docSyncRef.current;
        if (!sync) return;
        if (engine) {
            sync.attach(engine);
        } else {
            sync.detach();
        }
    }, []);

    return { docSync, status, notice, peers, waitUntilReady, attach };
}

/** doc 里是否已经有内容（服务端会推一张默认表过来） */
function isDocPopulated(sync: DocSync): boolean {
    return sync.doc.getArray('sheets').length > 0;
}
