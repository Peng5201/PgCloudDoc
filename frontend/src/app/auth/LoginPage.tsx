/**
 * 登录 / 注册。
 *
 * 两件事放同一页（tab 切换）：注册是低频动作，单开一页浪费一次跳转。
 * 校验规则与后端 DTO 严格一致，前端先挡一道，省一次往返：
 *   密码 8-72 位，至少含一个字母和一个数字（后端 RegisterDto）
 *   用户名 3-32 位，字母数字下划线（后端 USERNAME_RULE）
 */

import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, Tabs, Typography, message } from 'antd';
import { useAuth } from './AuthContext';
import { ApiError } from '../api/client';

const { Title, Text } = Typography;

type Mode = 'login' | 'register';

const PASSWORD_RULES = [
    { required: true, message: '请输入密码' },
    { min: 8, message: '密码至少 8 位' },
    { max: 72, message: '密码最多 72 位' },
    {
        pattern: /^(?=.*[A-Za-z])(?=.*\d).+$/,
        message: '密码需同时包含字母和数字',
    },
];

const USERNAME_RULES = [
    { required: true, message: '请输入用户名' },
    {
        pattern: /^[a-zA-Z0-9_]{3,32}$/,
        message: '用户名只能包含字母、数字、下划线，长度 3-32',
    },
];

export function LoginPage() {
    const { login, register } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();

    const [mode, setMode] = useState<Mode>('login');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const from = (location.state as { from?: string } | null)?.from ?? '/';

    async function handleSubmit(values: Record<string, string>) {
        setSubmitting(true);
        setError(null);
        try {
            if (mode === 'login') {
                await login({ identifier: values.identifier, password: values.password });
            } else {
                await register({
                    email: values.email,
                    username: values.username,
                    password: values.password,
                    displayName: values.displayName || undefined,
                });
            }
            message.success(mode === 'login' ? '登录成功' : '注册成功');
            navigate(from, { replace: true });
        } catch (err) {
            // 后端的错误码是稳定契约，直接显示给用户是有意义的
            setError(err instanceof ApiError ? err.message : '操作失败，请稍后重试');
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div style={styles.page}>
            <Card style={styles.card}>
                <div style={styles.header}>
                    <Title level={3} style={{ margin: 0 }}>
                        PgCloudDoc
                    </Title>
                    <Text type="secondary">协同电子表格</Text>
                </div>

                <Tabs
                    activeKey={mode}
                    onChange={(key) => {
                        setMode(key as Mode);
                        setError(null);
                    }}
                    centered
                    items={[
                        { key: 'login', label: '登录' },
                        { key: 'register', label: '注册' },
                    ]}
                />

                {error && (
                    <Alert
                        type="error"
                        message={error}
                        showIcon
                        style={{ marginBottom: 16 }}
                        closable
                        onClose={() => setError(null)}
                    />
                )}

                <Form
                    key={mode}
                    layout="vertical"
                    onFinish={handleSubmit}
                    disabled={submitting}
                    requiredMark={false}
                >
                    {mode === 'register' ? (
                        <>
                            <Form.Item
                                label="邮箱"
                                name="email"
                                rules={[
                                    { required: true, message: '请输入邮箱' },
                                    { type: 'email', message: '邮箱格式不正确' },
                                ]}
                            >
                                <Input placeholder="you@example.com" autoComplete="email" />
                            </Form.Item>
                            <Form.Item label="用户名" name="username" rules={USERNAME_RULES}>
                                <Input placeholder="字母、数字、下划线" autoComplete="username" />
                            </Form.Item>
                            <Form.Item label="昵称（可选）" name="displayName">
                                <Input placeholder="显示在协作者列表里" maxLength={64} />
                            </Form.Item>
                        </>
                    ) : (
                        <Form.Item
                            label="邮箱或用户名"
                            name="identifier"
                            rules={[{ required: true, message: '请输入邮箱或用户名' }]}
                        >
                            <Input placeholder="you@example.com" autoComplete="username" />
                        </Form.Item>
                    )}

                    <Form.Item label="密码" name="password" rules={PASSWORD_RULES}>
                        <Input.Password
                            placeholder="8-72 位，含字母和数字"
                            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                        />
                    </Form.Item>

                    <Button type="primary" htmlType="submit" block loading={submitting}>
                        {mode === 'login' ? '登录' : '注册并进入'}
                    </Button>
                </Form>
            </Card>
        </div>
    );
}

const styles = {
    page: {
        display: 'flex',
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        width: '100%',
        height: '100%',
        padding: 24,
        background: '#f5f6f7',
    },
    card: {
        width: 400,
        maxWidth: '100%',
    },
    header: {
        textAlign: 'center' as const,
        marginBottom: 8,
    },
};
