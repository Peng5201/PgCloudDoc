/**
 * PluginContext 的构造。
 *
 * 这里是"宿主交给插件的能力面"：commands / documents / ui / settings / storage。
 * 所有注册都自动进入 context.subscriptions，插件忘记 push 也不会泄漏。
 */

import type {
  CommandHandler,
  Disposable,
  DocumentHub,
  MessageLevel,
  PluginContext,
  PluginPermission,
  SettingsApi,
  StorageApi,
  UiApi,
} from '@pgclouddoc/plugin-api';
import { PluginApiError } from '@pgclouddoc/plugin-api/errors';
import {
  COMMAND_ID_PATTERN,
  MENU_IDS,
  PLUGIN_API_VERSION,
  STATUS_BAR_SLOTS,
  TOOLBAR_SLOTS,
} from '@pgclouddoc/plugin-api/constants';
import type { DiscoveredPlugin } from '../host/plugin-registry';
import type { PluginUiStore } from '../host/ui-store';
import { joinPluginUrl } from '../host/url';

const STORAGE_LIMIT_BYTES = 1024 * 1024;

export interface PluginContextDeps {
  plugin: DiscoveredPlugin;
  userId: string;
  hostVersion: string;
  documents: DocumentHub;
  uiStore: PluginUiStore;
  registerCommand(pluginId: string, commandId: string, handler: CommandHandler): Disposable;
  executeCommand(pluginId: string, commandId: string, ...args: unknown[]): Promise<unknown>;
  notify(level: MessageLevel, message: string): void;
  onError(pluginId: string, error: unknown, context: string): void;
}

export function createPluginContext(deps: PluginContextDeps): PluginContext {
  const { plugin } = deps;
  const permissions = new Set<PluginPermission>(plugin.permissions);
  const subscriptions: Disposable[] = [];
  let autoId = 0;

  const track = (disposable: Disposable): Disposable => {
    subscriptions.push(disposable);
    return disposable;
  };

  const logger = {
    debug: (message: string, ...args: unknown[]) => console.debug(`[plugin:${plugin.id}]`, message, ...args),
    info: (message: string, ...args: unknown[]) => console.info(`[plugin:${plugin.id}]`, message, ...args),
    warn: (message: string, ...args: unknown[]) => console.warn(`[plugin:${plugin.id}]`, message, ...args),
    error: (message: string, ...args: unknown[]) => console.error(`[plugin:${plugin.id}]`, message, ...args),
  };

  const commands = {
    register(id: string, handler: CommandHandler): Disposable {
      if (!COMMAND_ID_PATTERN.test(id)) {
        throw new PluginApiError('E_PLUGIN_INVALID_INPUT', `命令 id 不合法：${id}`);
      }
      if (typeof handler !== 'function') {
        throw new PluginApiError('E_PLUGIN_INVALID_INPUT', `命令 ${id} 的 handler 不是函数`);
      }
      return track(deps.registerCommand(plugin.id, id, handler));
    },
    execute<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
      return deps.executeCommand(plugin.id, id, ...args) as Promise<T>;
    },
  };

  const resolveItemId = (id: string | undefined, fallbackPrefix: string): string => {
    const stable = id?.trim() || `${fallbackPrefix}-${++autoId}`;
    return `${plugin.id}:${stable}`;
  };

  const resolveIcon = (icon: string | undefined): string | undefined =>
    icon ? joinPluginUrl(plugin.baseUrl, icon) : undefined;

  const resolveRun = (item: { command?: string; onClick?: () => void | Promise<void> }) => {
    if (item.command) {
      return async () => {
        await deps.executeCommand(plugin.id, item.command!);
      };
    }
    if (item.onClick) return item.onClick;
    throw new PluginApiError('E_PLUGIN_INVALID_INPUT', 'UI 项必须提供 command 或 onClick');
  };

  const ui: UiApi = {
    registerToolbarItem(item) {
      if (!TOOLBAR_SLOTS.includes(item.slot)) {
        throw new PluginApiError('E_PLUGIN_INVALID_INPUT', `未知插槽：${String(item.slot)}`);
      }
      if (!item.title?.trim()) {
        throw new PluginApiError('E_PLUGIN_INVALID_INPUT', 'UI 项的 title 不能为空');
      }
      return track(
        deps.uiStore.addToolbar({
          id: resolveItemId(item.id, 'toolbar'),
          pluginId: plugin.id,
          slot: item.slot,
          title: item.title,
          iconUrl: resolveIcon(item.icon),
          order: item.order ?? 100,
          requiresWrite: item.requiresWrite ?? false,
          command: item.command,
          run: resolveRun(item),
        })
      );
    },

    registerStatusBarItem(item) {
      if (!STATUS_BAR_SLOTS.includes(item.slot)) {
        throw new PluginApiError('E_PLUGIN_INVALID_INPUT', `未知插槽：${String(item.slot)}`);
      }
      if (!item.title?.trim()) {
        throw new PluginApiError('E_PLUGIN_INVALID_INPUT', 'UI 项的 title 不能为空');
      }
      return track(
        deps.uiStore.addStatusBar({
          id: resolveItemId(item.id, 'status'),
          pluginId: plugin.id,
          slot: item.slot,
          title: item.title,
          iconUrl: resolveIcon(item.icon),
          order: item.order ?? 100,
          requiresWrite: item.requiresWrite ?? false,
          command: item.command,
          run: resolveRun(item),
        })
      );
    },

    registerMenuItem(item) {
      if (!MENU_IDS.includes(item.menu)) {
        throw new PluginApiError('E_PLUGIN_INVALID_INPUT', `未知菜单：${String(item.menu)}`);
      }
      return track(
        deps.uiStore.addMenu({
          id: resolveItemId(item.id, 'menu'),
          pluginId: plugin.id,
          menu: item.menu,
          group: item.group,
          title: item.title,
          iconUrl: resolveIcon(item.icon),
          order: item.order ?? 100,
          requiresWrite: item.requiresWrite ?? false,
          command: item.command,
          run: resolveRun(item),
        })
      );
    },

    registerPanel() {
      // P0 未接入侧栏渲染：先返回空句柄，避免插件在激活阶段直接崩掉
      logger.info('registerPanel 将在后续阶段接入，本次调用被忽略');
      return { dispose: () => undefined };
    },

    showMessage(level, message) {
      deps.notify(level, message);
    },
  };

  const settingsValues = { ...plugin.settings };
  const settings: SettingsApi = {
    get<T>(key: string): T | undefined {
      return settingsValues[key] as T | undefined;
    },
    onChange() {
      // v1 设置只在启动时下发，不支持热更新
      return { dispose: () => undefined };
    },
  };

  const storagePrefix = `pgclouddoc.plugin.${plugin.id}.${deps.userId}.`;
  const storage = createStorage(storagePrefix, plugin.id, permissions.has('storage'));

  return {
    pluginId: plugin.id,
    pluginVersion: plugin.version,
    hostVersion: deps.hostVersion,
    apiVersion: PLUGIN_API_VERSION,
    logger,
    commands,
    documents: deps.documents,
    ui,
    settings,
    storage,
    subscriptions,
    hasPermission: (permission) => permissions.has(permission),
  };
}

function createStorage(prefix: string, pluginId: string, allowed: boolean): StorageApi {
  const requirePermission = (): void => {
    if (!allowed) {
      throw new PluginApiError(
        'E_PLUGIN_PERMISSION',
        `插件 ${pluginId} 未声明 storage 权限`
      );
    }
  };

  const ensureStorage = (): Storage => {
    requirePermission();
    if (typeof localStorage === 'undefined') {
      throw new PluginApiError('E_PLUGIN_STORAGE_QUOTA', '当前环境不支持 localStorage');
    }
    return localStorage;
  };

  const bytesOf = (storage: Storage): number => {
    let total = 0;
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key || !key.startsWith(prefix)) continue;
      total += key.length + (storage.getItem(key)?.length ?? 0);
    }
    return total * 2;
  };

  return {
    async get<T>(key: string): Promise<T | null> {
      requirePermission();
      try {
        const raw = ensureStorage().getItem(prefix + key);
        return raw === null ? null : (JSON.parse(raw) as T);
      } catch {
        return null;
      }
    },

    async set<T>(key: string, value: T): Promise<void> {
      const storage = ensureStorage();
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        throw new PluginApiError('E_PLUGIN_INVALID_INPUT', '存储值必须是可序列化的 JSON');
      }

      const existing = storage.getItem(prefix + key);
      const delta = (key.length + serialized.length) * 2 - (existing?.length ?? 0) * 2;
      if (bytesOf(storage) + delta > STORAGE_LIMIT_BYTES) {
        throw new PluginApiError(
          'E_PLUGIN_STORAGE_QUOTA',
          `插件 ${pluginId} 的本地存储超过 ${STORAGE_LIMIT_BYTES / 1024}KB`
        );
      }

      try {
        storage.setItem(prefix + key, serialized);
      } catch {
        throw new PluginApiError('E_PLUGIN_STORAGE_QUOTA', '浏览器存储空间不足或不可用');
      }
    },

    async delete(key: string): Promise<void> {
      requirePermission();
      try {
        ensureStorage().removeItem(prefix + key);
      } catch {
        // 删除失败没有可恢复动作
      }
    },

    async keys(): Promise<string[]> {
      requirePermission();
      try {
        const storage = ensureStorage();
        const keys: string[] = [];
        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index);
          if (key?.startsWith(prefix)) keys.push(key.slice(prefix.length));
        }
        return keys;
      } catch {
        return [];
      }
    },
  };
}
