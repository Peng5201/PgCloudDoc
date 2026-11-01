/**
 * 配置中心（管理后台）。
 *
 * 管理的是 etcd 里的两份配置：
 *   - client：下发给浏览器，`/api/v1/config` 匿名可读，首屏渲染前加载
 *   - server：只给服务端用，不会出现在公开接口里
 *
 * 写入语义：
 *   - 编辑时带上列表里的 revision 做 CAS，别人刚改过会 409，不静默覆盖
 *   - 每次保存都写成了一个 etcd 新版本，历史抽屉里可以看/回滚
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    App,
    Button,
    Collapse,
    Drawer,
    Empty,
    Input,
    List,
    Modal,
    Popconfirm,
    Space,
    Table,
    Tabs,
    Tag,
    Tooltip,
    Typography,
} from 'antd';
import {
    DeleteOutlined,
    EditOutlined,
    HistoryOutlined,
    PlusOutlined,
    ReloadOutlined,
    UndoOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { AppLayout } from '../../shared/AppLayout';
import { ApiError } from '../api/client';
import {
    adminConfigApi,
    type AdminConfigEntry,
    type ConfigHistoryItem,
    type ConfigScope,
} from '../api/admin-config';

const { Text, Title } = Typography;

/** 编辑弹窗的草稿 */
interface Draft {
    mode: 'create' | 'edit';
    scope: ConfigScope;
    key: string;
    valueText: string;
    description: string;
    /** edit 时带上，提交做 CAS */
    revision?: number;
}

const SCOPE_LABEL: Record<ConfigScope, string> = {
    client: '客户端配置',
    server: '服务端配置',
};

export interface AdminConfigPageProps {
    /** 嵌入管理后台 Tabs 时不再套 AppLayout、不再加页面 padding */
    embedded?: boolean;
}

export function AdminConfigPage({ embedded = false }: AdminConfigPageProps = {}) {
    const { message: messageApi } = App.useApp();

    const [entries, setEntries] = useState<AdminConfigEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [scope, setScope] = useState<ConfigScope>('client');

    const [editorOpen, setEditorOpen] = useState(false);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [saving, setSaving] = useState(false);
    const [jsonError, setJsonError] = useState<string | null>(null);

    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyTarget, setHistoryTarget] = useState<AdminConfigEntry | null>(null);
    const [historyItems, setHistoryItems] = useState<ConfigHistoryItem[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    const load = useCallback(async (): Promise<void> => {
        setLoading(true);
        try {
            setEntries(await adminConfigApi.list());
        } catch (err) {
            messageApi.error(err instanceof ApiError ? err.message : '加载配置失败');
        } finally {
            setLoading(false);
        }
    }, [messageApi]);

    useEffect(() => {
        void load();
    }, [load]);

    const scopeEntries = useMemo(
        () => entries.filter((entry) => entry.scope === scope),
        [entries, scope]
    );

    /** 下发给浏览器的实际内容（client scope 解码后的扁平 key） */
    const publicPreview = useMemo(() => {
        const out: Record<string, unknown> = {};
        for (const entry of entries) {
            if (entry.scope === 'client') out[entry.key] = entry.value;
        }
        return out;
    }, [entries]);

    // ─────────────────────────── 编辑 ───────────────────────────

    function openCreate(): void {
        setDraft({
            mode: 'create',
            scope,
            key: '',
            valueText: '{\n  \n}',
            description: '',
        });
        setJsonError(null);
        setEditorOpen(true);
    }

    function openEdit(entry: AdminConfigEntry): void {
        setDraft({
            mode: 'edit',
            scope: entry.scope,
            key: entry.key,
            valueText: prettyJson(entry.value),
            description: entry.description ?? '',
            revision: entry.revision,
        });
        setJsonError(null);
        setEditorOpen(true);
    }

    function formatJson(): void {
        if (!draft) return;
        try {
            setDraft({ ...draft, valueText: prettyJson(JSON.parse(draft.valueText || 'null')) });
            setJsonError(null);
        } catch {
            setJsonError('当前内容不是合法 JSON，无法格式化');
        }
    }

    async function save(): Promise<void> {
        if (!draft) return;
        const key = draft.key.trim();
        if (!key) {
            messageApi.error('请填写配置键');
            return;
        }

        let value: unknown;
        try {
            value = JSON.parse(draft.valueText || 'null');
        } catch {
            setJsonError('配置值必须是合法 JSON');
            return;
        }

        setSaving(true);
        try {
            await adminConfigApi.upsert(draft.scope, key, {
                value,
                description: draft.description.trim(),
                // 新建时没有 expectedRevision；编辑时带上，防止覆盖别人的修改
                expectedRevision: draft.mode === 'edit' ? draft.revision : undefined,
            });
            messageApi.success(`已保存 ${draft.scope}/${key}`);
            setEditorOpen(false);
            await load();
        } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
                // 别人刚改过：同步最新 revision，保留当前输入，让管理员确认后再提交
                messageApi.warning('这条配置刚被别人改过，已同步到最新版本，请确认后再保存');
                try {
                    const latest = await adminConfigApi.list();
                    setEntries(latest);
                    const entry = latest.find(
                        (item) => item.scope === draft.scope && item.key === key
                    );
                    if (entry) {
                        setDraft((current) =>
                            current ? { ...current, revision: entry.revision } : current
                        );
                    }
                } catch {
                    // 同步失败就维持原样，下次保存仍会拿到 409
                }
            } else {
                messageApi.error(err instanceof ApiError ? err.message : '保存失败');
            }
        } finally {
            setSaving(false);
        }
    }

    async function remove(entry: AdminConfigEntry): Promise<void> {
        try {
            await adminConfigApi.remove(entry.scope, entry.key);
            messageApi.success(`已删除 ${entry.scope}/${entry.key}`);
            await load();
        } catch (err) {
            messageApi.error(err instanceof ApiError ? err.message : '删除失败');
        }
    }

    // ─────────────────────────── 历史 / 回滚 ───────────────────────────

    async function openHistory(entry: AdminConfigEntry): Promise<void> {
        setHistoryTarget(entry);
        setHistoryOpen(true);
        await refreshHistory(entry);
    }

    async function refreshHistory(entry: AdminConfigEntry): Promise<void> {
        setHistoryLoading(true);
        try {
            setHistoryItems(await adminConfigApi.history(entry.scope, entry.key, 30));
        } catch (err) {
            messageApi.error(err instanceof ApiError ? err.message : '读取历史失败');
        } finally {
            setHistoryLoading(false);
        }
    }

    async function rollback(item: ConfigHistoryItem): Promise<void> {
        if (!historyTarget) return;
        try {
            await adminConfigApi.rollback(historyTarget.scope, historyTarget.key, item.revision);
            messageApi.success(`已回滚到 revision ${item.revision}`);
            await Promise.all([load(), refreshHistory(historyTarget)]);
        } catch (err) {
            messageApi.error(err instanceof ApiError ? err.message : '回滚失败');
        }
    }

    // ─────────────────────────── 渲染 ───────────────────────────

    const columns: ColumnsType<AdminConfigEntry> = [
        {
            title: '配置键',
            dataIndex: 'key',
            width: 220,
            render: (key: string) => <Text code>{key}</Text>,
        },
        {
            title: '值',
            dataIndex: 'value',
            render: (value: unknown) => (
                <Tooltip title={prettyJson(value)}>
                    <Text style={styles.valuePreview}>{previewValue(value)}</Text>
                </Tooltip>
            ),
        },
        {
            title: '说明',
            dataIndex: 'description',
            width: 200,
            render: (description: string | null) => (
                <Text type="secondary">{description || '—'}</Text>
            ),
        },
        {
            title: 'revision',
            dataIndex: 'revision',
            width: 110,
            render: (revision: number) => <Tag>{revision}</Tag>,
        },
        {
            title: '最后修改',
            dataIndex: 'updatedAt',
            width: 210,
            render: (_: unknown, entry) => (
                <Text type="secondary" style={{ fontSize: 12 }}>
                    {formatTime(entry.updatedAt)}
                    {entry.updatedBy ? ` · ${entry.updatedBy}` : ''}
                </Text>
            ),
        },
        {
            title: '操作',
            width: 190,
            render: (_: unknown, entry) => (
                <Space size={0}>
                    <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(entry)}>
                        编辑
                    </Button>
                    <Button
                        type="link"
                        size="small"
                        icon={<HistoryOutlined />}
                        onClick={() => void openHistory(entry)}
                    >
                        历史
                    </Button>
                    <Popconfirm
                        title={`删除 ${entry.key}？`}
                        description="删除后浏览器将立即拿到不含这一项的配置"
                        okText="删除"
                        cancelText="取消"
                        onConfirm={() => void remove(entry)}
                    >
                        <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                            删除
                        </Button>
                    </Popconfirm>
                </Space>
            ),
        },
    ];

    const content = (
        <>
            <div style={embedded ? styles.embeddedPage : styles.page}>
                <div style={styles.header}>
                    <div>
                        <Title level={4} style={{ margin: 0 }}>
                            配置中心
                        </Title>
                        <Text type="secondary">
                            client 配置会下发给浏览器（首屏前加载），server 配置只在服务端可见。
                            浏览器永远不直连 etcd。
                        </Text>
                    </div>
                    <Space>
                        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
                            刷新
                        </Button>
                        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                            新增配置
                        </Button>
                    </Space>
                </div>

                <Collapse
                    size="small"
                    style={styles.preview}
                    items={[
                        {
                            key: 'preview',
                            label: '下发给浏览器的配置（GET /api/v1/config）',
                            children: (
                                <pre style={styles.pre}>{JSON.stringify(publicPreview, null, 2)}</pre>
                            ),
                        },
                    ]}
                />

                <Tabs
                    activeKey={scope}
                    onChange={(key) => setScope(key as ConfigScope)}
                    items={(['client', 'server'] as ConfigScope[]).map((value) => ({
                        key: value,
                        label: `${SCOPE_LABEL[value]}（${entries.filter((e) => e.scope === value).length}）`,
                    }))}
                />

                <Table<AdminConfigEntry>
                    rowKey={(entry) => `${entry.scope}:${entry.key}`}
                    loading={loading}
                    columns={columns}
                    dataSource={scopeEntries}
                    pagination={false}
                    size="middle"
                    locale={{ emptyText: <Empty description="还没有配置" /> }}
                />
            </div>

            {/* ── 新建 / 编辑 ── */}
            <Modal
                open={editorOpen}
                title={
                    draft?.mode === 'edit'
                        ? `编辑 ${draft.scope}/${draft.key}`
                        : `新增${SCOPE_LABEL[draft?.scope ?? scope]}`
                }
                okText="保存"
                cancelText="取消"
                confirmLoading={saving}
                onOk={() => void save()}
                onCancel={() => setEditorOpen(false)}
                width={680}
                destroyOnHidden
            >
                {draft && (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                        <div>
                            <Text strong>配置键</Text>
                            <Input
                                value={draft.key}
                                disabled={draft.mode === 'edit'}
                                placeholder="例如 ui.appName / maintenance.enabled"
                                onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                            />
                            <Text type="secondary" style={{ fontSize: 12 }}>
                                字母/数字开头，可含 . _ -，点号用来表达层级
                            </Text>
                        </div>

                        <div>
                            <Text strong>值（JSON）</Text>
                            <Input.TextArea
                                value={draft.valueText}
                                autoSize={{ minRows: 8, maxRows: 20 }}
                                style={styles.editor}
                                onChange={(e) => {
                                    setDraft({ ...draft, valueText: e.target.value });
                                    setJsonError(null);
                                }}
                            />
                            <Space>
                                <Button size="small" onClick={formatJson}>
                                    格式化
                                </Button>
                                {jsonError && <Text type="danger">{jsonError}</Text>}
                            </Space>
                        </div>

                        <div>
                            <Text strong>说明</Text>
                            <Input
                                value={draft.description}
                                maxLength={200}
                                placeholder="给同事看的备注（可选）"
                                onChange={(e) =>
                                    setDraft({ ...draft, description: e.target.value })
                                }
                            />
                        </div>
                    </Space>
                )}
            </Modal>

            {/* ── 历史 ── */}
            <Drawer
                open={historyOpen}
                onClose={() => setHistoryOpen(false)}
                width={560}
                title={
                    historyTarget
                        ? `版本历史 · ${historyTarget.scope}/${historyTarget.key}`
                        : '版本历史'
                }
            >
                <List
                    loading={historyLoading}
                    dataSource={historyItems}
                    locale={{ emptyText: <Empty description="没有历史版本" /> }}
                    renderItem={(item) => (
                        <List.Item
                            actions={[
                                <Popconfirm
                                    key="rollback"
                                    title={`回滚到 revision ${item.revision}？`}
                                    description="会以一次新写入的形式恢复，当前值仍可在历史里找回"
                                    okText="回滚"
                                    cancelText="取消"
                                    disabled={item.deleted}
                                    onConfirm={() => void rollback(item)}
                                >
                                    <Button
                                        size="small"
                                        icon={<UndoOutlined />}
                                        disabled={item.deleted}
                                    >
                                        回滚
                                    </Button>
                                </Popconfirm>,
                            ]}
                        >
                            <List.Item.Meta
                                title={
                                    <Space size={6}>
                                        <Tag color="blue">revision {item.revision}</Tag>
                                        {item.deleted && <Tag color="red">已删除</Tag>}
                                        <Text type="secondary" style={{ fontSize: 12 }}>
                                            {formatTime(item.updatedAt)}
                                            {item.updatedBy ? ` · ${item.updatedBy}` : ''}
                                        </Text>
                                    </Space>
                                }
                                description={
                                    <div>
                                        {item.description && (
                                            <Text type="secondary">{item.description}</Text>
                                        )}
                                        {!item.deleted && (
                                            <pre style={styles.pre}>
                                                {prettyJson(item.value)}
                                            </pre>
                                        )}
                                    </div>
                                }
                            />
                        </List.Item>
                    )}
                />
            </Drawer>
        </>
    );

    return embedded ? content : <AppLayout>{content}</AppLayout>;
}

// ─────────────────────────── 小工具 ───────────────────────────

function prettyJson(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function previewValue(value: unknown): string {
    const text = typeof value === 'string' ? JSON.stringify(value) : prettyJson(value);
    const oneLine = text.replace(/\s+/g, ' ');
    return oneLine.length > 72 ? `${oneLine.slice(0, 72)}…` : oneLine;
}

function formatTime(iso: string | null): string {
    if (!iso) return '—';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

const styles = {
    page: {
        maxWidth: 1200,
        margin: '0 auto',
        padding: '24px 24px 48px',
    },
    embeddedPage: {
        maxWidth: 'none',
        margin: 0,
        padding: 0,
    },
    header: {
        display: 'flex',
        alignItems: 'flex-start' as const,
        justifyContent: 'space-between' as const,
        gap: 16,
        marginBottom: 16,
    },
    preview: {
        marginBottom: 8,
    },
    pre: {
        margin: 0,
        padding: 8,
        maxHeight: 240,
        overflow: 'auto',
        background: '#f7f8fa',
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.6,
    },
    editor: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
    },
    valuePreview: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        color: '#5f6368',
    },
};
