/**
 * 登录态。
 *
 * token 本身放在 api/client.ts（它要被 fetch 层读到），
 * 这里只负责把「有没有登录 / 当前是谁」同步成 React 状态。
 *
 * 挂载时如果有 token 就拉一次 `/auth/me` 恢复用户信息 —— 刷新页面不该掉登录。
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from 'react';
import { authApi, type LoginInput, type RegisterInput, type User } from '../api/auth';
import {
    getAccessToken,
    isAbortError,
    setAccessToken,
    subscribeToken,
} from '../api/client';

export interface AuthContextValue {
    user: User | null;
    /** 首次恢复登录态时为 true，用来避免登录页闪一下 */
    loading: boolean;
    login: (input: LoginInput) => Promise<void>;
    register: (input: RegisterInput) => Promise<void>;
    logout: () => Promise<void>;
    refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);

    // 挂载时恢复登录态
    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;

        async function restore() {
            if (!getAccessToken()) {
                setLoading(false);
                return;
            }
            try {
                const me = await authApi.me(controller.signal);
                if (!cancelled) setUser(me);
            } catch (err) {
                // 主动取消不算「未登录」—— StrictMode 会立刻重跑，
                // 第一次的请求被 abort 是预期行为，不能因此把用户判成登出
                if (isAbortError(err) || cancelled) return;
                setUser(null);
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        void restore();
        return () => {
            // 先置标记再 abort：abort 触发的 rejection 是异步的，
            // 回调跑起来时 cancelled 一定已经是 true
            cancelled = true;
            controller.abort();
        };
    }, []);

    // 别处清掉 token（比如 401 刷新失败）时，这里也要跟着登出
    useEffect(
        () =>
            subscribeToken((token) => {
                if (!token) setUser(null);
            }),
        []
    );

    const login = useCallback(async (input: LoginInput) => {
        const result = await authApi.login(input);
        setUser(result.user);
    }, []);

    const register = useCallback(async (input: RegisterInput) => {
        const result = await authApi.register(input);
        setUser(result.user);
    }, []);

    const logout = useCallback(async () => {
        await authApi.logout();
        setAccessToken(null);
        setUser(null);
    }, []);

    const refreshUser = useCallback(async () => {
        setUser(await authApi.me());
    }, []);

    const value = useMemo(
        () => ({ user, loading, login, register, logout, refreshUser }),
        [user, loading, login, register, logout, refreshUser]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
    const context = useContext(AuthContext);
    if (!context) throw new Error('useAuth 必须在 AuthProvider 内使用');
    return context;
}
