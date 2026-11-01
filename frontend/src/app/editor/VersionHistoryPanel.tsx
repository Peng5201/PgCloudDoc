/**
 * 版本历史面板 —— 宿主页面注册到侧面板的视图。
 *
 * 数据由面板自己拉：面板打开时才挂载，关闭即卸载，不需要编辑器页面替它维护状态。
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, List, Popconfirm, Space, Tag, Typography } from 'antd';
import { HistoryOutlined } from '@ant-design/icons';
import { documentsApi, type DocumentVersion } from '../api/documents';
import { ApiError } from '../api/client';

const { Text } = Typography;

export interface VersionHistoryPanelProps {
    documentId: string;
    readOnly: boolean;
    /** 保存成功后递增，触发重新拉取 */
    refreshToken: number;
    /** 回滚完成：宿主需要重建快照、重置存档基线 */
    onRestored: () => void;
}

export function VersionHistoryPanel({
    documentId,
    readOnly,
    refreshToken,
    onRestored,
}: VersionHistoryPanelProps) {
    const { message } = App.useApp();
    const [versions, setVersions] = useState<DocumentVersion[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [restoring, setRestoring] = useState<number | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setVersions(await documentsApi.versions(documentId));
        } catch (err) {
            setError(err instanceof ApiError ? err.message : '加载版本失败');
        } finally {
            setLoading(false);
        }
    }, [documentId]);

    useEffect(() => {
        void load();
    }, [load, refreshToken]);

    async function handleRestore(versionNo: number) {
        setRestoring(versionNo);
        try {
            await documentsApi.restoreVersion(documentId, versionNo);
            message.success(`已回滚到版本 ${versionNo}`);
            onRestored();
            // 回滚本身也会归档一版，列表要重新拉
            await load();
        } catch (err) {
            message.error(err instanceof ApiError ? err.message : '回滚失败');
        } finally {
            setRestoring(null);
        }
    }

    if (error) {
        return (
            <div style={styles.padded}>
                <Alert
                    type="error"
                    showIcon
                    message="版本列表加载失败"
                    description={error}
                    action={
                        <Button size="small" onClick={() => void load()}>
                            重试
                        </Button>
                    }
                />
            </div>
        );
    }

    return (
        <div style={styles.padded}>
            <List
                loading={loading}
                dataSource={versions}
                locale={{ emptyText: '还没有保存过版本' }}
                renderItem={(version) => (
                    <List.Item
                        actions={[
                            <Popconfirm
                                key="restore"
                                title={`回滚到版本 ${version.versionNo}？`}
                                description="回滚会覆盖当前内容（会作为新的一版留档）"
                                okText="回滚"
                                cancelText="取消"
                                onConfirm={() => void handleRestore(version.versionNo)}
                                disabled={readOnly}
                            >
                                <Button
                                    size="small"
                                    icon={<HistoryOutlined />}
                                    loading={restoring === version.versionNo}
                                    disabled={readOnly || restoring !== null}
                                >
                                    回滚
                                </Button>
                            </Popconfirm>,
                        ]}
                    >
                        <List.Item.Meta
                            title={
                                <Space size={6}>
                                    <Tag>版本 {version.versionNo}</Tag>
                                    {version.remark && (
                                        <Text type="secondary" style={styles.remark}>
                                            {version.remark}
                                        </Text>
                                    )}
                                </Space>
                            }
                            description={
                                <Text type="secondary" style={styles.meta}>
                                    {new Date(version.createdAt).toLocaleString()} ·{' '}
                                    {formatBytes(version.sizeBytes)}
                                </Text>
                            }
                        />
                    </List.Item>
                )}
            />
        </div>
    );
}

const styles = {
    padded: {
        padding: '4px 12px 12px',
    },
    remark: {
        fontSize: 12,
    },
    meta: {
        fontSize: 12,
    },
};

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
