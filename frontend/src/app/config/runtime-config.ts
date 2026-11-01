/**
 * 运行时配置（首屏前加载）。
 *
 * 配置的真源在 etcd，浏览器不能也不应该直连它 —— 这里请求的是后端代理出来的
 * `GET /api/v1/config`（只包含 client scope 的白名单配置）。
 *
 * 加载时机：`main.tsx` 在 `createRoot(...).render(...)` **之前** await 它，
 * 保证首屏渲染时配置已经就绪，不需要先渲染再闪一下改主题/标题。
 *
 * 三条约束：
 *   1. 不能把启动卡死：1.5s 超时后走本地缓存 / 内置默认值；
 *   2. 不能因为配置服务挂了白屏：任何异常都降级，页面必须能打开；
 *   3. 已知字段做类型校验，非法值退回默认值，不让脏配置把界面搞坏。
 */

export type RuntimeConfigSource = 'server' | 'cache' | 'default';

export interface RuntimeConfig {
    /** 品牌名 / 页面标题 */
    appName: string;
    maintenance: {
        enabled: boolean;
        message: string;
    };
    /** features.xxx = true/false，从扁平 key 归并出来 */
    features: Record<string, boolean>;
    /**
     * 服务端下发的全部值（扁平 key，例如 `ui.theme`）。
     * 已知字段之外的自定义项从这里取，方便后续功能直接消费。
     */
    values: Record<string, unknown>;
    /** etcd 全局 revision */
    version: number;
    updatedAt: string | null;
    /** 这份配置从哪来：服务端 / 上次成功的缓存 / 内置默认值 */
    source: RuntimeConfigSource;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
    appName: 'PgCloudDoc',
    maintenance: {
        enabled: false,
        message: '系统维护中，请稍后再试',
    },
    features: {},
    values: {},
    version: 0,
    updatedAt: null,
    source: 'default',
};

const CONFIG_ENDPOINT = '/api/v1/config';
const FETCH_TIMEOUT_MS = 1500;
const CACHE_KEY = 'pgclouddoc.runtime_config.v1';

let current: RuntimeConfig = DEFAULT_RUNTIME_CONFIG;

/** 加载完成后由 main.tsx 调用一次 */
export function initRuntimeConfig(config: RuntimeConfig): void {
    current = config;
}

export function getRuntimeConfig(): RuntimeConfig {
    return current;
}

/** React 侧读取入口。配置在渲染前就固定了，不需要订阅变化 */
export function useRuntimeConfig(): RuntimeConfig {
    return current;
}

/**
 * 首屏前加载配置。
 *
 * 顺序：网络（1.5s 超时）→ 本地缓存 → 内置默认值。
 * 网络成功会覆盖缓存；失败时用缓存保证刷新页面后仍是上一次的配置。
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
    try {
        const payload = await fetchPublicConfig();
        const config = deserializeRuntimeConfig(payload);
        writeCache(config);
        return config;
    } catch (err) {
        if (typeof console !== 'undefined') {
            console.warn('[config] 运行时配置加载失败，使用兜底配置', err);
        }
        const cached = readCache();
        if (cached) return cached;
        return { ...DEFAULT_RUNTIME_CONFIG, values: {}, features: {}, maintenance: { ...DEFAULT_RUNTIME_CONFIG.maintenance } };
    }
}

/**
 * 反序列化：把后端返回的 JSON 变成带默认值和类型保证的 RuntimeConfig。
 *
 * 单独导出是为了可测 —— 脏数据、缺字段、类型不对都必须能安全降级。
 */
export function deserializeRuntimeConfig(payload: unknown): RuntimeConfig {
    const source = isRecord(payload) ? payload : {};
    const values = isRecord(source.values) ? source.values : {};

    const features: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(values)) {
        if (!key.startsWith('features.')) continue;
        if (typeof value !== 'boolean') continue;
        features[key.slice('features.'.length)] = value;
    }

    return {
        appName: asNonEmptyString(values['app.name']) ?? DEFAULT_RUNTIME_CONFIG.appName,
        maintenance: {
            enabled: values['maintenance.enabled'] === true,
            message:
                asNonEmptyString(values['maintenance.message']) ??
                DEFAULT_RUNTIME_CONFIG.maintenance.message,
        },
        features,
        values,
        version: typeof source.version === 'number' ? source.version : 0,
        updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
        source: 'server',
    };
}

// ─────────────────────────── 网络 / 缓存 ───────────────────────────

async function fetchPublicConfig(): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(CONFIG_ENDPOINT, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const body = (await response.json()) as unknown;
        // 后端统一信封 { success, data }；这里兼容直接返回裸数据的情况
        if (isRecord(body) && body.success === true && 'data' in body) return body.data;
        return body;
    } finally {
        clearTimeout(timer);
    }
}

function readCache(): RuntimeConfig | null {
    try {
        if (typeof localStorage === 'undefined') return null;
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        const config = deserializeRuntimeConfig(parsed);
        return { ...config, source: 'cache' };
    } catch {
        return null;
    }
}

function writeCache(config: RuntimeConfig): void {
    try {
        if (typeof localStorage === 'undefined') return;
        // source 是运行期信息，不进缓存
        const { source: _source, ...persisted } = config;
        localStorage.setItem(CACHE_KEY, JSON.stringify(persisted));
    } catch {
        // 隐私模式 / 配额满：缓存失败不影响主流程
    }
}

// ─────────────────────────── 工具 ───────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}
