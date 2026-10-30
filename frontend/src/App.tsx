import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AuthProvider } from './app/auth/AuthContext';
import { AuthGuard } from './app/auth/AuthGuard';
import { LoginPage } from './app/auth/LoginPage';
import { DocumentListPage } from './app/documents/DocumentListPage';
import { EditorPage } from './app/editor/EditorPage';

/**
 * 路由表。
 *
 *   /login      登录/注册（未登录也能进）
 *   /           文档列表（需登录）
 *   /docs/:id   编辑器（需登录，可深链、可刷新）
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
                            <Route path="*" element={<Navigate to="/" replace />} />
                        </Routes>
                    </AuthProvider>
                </BrowserRouter>
            </AntApp>
        </ConfigProvider>
    );
}
