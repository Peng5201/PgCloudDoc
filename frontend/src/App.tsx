import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { App as AntApp, ConfigProvider, Spin } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AuthProvider } from './app/auth/AuthContext';
import { AuthGuard } from './app/auth/AuthGuard';
import { AdminGuard } from './app/auth/AdminGuard';
import { LoginPage } from './app/auth/LoginPage';
import { DocumentListPage } from './app/documents/DocumentListPage';
import { EditorPage } from './app/editor/EditorPage';
import { PluginHostProvider } from './app/plugins';

/**
 * 管理后台按需加载：只有管理员真的点进去才下载这份代码，
 * 不把 Table / Drawer / 编辑器这些组件塞进首屏 bundle。
 */
const AdminPage = lazy(() =>
    import('./app/admin/AdminPage').then((m) => ({ default: m.AdminPage }))
);

/**
 * 路由表。
 *
 *   /login      登录/注册（未登录也能进）
 *   /           文档列表（需登录）
 *   /docs/:id   编辑器（需登录，可深链、可刷新）
 *   /admin      配置中心（需登录 + ADMIN 角色）
 *
 * AntApp 放最外层：antd 的 message / modal 静态方法在 v5+ 会被警告，
 * 走 `App.useApp()` 拿到的实例才能正确跟主题、上下文（比如 RTL）联动。
 */
export default function App() {
    return (
        <ConfigProvider locale={zhCN}>
            <AntApp>
                <BrowserRouter>
                    <AuthProvider>
                        <PluginHostProvider>
                            <Routes>
                                <Route path="/login" element={<LoginPage />} />
                                <Route
                                    path="/"
                                    element={
                                        <AuthGuard>
                                            <DocumentListPage />
                                        </AuthGuard>
                                    }
                                />
                                <Route
                                    path="/docs/:id"
                                    element={
                                        <AuthGuard>
                                            <EditorPage />
                                        </AuthGuard>
                                    }
                                />
                                <Route
                                    path="/admin"
                                    element={
                                        <AuthGuard>
                                            <AdminGuard>
                                                <Suspense
                                                    fallback={
                                                        <div style={styles.center}>
                                                            <Spin
                                                                size="large"
                                                                tip="正在加载管理后台…"
                                                            />
                                                        </div>
                                                    }
                                                >
                                                    <AdminPage />
                                                </Suspense>
                                            </AdminGuard>
                                        </AuthGuard>
                                    }
                                />
                                <Route path="*" element={<Navigate to="/" replace />} />
                            </Routes>
                        </PluginHostProvider>
                    </AuthProvider>
                </BrowserRouter>
            </AntApp>
        </ConfigProvider>
    );
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
