/**
 * 管理后台路由守卫。
 *
 * 只负责「体验层」的拦截：真正的权限校验在后端 AdminGuard（按库里的 role）。
 * 前端就算被绕过，接口依然会返回 403。
 */

import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { Spin } from 'antd';
import { useAuth } from './AuthContext';

export function AdminGuard({ children }: { children: ReactNode }) {
    const { user, loading } = useAuth();

    if (loading) {
        return (
            <div style={styles.center}>
                <Spin size="large" tip="正在校验权限…" />
            </div>
        );
    }

    if (!user) return <Navigate to="/login" replace />;
    if (user.role !== 'ADMIN') return <Navigate to="/" replace />;

    return <>{children}</>;
}

const styles = {
    center: {
        display: 'flex',
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        width: '100%',
        height: '100%',
    },
};
