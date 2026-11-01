/**
 * 应用外框：顶栏 + 内容区。
 * 顶栏放「品牌 / 当前用户 / 退出」，文档列表和编辑器共用。
 */

import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Avatar, Button, Dropdown, Layout, Space, Typography, message } from 'antd';
import { useAuth } from '../app/auth/AuthContext';
import { NotificationCenter } from '../app/notifications/NotificationCenter';
import { useRuntimeConfig } from '../app/config/runtime-config';

const { Header, Content } = Layout;
const { Text } = Typography;

export interface AppLayoutProps {
    children: ReactNode;
    /** 顶栏右侧的额外操作（编辑器的保存/版本按钮放这里） */
    extra?: ReactNode;
}

export function AppLayout({ children, extra }: AppLayoutProps) {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    const config = useRuntimeConfig();
    const isAdmin = user?.role === 'ADMIN';

    async function handleLogout() {
        await logout();
        message.success('已退出登录');
        navigate('/login', { replace: true });
    }

    return (
        <Layout style={styles.root}>
            <Header style={styles.header}>
                <Space size={16}>
                    <Link to="/" style={styles.brand}>
                        {config.appName}
                    </Link>
                </Space>

                {/* 间距和 extra 内部保持一致（8），否则嵌套 Space 会出现两档间距 */}
                <Space size={8}>
                    {extra}
                    <NotificationCenter />
                    <Dropdown
                        menu={{
                            items: [
                                ...(isAdmin
                                    ? [
                                          { key: 'admin', label: '管理后台' },
                                          { type: 'divider' as const },
                                      ]
                                    : []),
                                { key: 'logout', label: '退出登录', danger: true },
                            ],
                            onClick: ({ key }) => {
                                if (key === 'admin') navigate('/admin');
                                if (key === 'logout') void handleLogout();
                            },
                        }}
                    >
                        <Button type="text" style={styles.user}>
                            <Space size={8}>
                                <Avatar size="small" style={styles.avatar}>
                                    {(user?.displayName ?? user?.username ?? '?').slice(0, 1)}
                                </Avatar>
                                <Text style={{ color: '#fff' }}>
                                    {user?.displayName ?? user?.username}
                                </Text>
                            </Space>
                        </Button>
                    </Dropdown>
                </Space>
            </Header>
            {config.maintenance.enabled && (
                <Alert
                    banner
                    type="warning"
                    showIcon
                    message={config.maintenance.message}
                    style={{ borderRadius: 0 }}
                />
            )}
            <Content style={styles.content}>{children}</Content>
        </Layout>
    );
}

const styles = {
    root: {
        width: '100%',
        height: '100%',
    },
    header: {
        display: 'flex',
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
        height: 48,
        lineHeight: '48px',
        paddingInline: 20,
        background: '#1f2329',
    },
    brand: {
        color: '#fff',
        fontSize: 16,
        fontWeight: 600 as const,
        textDecoration: 'none',
    },
    user: {
        // 和顶栏其余操作一样高（32），否则头像/文字会被撑得比图标按钮大一圈
        height: 32,
        paddingInline: 8,
        color: '#fff',
    },
    avatar: {
        background: '#3370ff',
    },
    content: {
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
    },
};
