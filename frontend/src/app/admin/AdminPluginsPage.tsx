/**
 * 插件管理（管理后台 Tab）。
 *
 * 上传 zip → 后端校验 manifest / zip 安全 → 解包入库 → 立即成为当前版本。
 * 这里只负责选择文件、展示结果、启用禁用、切换版本。
 */

import { useCallback, useEffect, useState } from 'react';
import {
    App,
    Button,
    Drawer,
    Empty,
    List,
    Modal,
    Space,
    Switch,
    Table,
    Tag,
    Tooltip,
    Typography,
    Upload,
} from 'antd';
import {
    CloudUploadOutlined,
    HistoryOutlined,
    InboxOutlined,
    ReloadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { ApiError } from '../api/client';
import {
    adminPluginsApi,
    type AdminPlugin,
    type AdminPluginVersion,
    type PluginVersionStatus,
} from '../api/admin-plugins';

const { Text, Title } = Typography;

const STATUS_COLOR: Record<PluginVersionStatus, string> = {
    PUBLISHED: 'green',
    VALIDATED: 'blue',
    UPLOADED: 'orange',
    REJECTED: 'red',
    DEPRECATED: 'default',
};

const STATUS_LABEL: Record<PluginVersionStatus, string> = {
    PUBLISHED: '已发布',
    VALIDATED: '已校验',
    UPLOADED: '待处理',
    REJECTED: '已拒绝',
    DEPRECATED: '已废弃',
};

export function AdminPluginsPage() {
    const { message: messageApi } = App.useApp();

    const [plugins, setPlugins] = useState<AdminPlugin[]>([]);
    const [loading, setLoading] = useState(true);
    const [busyKey, setBusyKey] = useState<string | null>(null);

    const [uploadOpen, setUploadOpen] = useState(false);
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [uploading, setUploading] = useState(false);

    const [versionTarget, setVersionTarget] = useState<AdminPlugin | null>(null);

    const load = useCallback(async (): Promise<void> => {
        setLoading(true);
        try {
            setPlugins(await adminPluginsApi.list());
        } catch (err) {
            messageApi.error(err instanceof ApiError ? err.message : '加载插件失败');
        } finally {
            setLoading(false);
        }
    }, [messageApi]);

    useEffect(() => {
        void load();
    }, [load]);

    async function toggle(plugin: AdminPlugin, enabled: boolean): Promise<void> {
        setBusyKey(plugin.pluginKey);
        try {
            const updated = await adminPluginsApi.setInstallation(plugin.pluginKey, {
                enabled,
            });
            applyUpdated(updated);
            messageApi.success(`${plugin.name} 已${enabled ? '启用' : '禁用'}`);
        } catch (err) {
            messageApi.error(err instanceof ApiError ? err.message : '操作失败');
        } finally {
            setBusyKey(null);
        }
    }

    async function switchVersion(plugin: AdminPlugin, version: string): Promise<void> {
        setBusyKey(plugin.pluginKey);
        try {
            const updated = await adminPluginsApi.setInstallation(plugin.pluginKey, {
                version,
            });
            applyUpdated(updated);
            setVersionTarget(updated);
            messageApi.success(`${plugin.name} 已切换到 v${version}`);
        } catch (err) {
            messageApi.error(err instanceof ApiError ? err.message : '切换版本失败');
        } finally {
            setBusyKey(null);
        }
    }

    function applyUpdated(updated: AdminPlugin): void {
        setPlugins((current) =>
            current.map((plugin) =>
                plugin.pluginKey === updated.pluginKey ? updated : plugin
            )
        );
    }

    async function submitUpload(): Promise<void> {
        if (!uploadFile) return;
        setUploading(true);
        try {
            const plugin = await adminPluginsApi.upload(uploadFile);
            messageApi.success(
                `已上传 ${plugin.name}${plugin.activeVersion ? ` v${plugin.activeVersion}` : ''}`
            );
            setUploadOpen(false);
            setUploadFile(null);
            await load();
        } catch (err) {
            messageApi.error(err instanceof ApiError ? err.message : '上传失败');
        } finally {
            setUploading(false);
        }
    }

    const columns: ColumnsType<AdminPlugin> = [
        {
            title: '插件',
            dataIndex: 'name',
            render: (_: unknown, plugin) => (
                <Space direction="vertical" size={0}>
                    <Space size={6}>
                        <Text strong>{plugin.name}</Text>
                        {plugin.author && (
                            <Text type="secondary" style={styles.small}>
                                {plugin.author}
                            </Text>
                        )}
                    </Space>
                    <Text code style={styles.small}>
                        {plugin.pluginKey}
                    </Text>
                    {plugin.description && (
                        <Text type="secondary" style={styles.description}>
                            {plugin.description}
                        </Text>
                    )}
                </Space>
            ),
        },
        {
            title: '当前版本',
            width: 150,
            render: (_: unknown, plugin) =>
                plugin.activeVersion ? (
                    <Space direction="vertical" size={0}>
                        <Tag color="blue">v{plugin.activeVersion}</Tag>
                        <Text type="secondary" style={styles.small}>
                            {plugin.enabled ? '已启用' : '已禁用'}
                        </Text>
                    </Space>
                ) : (
                    <Text type="secondary">未安装</Text>
                ),
        },
        {
            title: '启用',
            width: 90,
            render: (_: unknown, plugin) => (
                <Switch
                    checked={plugin.enabled}
                    loading={busyKey === plugin.pluginKey}
                    disabled={!plugin.activeVersion}
                    onChange={(checked) => void toggle(plugin, checked)}
                />
            ),
        },
        {
            title: '权限',
            dataIndex: 'permissions',
            render: (permissions: string[]) =>
                permissions.length > 0 ? (
                    <Space size={[4, 4]} wrap>
                        {permissions.map((permission) => (
                            <Tag key={permission}>{permission}</Tag>
                        ))}
                    </Space>
                ) : (
                    <Text type="secondary">—</Text>
                ),
        },
        {
            title: '大小',
            width: 100,
            render: (_: unknown, plugin) => (
                <Text type="secondary">
                    {formatBytes(plugin.versions[0]?.sizeBytes ?? 0)}
                </Text>
            ),
        },
        {
            title: '更新时间',
            width: 180,
            render: (_: unknown, plugin) => (
                <Text type="secondary" style={styles.small}>
                    {formatTime(plugin.updatedAt)}
                </Text>
            ),
        },
        {
            title: '操作',
            width: 110,
            render: (_: unknown, plugin) => (
                <Button
                    type="link"
                    size="small"
                    icon={<HistoryOutlined />}
                    onClick={() => setVersionTarget(plugin)}
                >
                    版本（{plugin.versions.length}）
                </Button>
            ),
        },
    ];

    return (
        <div style={styles.root}>
            <div style={styles.header}>
                <div>
                    <Title level={5} style={{ margin: 0 }}>
                        插件管理
                    </Title>
                    <Text type="secondary">
                        上传 zip 后立即成为当前版本；同一版本发布后不可覆盖，
                        新版本需重新上传。启用后客户端下次拉取索引即可加载。
                    </Text>
                </div>
                <Space>
                    <Button icon={<ReloadOutlined />} onClick={() => void load()}>
                        刷新
                    </Button>
                    <Button
                        type="primary"
                        icon={<CloudUploadOutlined />}
                        onClick={() => {
                            setUploadFile(null);
                            setUploadOpen(true);
                        }}
                    >
                        上传插件
                    </Button>
                </Space>
            </div>

            <Table<AdminPlugin>
                rowKey={(plugin) => plugin.pluginKey}
                loading={loading}
                columns={columns}
                dataSource={plugins}
                pagination={false}
                size="middle"
                locale={{
                    emptyText: (
                        <Empty
                            description="还没有插件"
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                        />
                    ),
                }}
            />

            {/* ── 上传 zip ── */}
            <Modal
                open={uploadOpen}
                title="上传插件"
                okText="上传"
                cancelText="取消"
                confirmLoading={uploading}
                okButtonProps={{ disabled: !uploadFile }}
                onOk={() => void submitUpload()}
                onCancel={() => {
                    setUploadOpen(false);
                    setUploadFile(null);
                }}
                width={620}
                destroyOnHidden
            >
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    <Upload.Dragger
                        accept=".zip"
                        maxCount={1}
                        fileList={
                            uploadFile
                                ? [{ uid: '-1', name: uploadFile.name, status: 'done' }]
                                : []
                        }
                        beforeUpload={(file) => {
                            if (!file.name.toLowerCase().endsWith('.zip')) {
                                messageApi.error('只支持 .zip 文件');
                                return Upload.LIST_IGNORE;
                            }
                            setUploadFile(file);
                            return false;
                        }}
                        onRemove={() => {
                            setUploadFile(null);
                            return true;
                        }}
                    >
                        <p className="ant-upload-drag-icon">
                            <InboxOutlined />
                        </p>
                        <p className="ant-upload-text">点击或拖拽插件 zip 到这里</p>
                        <p className="ant-upload-hint">
                            服务端会校验 plugin.json、文件类型、路径与解压体积；
                            校验失败不会入库。
                        </p>
                    </Upload.Dragger>

                    <Text type="secondary" style={styles.small}>
                        构建产物在 plugins/&lt;插件目录&gt;/release/&lt;id&gt;-&lt;version&gt;.zip。
                        上传前请确认 manifest.id 与版本号。
                    </Text>
                </Space>
            </Modal>

            {/* ── 版本历史 ── */}
            <Drawer
                open={versionTarget !== null}
                onClose={() => setVersionTarget(null)}
                width={560}
                title={versionTarget ? `版本 · ${versionTarget.name}` : '版本'}
            >
                <List
                    dataSource={versionTarget?.versions ?? []}
                    locale={{ emptyText: <Empty description="没有版本" /> }}
                    renderItem={(version) => (
                        <VersionRow
                            version={version}
                            busy={busyKey === versionTarget?.pluginKey}
                            onSwitch={() => {
                                if (versionTarget) {
                                    void switchVersion(versionTarget, version.version);
                                }
                            }}
                        />
                    )}
                />
            </Drawer>
        </div>
    );
}

function VersionRow({
    version,
    busy,
    onSwitch,
}: {
    version: AdminPluginVersion;
    busy: boolean;
    onSwitch: () => void;
}) {
    return (
        <List.Item
            actions={[
                <Button
                    key="switch"
                    size="small"
                    type={version.active ? 'default' : 'primary'}
                    disabled={version.active || version.status !== 'PUBLISHED' || busy}
                    loading={busy && !version.active}
                    onClick={onSwitch}
                >
                    {version.active ? '当前版本' : '设为当前'}
                </Button>,
            ]}
        >
            <List.Item.Meta
                title={
                    <Space size={6}>
                        <Tag color="blue">v{version.version}</Tag>
                        <Tag color={STATUS_COLOR[version.status]}>
                            {STATUS_LABEL[version.status]}
                        </Tag>
                        {version.active && <Tag color="gold">当前</Tag>}
                    </Space>
                }
                description={
                    <Space size={12} wrap>
                        <Tooltip title="zip 大小">
                            <Text type="secondary" style={styles.small}>
                                {formatBytes(version.sizeBytes)}
                            </Text>
                        </Tooltip>
                        <Text type="secondary" style={styles.small}>
                            解压 {formatBytes(version.assetsBytes)}
                        </Text>
                        <Text type="secondary" style={styles.small}>
                            上传 {formatTime(version.uploadedAt)}
                        </Text>
                    </Space>
                }
            />
        </List.Item>
    );
}

function formatBytes(bytes: number): string {
    if (!bytes) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(iso: string | null): string {
    if (!iso) return '—';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

const styles = {
    root: {
        display: 'flex',
        flexDirection: 'column' as const,
        gap: 16,
    },
    header: {
        display: 'flex',
        alignItems: 'flex-start' as const,
        justifyContent: 'space-between' as const,
        gap: 16,
    },
    small: {
        fontSize: 12,
    },
    description: {
        fontSize: 12,
        maxWidth: 520,
    },
};
