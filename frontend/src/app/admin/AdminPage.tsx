/**
 * 管理后台外壳。
 *
 * 插件管理与配置中心放在同一个页面的 Tabs 里；两个内容组件都以内嵌模式渲染，
 * 避免重复套 AppLayout / 双重页边距。
 */

import { useState } from 'react';
import { Tabs, Typography } from 'antd';
import { AppLayout } from '../../shared/AppLayout';
import { AdminConfigPage } from './AdminConfigPage';
import { AdminPluginsPage } from './AdminPluginsPage';

const { Text, Title } = Typography;

type AdminTab = 'plugins' | 'config';

export function AdminPage() {
    // 默认落在插件管理：这是管理员进入后台最常做的事
    const [tab, setTab] = useState<AdminTab>('plugins');

    return (
        <AppLayout>
            <div style={styles.page}>
                <div style={styles.header}>
                    <Title level={4} style={{ margin: 0 }}>
                        管理后台
                    </Title>
                    <Text type="secondary">插件上传与启用、运行时配置</Text>
                </div>

                <Tabs
                    activeKey={tab}
                    onChange={(key) => setTab(key as AdminTab)}
                    items={[
                        {
                            key: 'plugins',
                            label: '插件管理',
                            children: <AdminPluginsPage />,
                        },
                        {
                            key: 'config',
                            label: '配置中心',
                            children: <AdminConfigPage embedded />,
                        },
                    ]}
                />
            </div>
        </AppLayout>
    );
}

const styles = {
    page: {
        maxWidth: 1200,
        margin: '0 auto',
        padding: '20px 24px 48px',
    },
    header: {
        display: 'flex',
        alignItems: 'baseline' as const,
        gap: 12,
        marginBottom: 8,
    },
};
