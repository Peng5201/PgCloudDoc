/**
 * 应用外框：顶栏 + 内容区。
 * 顶栏放「回到文档列表 / 当前用户 / 退出」，文档列表和编辑器共用。
 */

import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Avatar, Button, Dropdown, Layout, Space, Typography, message } from 'antd';
import { useAuth } from '../app/auth/AuthContext';

const { Header, Content } = Layout;
const { Text } = Typography;

export interface AppLayoutProps {
    children: ReactNode;
    /** 顶栏右侧的额外操作（编辑器的保存/版本按钮放这里） */
    extra?: ReactNode;
    /** 是否隐藏「文档列表」链接（就在列表页时） */
    hideHomeLink?: boolean;
}

export function AppLayout({ children, extra, hideHomeLink }: AppLayoutProps) {
    const { user, logout } = useAuth();
    const navigate = useNavigate();

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
                        PgCloudDoc
                    </Link>
                    {!hideHomeLink && (
                        <Link to="/" style={styles.link}>
                            文档列表
                        </Link>
                    )}
                </Space>

                <Space size={12}>
                    {extra}
                    <Dropdown
                        menu={{
                            items: [
                                { key: 'logout', label: '退出登录', danger: true },
                            ],
                            onClick: ({ key }) => {
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
    link: {
        color: 'rgba(255,255,255,0.72)',
        textDecoration: 'none',
    },
    user: {
        height: 40,
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
