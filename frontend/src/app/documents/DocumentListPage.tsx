/**
 * 文档列表 —— 登录后的落地页。
 *
 * 分页用**游标**（后端返回 nextCursor / hasMore）而不是页码：
 * 文档按更新时间倒序，编辑中不断插入新文档时，offset 分页会漏项或重复。
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    App,
    Button,
    Dropdown,
    Empty,
    Input,
    List,
    Modal,
    Space,
    Tag,
    Typography,
} from 'antd';
import {
    FileAddOutlined,
    FolderOpenOutlined,
    MoreOutlined,
    SearchOutlined,
} from '@ant-design/icons';
import { AppLayout } from '../../shared/AppLayout';
import { documentsApi, type DocumentSummary } from '../api/documents';
import { ApiError } from '../api/client';

const { Text, Paragraph } = Typography;

const PAGE_SIZE = 20;

export function DocumentListPage() {
    const navigate = useNavigate();
    const { message: messageApi, modal } = App.useApp();

    const [items, setItems] = useState<DocumentSummary[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(true);
    const [keyword, setKeyword] = useState('');
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');

    const load = useCallback(
        async (options: { cursor?: string | null; replace?: boolean }) => {
            setLoading(true);
            try {
                const page = await documentsApi.list({
                    cursor: options.cursor ?? undefined,
                    limit: PAGE_SIZE,
                    keyword: keyword || undefined,
                });
                setItems((prev) =>
                    options.replace ? page.items : [...prev, ...page.items]
                );
                setCursor(page.nextCursor);
                setHasMore(page.hasMore);
            } catch (err) {
                messageApi.error(err instanceof ApiError ? err.message : '加载文档列表失败');
            } finally {
                setLoading(false);
            }
        },
        [keyword, messageApi]
    );

    // 关键词变化时重头加载。debounce 一下，避免每敲一个字打一次接口
    useEffect(() => {
        const timer = setTimeout(() => {
            void load({ cursor: null, replace: true });
        }, 300);
        return () => clearTimeout(timer);
    }, [load]);

    async function handleCreate() {
        const name = newName.trim();
        if (!name) return;
        try {
            const created = await documentsApi.create({ name });
            messageApi.success('文档已创建');
            setCreating(false);
            setNewName('');
            navigate(`/docs/${created.id}`);
        } catch (err) {
            messageApi.error(err instanceof ApiError ? err.message : '创建失败');
        }
    }

    async function handleRename(doc: DocumentSummary) {
        let value = doc.name;
        modal.confirm({
            title: '重命名文档',
            content: (
                <Input
                    defaultValue={doc.name}
                    maxLength={128}
                    onChange={(e) => {
                        value = e.target.value;
                    }}
                />
            ),
            onOk: async () => {
                const next = value.trim();
                if (!next || next === doc.name) return;
                await documentsApi.update(doc.id, { name: next });
                setItems((prev) =>
                    prev.map((item) => (item.id === doc.id ? { ...item, name: next } : item))
                );
                messageApi.success('已重命名');
            },
        });
    }

    function handleDelete(doc: DocumentSummary) {
        modal.confirm({
            title: '删除文档',
            content: `确定删除「${doc.name}」吗？删除后可以在服务端恢复，但列表里不再显示。`,
            okText: '删除',
            okButtonProps: { danger: true },
            onOk: async () => {
                await documentsApi.remove(doc.id);
                setItems((prev) => prev.filter((item) => item.id !== doc.id));
                messageApi.success('已删除');
            },
        });
    }

    async function handleDuplicate(doc: DocumentSummary) {
        try {
            const copy = await documentsApi.duplicate(doc.id);
            messageApi.success('已复制');
            await load({ cursor: null, replace: true });
            navigate(`/docs/${copy.id}`);
        } catch (err) {
            messageApi.error(err instanceof ApiError ? err.message : '复制失败');
        }
    }

    return (
        <AppLayout>
            <div style={styles.page}>
                <div style={styles.toolbar}>
                    <Input
                        allowClear
                        prefix={<SearchOutlined />}
                        placeholder="搜索文档名"
                        value={keyword}
                        onChange={(e) => setKeyword(e.target.value)}
                        style={{ width: 280 }}
                    />
                    <Button
                        type="primary"
                        icon={<FileAddOutlined />}
                        onClick={() => setCreating(true)}
                    >
                        新建文档
                    </Button>
                </div>

                <List
                    loading={loading && items.length === 0}
                    dataSource={items}
                    locale={{
                        emptyText: (
                            <Empty description="还没有文档，点右上角新建一个" />
                        ),
                    }}
                    loadMore={
                        hasMore ? (
                            <div style={styles.more}>
                                <Button
                                    loading={loading}
                                    onClick={() => void load({ cursor })}
                                >
                                    加载更多
                                </Button>
                            </div>
                        ) : null
                    }
                    renderItem={(doc) => (
                        <List.Item
                            style={styles.item}
                            actions={[
                                <Dropdown
                                    key="more"
                                    menu={{
                                        items: [
                                            { key: 'open', label: '打开', icon: <FolderOpenOutlined /> },
                                            { key: 'rename', label: '重命名' },
                                            { key: 'duplicate', label: '创建副本' },
                                            { type: 'divider' },
                                            { key: 'delete', label: '删除', danger: true },
                                        ],
                                        onClick: ({ key }) => {
                                            if (key === 'open') navigate(`/docs/${doc.id}`);
                                            if (key === 'rename') void handleRename(doc);
                                            if (key === 'duplicate') void handleDuplicate(doc);
                                            if (key === 'delete') handleDelete(doc);
                                        },
                                    }}
                                >
                                    <Button type="text" icon={<MoreOutlined />} />
                                </Dropdown>,
                            ]}
                        >
                            <List.Item.Meta
                                title={
                                    <a
                                        onClick={() => navigate(`/docs/${doc.id}`)}
                                        style={styles.title}
                                    >
                                        {doc.name}
                                    </a>
                                }
                                description={
                                    <Space size={8} wrap>
                                        <Text type="secondary">
                                            更新于 {formatTime(doc.updatedAt)}
                                        </Text>
                                        <Tag>{doc.cellCount} 个单元格</Tag>
                                        <Tag>{doc.versionCount} 个版本</Tag>
                                        {doc.status === 'ARCHIVED' && <Tag color="orange">已归档</Tag>}
                                    </Space>
                                }
                            />
                            {doc.description && (
                                <Paragraph
                                    type="secondary"
                                    ellipsis={{ rows: 1 }}
                                    style={{ maxWidth: 320, margin: 0 }}
                                >
                                    {doc.description}
                                </Paragraph>
                            )}
                        </List.Item>
                    )}
                />
            </div>

            <Modal
                title="新建文档"
                open={creating}
                onOk={() => void handleCreate()}
                onCancel={() => {
                    setCreating(false);
                    setNewName('');
                }}
                okText="创建"
                confirmLoading={loading}
            >
                <Input
                    autoFocus
                    placeholder="文档名称"
                    maxLength={128}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onPressEnter={() => void handleCreate()}
                />
            </Modal>
        </AppLayout>
    );
}

function formatTime(iso: string): string {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    return date.toLocaleDateString();
}

const styles = {
    page: {
        maxWidth: 960,
        margin: '0 auto',
        padding: '24px 20px 48px',
    },
    toolbar: {
        display: 'flex',
        justifyContent: 'space-between' as const,
        gap: 12,
        marginBottom: 16,
    },
    item: {
        paddingLeft: 8,
        paddingRight: 8,
    },
    title: {
        fontSize: 15,
    },
    more: {
        textAlign: 'center' as const,
        marginTop: 16,
    },
};
