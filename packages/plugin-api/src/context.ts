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

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface NetRequestInit {
  method?: HttpMethod;
  headers?: Record<string, string>;
  /** 普通对象按 JSON 发送；string / Blob / FormData / ArrayBuffer 原样发送 */
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * 同源 HTTP 访问。
 *
 * 插件当然可以直接用全局 `fetch`，但只有这个入口会复用宿主的登录态：
 *   - 自动注入当前用户的 access token；
 *   - 401 时走宿主的**单飞刷新**，不会和宿主自己的刷新互相顶掉 refresh token。
 *
 * 返回值是原生 `Response`，所以插件可以自己读 SSE / 流式 body。
 * 非 2xx 不抛错，由调用方按 `response.status` 处理。
 */
export interface NetApi {
  /** 只接受同源相对路径（以 `/` 开头，不能是 `//host`） */
  fetch(path: string, init?: NetRequestInit): Promise<Response>;
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
  readonly net: NetApi;

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
