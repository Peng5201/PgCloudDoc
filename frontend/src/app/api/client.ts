/**
 * HTTP 客户端 —— 所有 REST 调用的唯一入口。
 *
 * 三件事：
 *   1. **统一信封**：后端返回 `{ success, data | code/message, requestId }`，
 *      这里解成 `data` 或抛 `ApiError`，业务代码不用每次判字段
 *   2. **注入 access token**：从 localStorage 取，放 Authorization 头
 *   3. **401 自动刷新并重放一次**：access token 只有 15 分钟，
 *      不能每隔 15 分钟就把用户踢回登录页。refresh token 在 httpOnly cookie 里，
 *      fetch 带上 credentials 就会自动送上去
 *
 * 重放**只做一次**：刷新本身就可能失败（refresh 也过期/被重放检测吊销），
 * 再重试就成死循环了。
 */

export interface ApiSuccessBody<T> {
    success: true;
    data: T;
    requestId: string;
}

export interface ApiFailureBody {
    success: false;
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
}

export type ApiBody<T> = ApiSuccessBody<T> | ApiFailureBody;

/**
 * 请求是否被主动取消（AbortController.abort()）。
 *
 * 取消不是失败 —— 不能被当成「未登录」或「出错了」处理。
 * 浏览器和 Node 的实现对这个错误的形态略有不同，这里做宽松判断。
 */
export function isAbortError(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        (err as { name?: string }).name === 'AbortError'
    );
}

/** 统一错误对象，业务层按 `code` 分支 */
export class ApiError extends Error {    readonly code: string;
    readonly status: number;
    readonly details?: unknown;
    readonly requestId?: string;

    constructor(
        code: string,
        message: string,
        status: number,
        options: { details?: unknown; requestId?: string } = {}
    ) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
        this.status = status;
        this.details = options.details;
        this.requestId = options.requestId;
    }

    /** 登录态失效 —— 调用方据此跳登录页 */
    get isUnauthorized(): boolean {
        return this.status === 401;
    }
}

// ─────────────────────────── token 存储 ───────────────────────────

const TOKEN_KEY = 'pgclouddoc.access_token';

let accessToken: string | null = localStorage.getItem(TOKEN_KEY);
/** token 变化时通知订阅者（AuthContext 用它同步 React 状态） */
const tokenListeners = new Set<(token: string | null) => void>();

export function getAccessToken(): string | null {
    return accessToken;
}

export function setAccessToken(token: string | null): void {
    accessToken = token;
    if (token) {
        localStorage.setItem(TOKEN_KEY, token);
    } else {
        localStorage.removeItem(TOKEN_KEY);
    }
    for (const listener of tokenListeners) listener(token);
}

export function subscribeToken(listener: (token: string | null) => void): () => void {
    tokenListeners.add(listener);
    return () => tokenListeners.delete(listener);
}

// ─────────────────────────── 请求 ───────────────────────────

export interface RequestOptions {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
    body?: unknown;
    headers?: Record<string, string>;
    /** 跳过 401 自动刷新（刷新请求本身用，否则会递归） */
    skipAuthRefresh?: boolean;
    /** 需要原始响应（下载快照文件等） */
    raw?: boolean;
    signal?: AbortSignal;
}

/**
 * 发请求。
 *
 * 带 `raw: true` 时不解析信封、不抛业务错误，返回原生 Response ——
 * 给「导出快照文件」这种要自己处理 body 的场景用。
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, headers = {}, skipAuthRefresh = false, raw = false, signal } = options;

    const finalHeaders: Record<string, string> = { ...headers };
    // body 是 FormData / Blob 时让浏览器自己带 boundary，不要手动设 Content-Type
    if (body !== undefined && !(body instanceof FormData) && !finalHeaders['Content-Type']) {
        finalHeaders['Content-Type'] = 'application/json';
    }
    const token = getAccessToken();
    if (token) finalHeaders.Authorization = `Bearer ${token}`;

    const response = await fetch(path, {
        method,
        headers: finalHeaders,
        // 必须带，refresh token 在 httpOnly cookie 里
        credentials: 'include',
        body:
            body === undefined
                ? undefined
                : body instanceof FormData
                  ? body
                  : JSON.stringify(body),
        signal,
    });

    if (raw) {
        return response as unknown as T;
    }

    // 401：先试着换一对 token，再把原请求重放一次
    if (response.status === 401 && !skipAuthRefresh && getAccessToken()) {
        const refreshed = await tryRefresh();
        if (refreshed) {
            return request<T>(path, { ...options, skipAuthRefresh: true });
        }
        // 刷新失败 = 登录态真的没了，清掉 token 让 AuthContext 跳登录
        setAccessToken(null);
    }

    return unwrap<T>(response);
}

/** 解信封。2xx 但 success=false 也按错误处理 */
async function unwrap<T>(response: Response): Promise<T> {
    const text = await response.text();
    let body: ApiBody<T> | null = null;
    try {
        body = text ? (JSON.parse(text) as ApiBody<T>) : null;
    } catch {
        throw new ApiError('BAD_RESPONSE', '响应不是合法 JSON', response.status);
    }

    if (body && body.success) return body.data;

    const failure = body as ApiFailureBody | null;
    throw new ApiError(
        failure?.code ?? `HTTP_${response.status}`,
        failure?.message ?? `请求失败（${response.status}）`,
        response.status,
        { details: failure?.details, requestId: failure?.requestId }
    );
}

/**
 * 主动刷新 access token。
 *
 * WebSocket 用它：连接被服务端以 4001（登录失效）关掉时，先刷一次 token，
 * 下一次重连才能带上有效的凭证，而不是拿旧 token 一直重试。
 */
export function refreshAccessToken(): Promise<boolean> {
    return tryRefresh();
}

/**
 * 用 refresh cookie 换一对新 token。
 * 返回是否成功；失败不抛错 —— 调用方只关心「能不能继续」。
 */
let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
    // 并发多个请求同时 401 时只刷一次，避免互相把对方的 refresh 顶掉
    // （后端的轮换机制会把「已撤销的 token 又用一次」判为重放攻击）
    if (refreshing) return refreshing;

    refreshing = (async () => {
        try {
            const response = await fetch('/api/v1/auth/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: '{}',
            });
            if (!response.ok) return false;
            const body = (await response.json()) as ApiBody<{ accessToken: string }>;
            if (!body.success) return false;
            setAccessToken(body.data.accessToken);
            return true;
        } catch {
            return false;
        } finally {
            // 允许下次再刷
            refreshing = null;
        }
    })();

    return refreshing;
}

export const api = {
    get: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'GET' }),
    post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
        request<T>(path, { ...options, method: 'POST', body }),
    patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
        request<T>(path, { ...options, method: 'PATCH', body }),
    put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
        request<T>(path, { ...options, method: 'PUT', body }),
    delete: <T>(path: string, options?: RequestOptions) =>
        request<T>(path, { ...options, method: 'DELETE' }),
};
