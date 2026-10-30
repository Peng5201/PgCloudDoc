/**
 * 认证相关 API。
 * 字段名与后端 `backend/src/modules/auth/dto/auth.dto.ts` 一一对应。
 */

import { api, setAccessToken } from './client';

export interface User {
    id: string;
    email: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    createdAt: string;
}

export interface AuthResult {
    user: User;
    accessToken: string;
    expiresInSeconds: number;
    refreshToken: string;
}

export interface RegisterInput {
    email: string;
    username: string;
    password: string;
    displayName?: string;
}

export interface LoginInput {
    /** 邮箱或用户名 */
    identifier: string;
    password: string;
}

/**
 * 登录/注册成功后把 access token 存起来。
 *
 * refresh token 不在这里处理 —— 它是 httpOnly cookie，
 * JS 根本读不到（这正是它的价值），fetch 带上 credentials 就会自动带上。
 */
function adopt(result: AuthResult): AuthResult {
    setAccessToken(result.accessToken);
    return result;
}

export const authApi = {
    async register(input: RegisterInput): Promise<AuthResult> {
        return adopt(await api.post<AuthResult>('/api/v1/auth/register', input));
    },

    async login(input: LoginInput): Promise<AuthResult> {
        return adopt(await api.post<AuthResult>('/api/v1/auth/login', input));
    },

    async logout(): Promise<void> {
        try {
            await api.post<{ loggedOut: true }>('/api/v1/auth/logout');
        } finally {
            // 不管后端有没有成功，本地登录态都清掉
            setAccessToken(null);
        }
    },

    me(signal?: AbortSignal): Promise<User> {
        return api.get<User>('/api/v1/auth/me', { signal });
    },

    changePassword(currentPassword: string, newPassword: string): Promise<{ changed: true }> {
        return api.post<{ changed: true }>('/api/v1/auth/change-password', {
            currentPassword,
            newPassword,
        });
    },

    updateProfile(input: { displayName?: string; avatarUrl?: string }): Promise<User> {
        return api.post<User>('/api/v1/auth/profile', input);
    },
};
