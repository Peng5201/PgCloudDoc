/**
 * 消息中心（顶部栏右侧铃铛）。
 *
 * 承接所有站内消息（访问申请、审批结果等）：
 *   - 铃铛 + 未读红点，放在应用顶栏右侧
 *   - 实时收到消息时弹一条 toast
 *   - 点击铃铛下拉出当前用户的消息列表，打开即标记已读
 */

import { useCallback, useEffect, useState } from 'react';
import { App, Badge, Button, Dropdown, Empty, List, Space, Tag, Typography } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import {
    connectNotifications,
    notificationsApi,
    type Notification,
} from '../api/notifications';
import { useAuth } from '../auth/AuthContext';

const { Text } = Typography;

export function NotificationCenter() {
    const { user } = useAuth();
    const { notification: toast } = App.useApp();
    const navigate = useNavigate();

    const [items, setItems] = useState<Notification[]>([]);
    const [unread, setUnread] = useState(0);
    const [open, setOpen] = useState(false);

    // 挂载：拉历史 + 未读数，同时建立 WebSocket 收增量
    useEffect(() => {
        if (!user) return;
        let cancelled = false;

        void (async () => {
            try {
                const [list, count] = await Promise.all([
                    notificationsApi.list(),
                    notificationsApi.unreadCount(),
                ]);
                if (cancelled) return;
                setItems(list);
                setUnread(count);
            } catch {
                // 拉不到历史就等 WS 增量，别把页面搞挂
            }
        })();

        const off = connectNotifications((n) => {
            setItems((prev) => [n, ...prev]);
            setUnread((c) => c + 1);
            toast.info({ message: n.title, description: n.body ?? undefined });
        });

        return () => {
            cancelled = true;
            off();
        };
    }, [user, toast]);

    // 展开时把当前未读全部置已读（乐观更新）
    const handleOpenChange = useCallback(
        (next: boolean) => {
            setOpen(next);
            if (!next) return;
            const unreadIds = items.filter((i) => !i.read).map((i) => i.id);
            if (unreadIds.length === 0) return;
            setItems((prev) =>
                prev.map((i) => (unreadIds.includes(i.id) ? { ...i, read: true } : i))
            );
            setUnread(0);
            void notificationsApi.markRead(unreadIds).catch(() => undefined);
        },
        [items]
    );

    const markAllRead = useCallback(() => {
        setItems((prev) => prev.map((i) => ({ ...i, read: true })));
        setUnread(0);
        void notificationsApi.markAllRead().catch(() => undefined);
    }, []);

    // 消息关联了文档就点击跳过去（申请通过后能直接进文档）
    const handleClick = useCallback(
        (item: Notification) => {
            const docId = item.payload?.documentId;
            if (!docId) return;
            setOpen(false);

            const targetPath = `/editor/${docId}`;
            // 已经在这个文档里 → 不重复跳转，直接触发消息对应的功能
            if (window.location.pathname === targetPath) {
                const permissionTypes = [
                    'access-request',
                    'access-approved',
                    'access-rejected',
                ];
                if (permissionTypes.includes(item.type)) {
                    // 权限相关消息 → 展开协作者面板
                    window.dispatchEvent(new CustomEvent('pgclouddoc:open-collaborators'));
                }
                return;
            }
            navigate(targetPath);
        },
        [navigate]
    );

    const panel = (
        <div style={styles.panel}>
            <div style={styles.panelHeader}>
                <Text strong>消息</Text>
                {items.length > 0 && (
                    <Button type="link" size="small" onClick={markAllRead}>
                        全部已读
                    </Button>
                )}
            </div>

            {items.length === 0 ? (
                <Empty description="暂无消息" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
                <List
                    size="small"
                    dataSource={items}
                    style={{ maxHeight: 420, overflow: 'auto' }}
                    renderItem={(item) => (
                        <List.Item
                            onClick={() => handleClick(item)}
                            style={{
                                cursor: item.payload?.documentId ? 'pointer' : 'default',
                            }}
                        >
                            <List.Item.Meta
                                title={
                                    <Space size={6}>
                                        <Text strong>{item.title}</Text>
                                        {!item.read && <Tag color="blue">新</Tag>}
                                    </Space>
                                }
                                description={
                                    <Space direction="vertical" size={0}>
                                        {item.body && (
                                            <Text type="secondary">{item.body}</Text>
                                        )}
                                        <Text type="secondary" style={{ fontSize: 12 }}>
                                            {new Date(item.createdAt).toLocaleString()}
                                        </Text>
                                    </Space>
                                }
                            />
                        </List.Item>
                    )}
                />
            )}
        </div>
    );

    return (
        <Dropdown
            open={open}
            onOpenChange={handleOpenChange}
            trigger={['click']}
            dropdownRender={() => panel}
            placement="bottomRight"
        >
            <Badge count={unread} size="small" offset={[-4, 4]}>
                <Button
                    type="text"
                    style={{ color: '#fff' }}
                    icon={<BellOutlined />}
                    aria-label="消息"
                />
            </Badge>
        </Dropdown>
    );
}

const styles = {
    panel: {
        width: 360,
        padding: 12,
        background: '#fff',
        borderRadius: 8,
        boxShadow: '0 6px 16px rgba(0,0,0,0.12)',
    },
    panelHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 8,
    },
};
