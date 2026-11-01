/**
 * 插件运行时上下文。activate(context) 拿到的就是它。
 */

import type { Disposable } from './common.js';
import type { DocumentHub } from './document.js';
import type { PluginPermission } from './constants.js';
import type { MessageLevel, UiApi } from './ui.js';

export interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export type CommandHandler = (...args: unknown[]) => unknown | Promise<unknown>;

export interface CommandApi {
  register(id: string, handler: CommandHandler): Disposable;
  execute<T = unknown>(id: string, ...args: unknown[]): Promise<T>;
}

export interface SettingsApi {
  /** manifest 默认值 + 管理端覆盖 */
  get<T>(key: string): T | undefined;
  onChange(cb: (key: string, value: unknown) => void): Disposable;
}

/**
 * 插件键值存储。
 * v1 落在 localStorage（按插件 + 用户隔离，单插件 1MB），后续可无缝换成服务端。
 */
export interface StorageApi {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly hostVersion: string;
  readonly apiVersion: string;

  readonly logger: PluginLogger;
  readonly commands: CommandApi;
  readonly documents: DocumentHub;
  readonly ui: UiApi;
  readonly settings: SettingsApi;
  readonly storage: StorageApi;

  /**
   * 所有注册/监听都放进来。宿主停用插件时统一 dispose。
   * commands.register / ui.register* 的返回值已经自动放进来，无需重复 push。
   */
  readonly subscriptions: Disposable[];

  hasPermission(permission: PluginPermission): boolean;
}

export interface PluginModule {
  activate(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export type { MessageLevel };
