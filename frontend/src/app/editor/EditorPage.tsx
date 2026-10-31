/**
 * 编辑器页。
 *
 * ## 启动顺序（重要）
 *
 * 收敛在 `useDocSync().load()` 一个方法里：
 *   建连 → 获取数据 → 序列化为本地对象 → 交给渲染。
 * 细节（Y.Doc 是协同真源、WS 拿不到数据才降级 `GET /snapshot`）见 `useDocSync.ts`。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
    App,
    Badge,
    Button,
    Drawer,
    Dropdown,
    Input,
    List,
    Popconfirm,
    Result,
    Space,
    Spin,
    Tag,
    Tooltip,
    Typography,
} from 'antd';
import {
    CloudServerOutlined,
    DownloadOutlined,
    FileExcelOutlined,
    FrownOutlined,
    HistoryOutlined,
    LoadingOutlined,
    ReloadOutlined,
    SaveOutlined,
    WifiOutlined,
} from '@ant-design/icons';
import { AppLayout } from '../../shared/AppLayout';
import { SheetView } from '../spreadsheet/SheetView';
import type { IRemoteSelection, ISelection, IWorkbookData, SheetEngine } from '../spreadsheet/engine';
import { useDocSync } from '../collab/useDocSync';
import type { Peer } from '../collab/doc-sync';
import { documentsApi, type DocumentVersion, type Member } from '../api/documents';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { AccessRequestPanel } from './AccessRequestPanel';
import { CollaboratorsPopover } from './CollaboratorsPopover';
import { fingerprintWorkbook } from './workbook-fingerprint';

const { Text } = Typography;

export function EditorPage() {
    const { id = '' } = useParams();
    const navigate = useNavigate();
    const { message: messageApi } = App.useApp();
    const { user } = useAuth();

    const [snapshot, setSnapshot] = useState<IWorkbookData | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [docName, setDocName] = useState('');
    const [saving, setSaving] = useState(false);
    const [exportingXlsx, setExportingXlsx] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [versionsOpen, setVersionsOpen] = useState(false);
    const [versions, setVersions] = useState<DocumentVersion[]>([]);
    const [versionsLoading, setVersionsLoading] = useState(false);
    /** 远端改了文档结构（增删 sheet），要整体重建引擎 */
    const [structureVersion, setStructureVersion] = useState(0);
    /** 文档名点开编辑态 */
    const [renaming, setRenaming] = useState(false);
    const [nameDraft, setNameDraft] = useState('');
    const renamingRef = useRef(false);
    /** 无权限访问（404/403）时显示申请页 */
    const [accessDenied, setAccessDenied] = useState(false);
    /** 当前用户在该文档的角色，判断只读/编辑 */
    const [myRole, setMyRole] = useState<Member['role'] | null>(null);
    /** 递增即触发一次重新加载（失败页的「重新加载」按钮） */
    const [reloadToken, setReloadToken] = useState(0);

    const engineRef = useRef<SheetEngine | null>(null);
    /** 上次存档（或刚载入）时的内容指纹，null = 还没建立基线 */
    const savedFingerprintRef = useRef<string | null>(null);
    const docSyncRef = useRef<{
        materialize(): IWorkbookData;
        setName(n: string): void;
        setLocalSelection(selection: ISelection): void;
    } | null>(null);
    /** 最新的 peers，供引擎重建时立刻补画远端选区 */
    const peersRef = useRef<Peer[]>([]);
    /** 是否可编辑（角色确认后）。选区广播只看它，避免角色异步加载前的竞态 */
    const canEditRef = useRef(false);

    const onStructureChange = useCallback(() => {
        setStructureVersion((v) => v + 1);
    }, []);

    const { docSync, status, notice, peers, load, attach, reconnect } = useDocSync(id, {
        onStructureChange,
    });

    peersRef.current = peers;

    /** 别人的选区变化 → 直接灌进渲染层（不经过 React 树，只触发一次重绘）。
     * 只读（VIEWER）看不到别人的选区：直接清空；`myRole` 变化时也会重算。 */
    useEffect(() => {
        const canSeeRemote = myRole === 'OWNER' || myRole === 'EDITOR';
        engineRef.current?.setRemoteSelections(canSeeRemote ? toRemoteSelections(peers) : []);
    }, [peers, myRole]);

    /** 重新加载：先强制重连（普通 connect 对卡死的连接是幂等的），再触发载入流程 */
    const retryLoad = useCallback(() => {
        try {
            reconnect();
        } catch (err) {
            console.warn('[editor] 重连失败', err);
        }
        setReloadToken((t) => t + 1);
    }, [reconnect]);

    // ────────────────────────── 载入 ──────────────────────────

    useEffect(() => {
        if (!docSync) return;
        let cancelled = false;

        (async () => {
            setLoading(true);
            setAccessDenied(false);
            // 注意：这里**不清 loadError**。重试时保留错误页，按钮上转圈，
            // 失败得快也能看到反馈；成功后再清掉。
            try {
                // 建连 → 获取数据 → 序列化 → 交给渲染。
                // 加超时：fetch 本身没有超时，后端不响应时页面会永远停在载入中
                const loaded = await withTimeout(load(), LOAD_TIMEOUT_MS);
                if (cancelled) return;

                setSnapshot(loaded.snapshot);
                setDocName(loaded.docName);
                setLoadError(null);

                if (loaded.source === 'snapshot') {
                    messageApi.warning('协同服务未连接，当前为离线模式，改动不会实时同步');
                }
            } catch (err) {
                if (cancelled) return;
                // 具体原因先打到控制台，方便排查（页面只给用户看必要的）
                console.error('[editor] 文档加载失败', err);
                // 404（无权限或不存在，后端统一 404 防枚举）/ 403（权限不足）→ 走申请页
                if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
                    setAccessDenied(true);
                } else {
                    // 保留原始错误信息（`取快照失败（500）` 这类才查得到问题）
                    setLoadError(err instanceof Error ? err.message : '文档加载失败');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [docSync, load, messageApi, reloadToken]);

    // 结构性改动（远端增删 sheet）→ 重新物化一份快照，SheetView 会重建引擎
    useEffect(() => {
        if (structureVersion === 0 || !docSync || loading) return;
        setSnapshot(docSync.materialize());
    }, [structureVersion, docSync, loading]);

    // 拉成员列表，确定自己的角色（只读 / 编辑 / 创建者）
    const loadMyRole = useCallback(async () => {
        try {
            const members = await documentsApi.members(id);
            const me = members.find((m) => m.userId === user?.id);
            setMyRole(me?.role ?? null);
        } catch {
            setMyRole(null);
        }
    }, [id, user?.id]);

    useEffect(() => {
        if (!docSync || accessDenied || loading || !user) return;
        void loadMyRole();
    }, [docSync, accessDenied, loading, user, loadMyRole]);

    useEffect(() => {
        docSyncRef.current = docSync;
    }, [docSync]);

    // 服务端通知（自动归档完成）
    useEffect(() => {
        if (!notice) return;
        if (notice.type === 'snapshot-saved') {
            const versionNo = (notice.data as { versionNo?: number })?.versionNo;
            messageApi.success(
                versionNo ? `已自动保存为版本 ${versionNo}` : '已自动保存'
            );
        }
    }, [notice, messageApi]);

    // 有未存档的改动时，关页面前提个醒
    useEffect(() => {
        if (!dirty) return;
        const handler = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [dirty]);

    // ────────────────────────── 操作 ──────────────────────────

    const isReadonly = myRole === 'VIEWER';
    const canEdit = myRole === 'OWNER' || myRole === 'EDITOR';
    /** 文件名只有创建者能改（后端同样会拦） */
    const isOwner = myRole === 'OWNER';
    // 选区广播只看「可编辑」，不只看「非只读」：角色还没拉回来（myRole 为 null）时
    // 既不算只读也不能编辑，这时广播会把只读用户的选区漏出去，所以一律等角色确认。
    canEditRef.current = canEdit;

    const handleEngineReady = useCallback(
        (engine: SheetEngine | null) => {
            engineRef.current = engine;
            // 协同桥无条件挂上：只读是引擎自己拦的（readOnly），不靠这里判断。
            // 曾经按 canEdit 决定挂不挂，但角色是异步拉的 —— 引擎就绪时 myRole 还是
            // null（canEdit=false），桥没挂上；角色回来后又不会再触发 onEngineReady，
            // 结果本地编辑根本进不了 Y.Doc，刷新即丢。
            attach(engine);
            if (engine) {
                // 引擎首次就绪时记下内容指纹：之后「要不要保存」都拿它比
                if (savedFingerprintRef.current === null) {
                    void fingerprintWorkbook(engine.toJSON()).then((fp) => {
                        // 期间如果已经存过一版，别用更早的基线覆盖
                        if (savedFingerprintRef.current === null) {
                            savedFingerprintRef.current = fp;
                        }
                    });
                }
                // 任何本地改动都标记「有未存档的版本」
                const offContent = engine.on('content-change', () => setDirty(true));
                // 只读（或角色未确认）不把自己的选区广播出去
                const offSelection = engine.on('selection-change', () => {
                    if (!canEditRef.current) return;
                    // 把完整选区（多块 + 活动格）广播出去，别人才能看到我在选哪片
                    docSyncRef.current?.setLocalSelection(engine.getSelection());
                });
                // 引擎就绪时先把当前已有的远端选区灌进去；
                // 只读（或角色未确认）不显示别人的选区，等角色确认后再由 peers effect 重算
                engine.setRemoteSelections(
                    canEditRef.current ? toRemoteSelections(peersRef.current) : []
                );
                // 角色已确认可编辑时，顺手把自己的初始选区广播出去
                // （只读用户这里不广播；若角色比引擎晚到，由下面的 effect 补一次）
                if (canEditRef.current) {
                    docSyncRef.current?.setLocalSelection(engine.getSelection());
                }
                return () => {
                    offContent();
                    offSelection();
                };
            }
            return undefined;
        },
        [attach, docSync]
    );

    // 角色从「未知」确认到「可编辑」后，补一次初始选区广播。
    // 只读（VIEWER）走不到这：canEdit 恒为 false，选区从不在任何时刻外发。
    useEffect(() => {
        if (!canEdit) return;
        const engine = engineRef.current;
        if (engine) docSyncRef.current?.setLocalSelection(engine.getSelection());
    }, [canEdit]);

    async function handleSave() {
        if (saving) return;
        // 快速判断：载入后什么都没发生过
        if (!dirty) {
            messageApi.info('没有改动，不用保存');
            return;
        }

        setSaving(true);
        try {
            // dirty 只能说明「有事件发生过」——改了又改回去的内容其实没变，
            // 用内容指纹再确认一次（改回原样就不必再存一个空版本）
            const engine = engineRef.current;
            const current = engine ? await fingerprintWorkbook(engine.toJSON()) : null;
            if (current !== null && current === savedFingerprintRef.current) {
                // 内容确实和存档一致，把「有未存档的改动」标记也清掉
                setDirty(false);
                messageApi.info('没有改动，不用保存');
                return;
            }

            const result = await documentsApi.archive(id, '手动保存');
            if (current !== null) savedFingerprintRef.current = current;
            setDirty(false);
            if (result.created) {
                messageApi.success(`已保存为版本 ${result.versionNo}`);
            } else {
                // 服务端按内容哈希判定内容没变，没有新增版本
                messageApi.info('没有改动，不用保存');
            }
            if (versionsOpen) void loadVersions();
        } catch (err) {
            messageApi.error(err instanceof ApiError ? err.message : '保存失败');
        } finally {
            setSaving(false);
        }
    }

    // Ctrl/⌘ + S 保存。必须 preventDefault，否则浏览器会同时弹出「保存网页」对话框
    const saveShortcutRef = useRef<() => void>(() => undefined);
    useEffect(() => {
        saveShortcutRef.current = () => {
            if (loading || accessDenied || !canEdit) return;
            void handleSave();
        };
    });

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                saveShortcutRef.current();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

    async function loadVersions() {
        setVersionsLoading(true);
        try {
            setVersions(await documentsApi.versions(id));
        } catch (err) {
            messageApi.error(err instanceof ApiError ? err.message : '加载版本失败');
        } finally {
            setVersionsLoading(false);
        }
    }

    function openVersions() {
        setVersionsOpen(true);
        void loadVersions();
    }

    async function handleRestore(versionNo: number) {
        try {
            await documentsApi.restoreVersion(id, versionNo);
            messageApi.success(`已回滚到版本 ${versionNo}`);
            setVersionsOpen(false);
            // 回滚会重写 Y.Doc，协同层会把新状态推过来；这里也主动刷一次
            if (docSync) {
                setSnapshot(docSync.materialize());
            }
            // 回滚本身已经归档了一版，基线交给重建后的引擎重新建立
            savedFingerprintRef.current = null;
            setDirty(false);
        } catch (err) {
            messageApi.error(err instanceof ApiError ? err.message : '回滚失败');
        }
    }

    function handleExport() {
        const engine = engineRef.current;
        if (!engine) return;
        const json = JSON.stringify(engine.toJSON(), null, 2);
        downloadBlob(new Blob([json], { type: 'application/json' }), `${docName || '工作簿'}.json`);
    }

    /** 导出 xlsx —— 由服务端基于权威 Y.Doc 生成，前端只负责下载 */
    async function handleExportXlsx() {
        if (exportingXlsx) return;
        setExportingXlsx(true);
        try {
            const blob = await documentsApi.exportXlsx(id);
            downloadBlob(blob, `${docName || '工作簿'}.xlsx`);
            messageApi.success('已导出 Excel');
        } catch (err) {
            messageApi.error(err instanceof Error ? err.message : '导出 Excel 失败');
        } finally {
            setExportingXlsx(false);
        }
    }

    // ────────────────────────── 文档名（点击即编辑）──────────────────────────

    function startRename() {
        // 载入中还没有名字，点开只会是个空输入框；只有创建者能改文件名
        if (!isOwner || loading) return;
        setNameDraft(docName);
        renamingRef.current = true;
        setRenaming(true);
    }

    /** 失焦 / 回车提交；Esc 或校验失败则放弃 */
    async function commitRename() {
        // 回车先触发、随后失焦还会再来一次，用 ref 挡掉重复提交
        if (!renamingRef.current) return;
        renamingRef.current = false;
        setRenaming(false);

        const next = nameDraft.trim();
        if (!next) {
            messageApi.error('文档名不能为空');
            return;
        }
        if (next === docName) return;

        const previous = docName;
        setDocName(next);
        // 协作者实时看到 + 落库（列表页也跟着变）
        docSyncRef.current?.setName(next);
        try {
            await documentsApi.update(id, { name: next });
        } catch (err) {
            // 写库失败就把本地和协同层都退回去，别让界面显示一个没存上的名字
            setDocName(previous);
            docSyncRef.current?.setName(previous);
            messageApi.error(err instanceof ApiError ? err.message : '重命名失败');
        }
    }

    // ────────────────────────── 渲染 ──────────────────────────

    const statusIcon =
        status === 'connected' ? (
            <WifiOutlined style={{ color: '#00b578' }} />
        ) : status === 'connecting' ? (
            <LoadingOutlined style={{ color: '#ff8800' }} />
        ) : (
            <CloudServerOutlined style={{ color: '#e8443a' }} />
        );

    const extra = (
        <Space size={8}>
            <CollaboratorsPopover
                documentId={id}
                myRole={myRole}
                onChanged={() => void loadMyRole()}
            />
            <Tooltip
                title={
                    status === 'connected'
                        ? '已连接协同服务'
                        : status === 'connecting'
                          ? '正在连接协同服务…'
                          : '协同服务已断开，改动不会实时同步'
                }
            >
                <Badge status={status === 'connected' ? 'success' : 'warning'}>{statusIcon}</Badge>
            </Tooltip>

            <Dropdown
                menu={{
                    items: [
                        {
                            key: 'save',
                            label: saving ? '正在保存…' : '保存为版本',
                            icon: <SaveOutlined />,
                            disabled: isReadonly || saving,
                        },
                        { type: 'divider' },
                        { key: 'versions', label: '版本历史', icon: <HistoryOutlined /> },
                        {
                            key: 'export-xlsx',
                            label: exportingXlsx ? '正在导出…' : '导出 Excel (.xlsx)',
                            icon: <FileExcelOutlined />,
                            disabled: exportingXlsx,
                        },
                        { key: 'export', label: '导出 JSON', icon: <DownloadOutlined /> },
                    ],
                    onClick: ({ key }) => {
                        if (key === 'save') void handleSave();
                        if (key === 'versions') openVersions();
                        if (key === 'export-xlsx') void handleExportXlsx();
                        if (key === 'export') handleExport();
                    },
                }}
            >
                <Button type="text" style={{ color: '#fff' }} icon={<HistoryOutlined />} />
            </Dropdown>
        </Space>
    );

    return (
        <AppLayout extra={extra}>
            <div style={styles.root}>
                <div style={styles.titleBar}>
                    <Space size={8}>
                        {renaming ? (
                            <Input
                                size="small"
                                autoFocus
                                value={nameDraft}
                                maxLength={128}
                                style={{ width: 220 }}
                                onChange={(e) => setNameDraft(e.target.value)}
                                onPressEnter={() => void commitRename()}
                                onBlur={() => void commitRename()}
                                onKeyDown={(e) => {
                                    if (e.key === 'Escape') {
                                        // 放弃修改：先关掉标记，onBlur 就不会再提交
                                        renamingRef.current = false;
                                        setRenaming(false);
                                    }
                                }}
                            />
                        ) : (
                            !loading && (
                                <Tooltip
                                    title={
                                        isReadonly
                                            ? '只读，无法重命名'
                                            : isOwner
                                              ? '点击重命名'
                                              : '只有创建者可以修改文件名'
                                    }
                                >
                                    <Text
                                        strong
                                        style={{
                                            fontSize: 15,
                                            cursor: isOwner ? 'text' : 'default',
                                        }}
                                        onClick={startRename}
                                    >
                                        {docName || '未命名文档'}
                                    </Text>
                                </Tooltip>
                            )
                        )}
                    </Space>
                    <Space size={8}>
                        {/* 载入中角色还没确定，先留空 */}
                        {!loading && (
                            <>
                                {myRole === 'OWNER' && <Tag color="gold">创建者</Tag>}
                                <Tag color={canEdit ? 'green' : 'orange'}>
                                    {isReadonly ? '只读' : '可编辑'}
                                </Tag>
                            </>
                        )}
                    </Space>
                </div>

                <div style={styles.sheetArea}>
                    {loading && !accessDenied && !loadError && (
                        <div style={styles.center}>
                            <Spin size="large" tip="正在载入文档…" />
                        </div>
                    )}
                    {!loading && accessDenied && (
                        <div style={styles.center}>
                            <AccessRequestPanel documentId={id} />
                        </div>
                    )}
                    {!accessDenied && loadError && (
                        <div style={styles.center}>
                            <Result
                                icon={<FrownOutlined style={{ color: '#faad14' }} />}
                                title="文档暂时打不开"
                                subTitle={loadError}
                                extra={
                                    <Space size={8}>
                                        <Button
                                            type="primary"
                                            // 不用 loading 属性：antd 在 loading 时会吞掉点击，
                                            // 万一卡在加载中就没法重试了
                                            icon={loading ? <LoadingOutlined /> : <ReloadOutlined />}
                                            onClick={retryLoad}
                                        >
                                            重新加载
                                        </Button>
                                        <Button onClick={() => navigate('/')}>
                                            返回文档列表
                                        </Button>
                                    </Space>
                                }
                            />
                        </div>
                    )}
                    {!loading && !accessDenied && !loadError && !snapshot && (
                        <div style={styles.center}>
                            <Result
                                icon={<FrownOutlined style={{ color: '#faad14' }} />}
                                title="文档还没有准备好"
                                subTitle="协同实例或登录态可能尚未就绪"
                                extra={
                                    <Button
                                        type="primary"
                                        icon={<ReloadOutlined />}
                                        onClick={retryLoad}
                                    >
                                        重新加载
                                    </Button>
                                }
                            />
                        </div>
                    )}
                    {!loading && !accessDenied && !loadError && snapshot && (
                        <SheetView
                            key={structureVersion}
                            snapshot={snapshot}
                            readOnly={isReadonly}
                            onEngineReady={handleEngineReady}
                        />
                    )}
                </div>
            </div>

            <Drawer
                title="版本历史"
                open={versionsOpen}
                onClose={() => setVersionsOpen(false)}
                width={420}
            >
                <List
                    loading={versionsLoading}
                    dataSource={versions}
                    renderItem={(version) => (
                        <List.Item
                            actions={[
                                <Popconfirm
                                    key="restore"
                                    title={`回滚到版本 ${version.versionNo}？`}
                                    description="回滚会覆盖当前内容（会作为新的一版留档）"
                                    onConfirm={() => void handleRestore(version.versionNo)}
                                    okText="回滚"
                                    cancelText="取消"
                                    disabled={isReadonly}
                                >
                                    <Button size="small" disabled={isReadonly}>
                                        回滚
                                    </Button>
                                </Popconfirm>,
                            ]}
                        >
                            <List.Item.Meta
                                title={
                                    <Space>
                                        <Tag>版本 {version.versionNo}</Tag>
                                        {version.remark && <Text type="secondary">{version.remark}</Text>}
                                    </Space>
                                }
                                description={
                                    <Text type="secondary">
                                        {new Date(version.createdAt).toLocaleString()} ·{' '}
                                        {formatBytes(version.sizeBytes)}
                                    </Text>
                                }
                            />
                        </List.Item>
                    )}
                />
            </Drawer>
        </AppLayout>
    );
}

/** Peer[] → 渲染层要的远端选区结构 */
function toRemoteSelections(peers: Peer[]): IRemoteSelection[] {
    return peers
        .filter((peer) => peer.selection && peer.selection.ranges.length > 0)
        .map((peer) => ({
            key: peer.clientId,
            name: peer.displayName,
            color: peer.color,
            ranges: peer.selection!.ranges,
            active: peer.selection!.active,
        }));
}

/** 整个载入流程的上限。fetch 没有内置超时，后端不响应时必须由这里兜底 */
const LOAD_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('加载超时，请检查网络或后端服务是否正常'));
        }, ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err: unknown) => {
                clearTimeout(timer);
                reject(err);
            }
        );
    });
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 触发浏览器下载。Blob URL 用完立刻回收，避免内存泄漏 */
function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
}

const styles = {
    root: {
        display: 'flex',
        flexDirection: 'column' as const,
        width: '100%',
        height: '100%',
        minHeight: 0,
    },
    titleBar: {
        display: 'flex',
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
        height: 44,
        paddingInline: 16,
        borderBottom: '1px solid #e5e6eb',
        background: '#fff',
    },
    sheetArea: {
        flex: 1,
        minHeight: 0,
        position: 'relative' as const,
    },
    center: {
        display: 'flex',
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        width: '100%',
        height: '100%',
    },
};
