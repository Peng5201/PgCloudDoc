/**
 * 路由守卫。
 *
 * 三种状态：
 *   - 恢复登录态中 → 转圈，不要闪一下登录页
 *   - 未登录       → 重定向到 /login，并记下来源页，登录后跳回去
 *   - 已登录       → 正常渲染
 */

import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { useAuth } from './AuthContext';

export function AuthGuard({ children }: { children: ReactNode }) {
    const { user, loading } = useAuth();
    const location = useLocation();

    if (loading) {
        return (
            <div style={styles.center}>
                <Spin size="large" tip="正在恢复登录态…" />
            </div>
        );
    }

    if (!user) {
        // 记下要回哪儿去，登录成功后跳回
        return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
    }

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
