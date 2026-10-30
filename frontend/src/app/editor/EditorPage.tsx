/**
 * 编辑器页。
 *
 * ## 启动顺序（重要）
 *
 *   1. 连协同 WS，等首次同步（3s 超时）
 *   2. 从 **Y.Doc** 物化出快照喂给引擎 —— Y.Doc 是协同真源
 *   3. WS 拿不到数据才降级去 `GET /snapshot`
 *
 * 第 2 步不能反过来（先拉快照再合并进 Y.Doc）：快照可能比 Y.Doc 旧，
 * 那等于用一份过期数据去污染 CRDT，合并语义就不成立了。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
    App,
    Avatar,
    Badge,
    Button,
    Drawer,
    Dropdown,
    Input,
    List,
    Popconfirm,
    Space,
    Spin,
    Tag,
    Tooltip,
    Typography,
} from 'antd';
import {
    CloudServerOutlined,
    DownloadOutlined,
    HistoryOutlined,
    LoadingOutlined,
    SaveOutlined,
    WifiOutlined,
} from '@ant-design/icons';
import { AppLayout } from '../../shared/AppLayout';
import { SheetView } from '../spreadsheet/SheetView';
import type { IWorkbookData, SheetEngine } from '../spreadsheet/engine';
import { useDocSync } from '../collab/useDocSync';
import { documentsApi, type DocumentVersion } from '../api/documents';
import { ApiError } from '../api/client';

const { Text } = Typography;

export function EditorPage() {
    const { id = '' } = useParams();
    const navigate = useNavigate();
    const { message: messageApi, modal } = App.useApp();

    const [snapshot, setSnapshot] = useState<IWorkbookData | null>(null);
    const [source, setSource] = useState<'collab' | 'snapshot'>('collab');
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [docName, setDocName] = useState('');
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [versionsOpen, setVersionsOpen] = useState(false);
    const [versions, setVersions] = useState<DocumentVersion[]>([]);
    const [versionsLoading, setVersionsLoading] = useState(false);
    /** 远端改了文档结构（增删 sheet），要整体重建引擎 */
    const [structureVersion, setStructureVersion] = useState(0);

    const engineRef = useRef<SheetEngine | null>(null);
    const docSyncRef = useRef<{ materialize(): IWorkbookData; setName(n: string): void } | null>(
        null
    );

    const onStructureChange = useCallback(() => {
        setStructureVersion((v) => v + 1);
    }, []);

    const { docSync, status, notice, peers, waitUntilReady, attach } = useDocSync(id, {
        onStructureChange,
    });

    // ────────────────────────── 载入 ──────────────────────────

    useEffect(() => {
        if (!docSync) return;
        let cancelled = false;

        (async () => {
            setLoading(true);
            setLoadError(null);
            try {
                const viaSync = await waitUntilReady();
                if (cancelled) return;

                if (viaSync) {
                    setSnapshot(docSync.materialize());
                    setDocName(docSync.getName());
                    setSource('collab');
                } else {
                    // 降级：协同通道不可用，至少让文档能打开（只读式编辑，改动不共享）
                    const [detail, snap] = await Promise.all([
                        documentsApi.detail(id),
                        documentsApi.snapshot(id),
                    ]);
                    if (cancelled) return;
                    setSnapshot(snap);
                    setDocName(detail.name);
                    setSource('snapshot');
                    messageApi.warning('协同服务未连接，当前为离线模式，改动不会实时同步');
                }
            } catch (err) {
                if (cancelled) return;
                setLoadError(err instanceof ApiError ? err.message : '文档加载失败');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [docSync, id, waitUntilReady, messageApi]);

    // 结构性改动（远端增删 sheet）→ 重新物化一份快照，SheetView 会重建引擎
    useEffect(() => {
        if (structureVersion === 0 || !docSync || loading) return;
        setSnapshot(docSync.materialize());
    }, [structureVersion, docSync, loading]);

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

    const handleEngineReady = useCallback(
        (engine: SheetEngine | null) => {
            engineRef.current = engine;
            attach(engine);
            if (engine) {
                // 任何本地改动都标记「有未存档的版本」
                const off = engine.on('content-change', () => setDirty(true));
                engine.on('selection-change', () => {
                    const selection = engine.getSelection();
                    docSyncRef.current &&
                        (docSync as { setLocalCell?(r: number, c: number): void })?.setLocalCell?.(
                            selection.active.row,
                            selection.active.column
                        );
                });
                return () => {
                    off();
                };
            }
            return undefined;
        },
        [attach, docSync]
    );

    async function handleSave() {
        setSaving(true);
        try {
            const { versionNo } = await documentsApi.archive(id, '手动保存');
            setDirty(false);
            messageApi.success(`已保存为版本 ${versionNo}`);
            if (versionsOpen) void loadVersions();
        } catch (err) {
            messageApi.error(err instanceof ApiError ? err.message : '保存失败');
        } finally {
            setSaving(false);
        }
    }

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
            setDirty(false);
        } catch (err) {
            messageApi.error(err instanceof ApiError ? err.message : '回滚失败');
        }
    }

    function handleExport() {
        const engine = engineRef.current;
        if (!engine) return;
        const json = JSON.stringify(engine.toJSON(), null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${docName || '工作簿'}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
    }

    function handleRename() {
        let value = docName;
        modal.confirm({
            title: '重命名文档',
            content: (
                <Input
                    defaultValue={docName}
                    maxLength={128}
                    onChange={(e) => {
                        value = e.target.value;
                    }}
                />
            ),
            onOk: async () => {
                const next = value.trim();
                if (!next || next === docName) return;
                setDocName(next);
                // 协作者实时看到 + 落库（列表页也跟着变）
                docSyncRef.current?.setName(next);
                await documentsApi.update(id, { name: next });
                messageApi.success('已重命名');
            },
        });
    }

    // ────────────────────────── 渲染 ──────────────────────────

    const peersContent = useMemo(() => {
        if (peers.length === 0) return null;
        return (
            <Avatar.Group maxCount={5} size="small">
                {peers.map((peer) => (
                    <Tooltip
                        key={peer.clientId}
                        title={`${peer.displayName}${peer.cell ? ` · ${cellRef(peer.cell)}` : ''}`}
                    >
                        <Avatar size="small" style={{ background: peer.color }}>
                            {peer.displayName.slice(0, 1)}
                        </Avatar>
                    </Tooltip>
                ))}
            </Avatar.Group>
        );
    }, [peers]);

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
            {peersContent}
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
                        { key: 'versions', label: '版本历史', icon: <HistoryOutlined /> },
                        { key: 'export', label: '导出 JSON', icon: <DownloadOutlined /> },
                    ],
                    onClick: ({ key }) => {
                        if (key === 'versions') openVersions();
                        if (key === 'export') handleExport();
                    },
                }}
            >
                <Button type="text" style={{ color: '#fff' }} icon={<HistoryOutlined />} />
            </Dropdown>

            <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={saving}
                onClick={() => void handleSave()}
            >
                保存
            </Button>
        </Space>
    );

    return (
        <AppLayout extra={extra}>
            <div style={styles.root}>
                <div style={styles.titleBar}>
                    <Space size={8}>
                        <a onClick={() => navigate('/')} style={styles.back}>
                            ← 文档列表
                        </a>
                        <Text strong style={{ fontSize: 15 }}>
                            {docName || '未命名文档'}
                        </Text>
                        <Button type="link" size="small" onClick={handleRename}>
                            重命名
                        </Button>
                    </Space>
                    <Space size={8}>
                        {dirty && <Tag color="orange">有未存档的改动</Tag>}
                        <Tag>{source === 'collab' ? '实时协同' : '离线模式'}</Tag>
                    </Space>
                </div>

                <div style={styles.sheetArea}>
                    {loading && (
                        <div style={styles.center}>
                            <Spin size="large" tip="正在载入文档…" />
                        </div>
                    )}
                    {!loading && loadError && (
                        <div style={styles.center}>
                            <Space direction="vertical">
                                <Text type="danger">{loadError}</Text>
                                <Button onClick={() => navigate('/')}>返回文档列表</Button>
                            </Space>
                        </div>
                    )}
                    {!loading && !loadError && snapshot && (
                        <SheetView
                            key={structureVersion}
                            snapshot={snapshot}
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
                                >
                                    <Button size="small">回滚</Button>
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

function cellRef(cell: { row: number; column: number }): string {
    return `${columnLabel(cell.column)}${cell.row + 1}`;
}

function columnLabel(index: number): string {
    let label = '';
    let n = index;
    while (n >= 0) {
        label = String.fromCharCode(65 + (n % 26)) + label;
        n = Math.floor(n / 26) - 1;
    }
    return label;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
    back: {
        cursor: 'pointer',
        color: '#3370ff',
        whiteSpace: 'nowrap' as const,
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
