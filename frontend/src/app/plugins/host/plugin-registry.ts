/**
 * 插件发现。
 *
 * 生产：GET /api/v1/plugins/index（P1 后端提供），ETag 由 HTTP 层协商；
 *       失败时回退到 24h 内的本地缓存，避免插件服务抖动导致编辑器不可用。
 * 开发：localStorage["pgclouddoc.plugin-dev"] 配置的 Vite dev server，
 *       从 /plugin.dev.json 拉 manifest，直接 import /src/index.ts。
 *
 * 启动只拿 manifest，不下载插件代码 —— 代码在命中 activation event 时才加载。
 */

import type { PluginIndex, PluginIndexEntry } from '@pgclouddoc/plugin-api';
import { satisfiesVersionRange } from '@pgclouddoc/plugin-api/semver';
import { ApiError, request } from '../../api/client';
import { HOST_VERSION } from './host-version';

const INDEX_ENDPOINT = '/api/v1/plugins/index';
const CACHE_KEY = 'pgclouddoc.plugin_index.v1';
const DEV_CONFIG_KEY = 'pgclouddoc.plugin-dev';
const FETCH_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SUPPORTED_PLUGIN_API = '1';

export type PluginSource = 'server' | 'dev';

export interface DiscoveredPlugin extends PluginIndexEntry {
  source: PluginSource;
}

interface CachedIndex {
  savedAt: number;
  plugins: PluginIndexEntry[];
}

interface DevPluginConfigEntry {
  baseUrl?: string;
}

export async function loadDiscoveredPlugins(): Promise<DiscoveredPlugin[]> {
  const server = await loadServerPlugins();
  const dev = import.meta.env.DEV ? await loadDevPlugins() : [];

  // 同 id 时开发配置覆盖服务端，方便本地调试已上架的插件
  const byId = new Map<string, DiscoveredPlugin>();
  for (const plugin of server) byId.set(plugin.id, { ...plugin, source: 'server' });
  for (const plugin of dev) byId.set(plugin.id, plugin);

  const compatible: DiscoveredPlugin[] = [];
  for (const plugin of byId.values()) {
    if (isCompatible(plugin)) compatible.push(plugin);
    else console.info(`[plugins] 跳过不兼容插件 ${plugin.id}@${plugin.version}`, plugin.engines);
  }
  return compatible;
}

async function loadServerPlugins(): Promise<PluginIndexEntry[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const index = await request<PluginIndex>(INDEX_ENDPOINT, { signal: controller.signal });
    if (!index || index.killSwitch) return [];

    const plugins: PluginIndexEntry[] = [];
    for (const raw of index.plugins ?? []) {
      const normalized = normalizeEntry(raw);
      if (normalized) plugins.push(normalized);
    }
    writeCache(plugins);
    return plugins;
  } catch (err) {
    // P1 之前后端还没有索引接口：404 属于预期，不刷告警
    if (err instanceof ApiError && err.status === 404) {
      return readCache();
    }
    console.warn('[plugins] 插件索引加载失败，尝试本地缓存', err);
    return readCache();
  } finally {
    clearTimeout(timer);
  }
}

function isCompatible(plugin: DiscoveredPlugin): boolean {
  if (plugin.engines.pluginApi !== SUPPORTED_PLUGIN_API) return false;
  return satisfiesVersionRange(HOST_VERSION, plugin.engines.pgclouddoc);
}

function normalizeEntry(raw: PluginIndexEntry): PluginIndexEntry | null {
  if (
    !raw ||
    typeof raw !== 'object' ||
    typeof raw.id !== 'string' ||
    typeof raw.version !== 'string' ||
    typeof raw.baseUrl !== 'string' ||
    typeof raw.entry !== 'string'
  ) {
    return null;
  }

  const engines = raw.engines && typeof raw.engines === 'object' ? raw.engines : undefined;
  return {
    ...raw,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    engines: {
      pgclouddoc:
        engines && typeof engines.pgclouddoc === 'string' ? engines.pgclouddoc : '*',
      pluginApi:
        engines && typeof engines.pluginApi === 'string' ? engines.pluginApi : SUPPORTED_PLUGIN_API,
    },
    activationEvents: Array.isArray(raw.activationEvents)
      ? raw.activationEvents.filter((event): event is string => typeof event === 'string')
      : [],
    permissions: Array.isArray(raw.permissions) ? raw.permissions : [],
    settings:
      raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)
        ? raw.settings
        : {},
  };
}

// ─────────────────────────── 开发模式 ───────────────────────────

async function loadDevPlugins(): Promise<DiscoveredPlugin[]> {
  const raw = readDevConfig();
  if (!raw) return [];

  let config: Record<string, string | DevPluginConfigEntry>;
  try {
    config = JSON.parse(raw) as Record<string, string | DevPluginConfigEntry>;
  } catch (err) {
    console.warn('[plugins] 开发插件配置不是合法 JSON', err);
    return [];
  }

  const plugins: DiscoveredPlugin[] = [];
  for (const [id, value] of Object.entries(config)) {
    const baseUrlRaw = typeof value === 'string' ? value : value?.baseUrl;
    if (!baseUrlRaw) continue;
    const baseUrl = normalizeBaseUrl(baseUrlRaw);

    try {
      const manifest = await fetchJson<Record<string, unknown>>(`${baseUrl}plugin.dev.json`);
      const entry = toDevEntry(id, baseUrl, manifest);
      if (entry) {
        plugins.push(entry);
        console.info(`[plugins] 已发现开发插件 ${entry.id}@${entry.version}`, baseUrl);
      }
    } catch (err) {
      console.warn(`[plugins] 开发插件 ${id} 加载失败`, err);
    }
  }
  return plugins;
}

function toDevEntry(
  expectedId: string,
  baseUrl: string,
  raw: Record<string, unknown>
): DiscoveredPlugin | null {
  const manifest = raw as {
    id?: unknown;
    version?: unknown;
    entry?: unknown;
    engines?: { pgclouddoc?: unknown; pluginApi?: unknown };
    activationEvents?: unknown;
    contributes?: PluginIndexEntry['contributes'];
    permissions?: PluginIndexEntry['permissions'];
    settings?: unknown[];
  };

  if (
    typeof manifest.id !== 'string' ||
    typeof manifest.version !== 'string' ||
    typeof manifest.entry !== 'string' ||
    !manifest.engines ||
    typeof manifest.engines !== 'object'
  ) {
    console.warn(`[plugins] 开发插件 ${expectedId} 的 manifest 缺少必填字段`);
    return null;
  }

  if (manifest.id !== expectedId) {
    console.warn(`[plugins] 开发配置里的 id (${expectedId}) 与 manifest.id (${manifest.id}) 不一致`);
  }

  return {
    id: manifest.id,
    version: manifest.version,
    baseUrl,
    entry: manifest.entry,
    // 开发态样式由 Vite 注入，不加载 dist 里的 CSS
    style: undefined,
    engines: {
      pgclouddoc:
        typeof manifest.engines.pgclouddoc === 'string' ? manifest.engines.pgclouddoc : '*',
      pluginApi:
        typeof manifest.engines.pluginApi === 'string'
          ? manifest.engines.pluginApi
          : SUPPORTED_PLUGIN_API,
    },
    activationEvents: Array.isArray(manifest.activationEvents)
      ? manifest.activationEvents.filter((event): event is string => typeof event === 'string')
      : [],
    contributes: manifest.contributes,
    permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
    settings: settingsDefaults(manifest.settings),
    source: 'dev',
  };
}

function settingsDefaults(settings: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(settings)) return out;
  for (const setting of settings) {
    if (!setting || typeof setting !== 'object') continue;
    const candidate = setting as { key?: unknown; default?: unknown };
    if (typeof candidate.key === 'string' && candidate.default !== undefined) {
      out[candidate.key] = candidate.default;
    }
  }
  return out;
}

function readDevConfig(): string | null {
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(DEV_CONFIG_KEY);
    if (stored) return stored;
  }
  const fromEnv = import.meta.env.VITE_PLUGIN_DEV;
  return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv : null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────── 缓存 ───────────────────────────

function readCache(): PluginIndexEntry[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<CachedIndex>;
    if (typeof parsed.savedAt !== 'number' || !Array.isArray(parsed.plugins)) return [];
    if (Date.now() - parsed.savedAt > CACHE_TTL_MS) return [];

    const plugins: PluginIndexEntry[] = [];
    for (const entry of parsed.plugins) {
      const normalized = normalizeEntry(entry);
      if (normalized) plugins.push(normalized);
    }
    return plugins;
  } catch {
    return [];
  }
}

function writeCache(plugins: PluginIndexEntry[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const payload: CachedIndex = { savedAt: Date.now(), plugins };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // 隐私模式 / 配额满：缓存失败不影响插件加载
  }
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}
