/**
 * 插件模块加载。
 *
 * - 原生 ESM 动态 import，URL 来自索引（生产）或 Vite dev server（开发）；
 * - 同一插件在整个页面生命周期里只 import 一次；
 * - 10s 超时，失败后下次调用可重试；
 * - 样式通过 <link> 注入，停用时移除。
 */

import type { PluginModule } from '@pgclouddoc/plugin-api';
import type { DiscoveredPlugin } from './plugin-registry';
import { joinPluginUrl } from './url';

const LOAD_TIMEOUT_MS = 10_000;
const STYLE_ATTR = 'data-pgclouddoc-plugin-style';

const moduleCache = new Map<string, Promise<PluginModule>>();
let styleSeq = 0;

export function pluginModuleKey(plugin: DiscoveredPlugin): string {
  return `${plugin.id}@${plugin.version}:${plugin.baseUrl}`;
}

export async function loadPluginModule(plugin: DiscoveredPlugin): Promise<PluginModule> {
  const key = pluginModuleKey(plugin);
  const cached = moduleCache.get(key);
  if (cached) return cached;

  const promise = (async () => {
    const url = joinPluginUrl(plugin.baseUrl, plugin.entry);
    const imported = (await withTimeout(import(/* @vite-ignore */ url), LOAD_TIMEOUT_MS)) as
      | Partial<PluginModule>
      | undefined;

    if (!imported || typeof imported.activate !== 'function') {
      throw new Error(`插件 ${plugin.id} 的入口没有导出 activate(context)`);
    }
    return imported as PluginModule;
  })().catch((err: unknown) => {
    // 失败不缓存：用户点重试时应该能重新 import
    moduleCache.delete(key);
    throw err;
  });

  moduleCache.set(key, promise);
  return promise;
}

export function injectPluginStyle(plugin: DiscoveredPlugin): () => void {
  if (!plugin.style || typeof document === 'undefined') {
    return () => undefined;
  }

  const href = joinPluginUrl(plugin.baseUrl, plugin.style);
  const existing = document.querySelector<HTMLLinkElement>(`link[${STYLE_ATTR}="${plugin.id}"]`);
  if (existing) return () => existing.remove();

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.setAttribute(STYLE_ATTR, plugin.id);
  link.dataset.pgclouddocPluginStyleSeq = String(++styleSeq);
  document.head.appendChild(link);

  return () => {
    link.remove();
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`插件加载超时（${ms}ms）`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
