/**
 * 插件宿主：发现 → 懒激活 → 命令/UI/文档 → 停用。
 *
 * 只加载索引里的 manifest；插件代码在命中 activation event（或点击命令）时才 import。
 * 单个插件失败只影响它自己：激活、命令、事件都有 try/catch 边界。
 */

import type {
  CommandHandler,
  Disposable,
  MessageLevel,
  PluginContext,
  PluginModule,
} from '@pgclouddoc/plugin-api';
import { PluginApiError } from '@pgclouddoc/plugin-api/errors';
import { createPluginContext } from '../api/context';
import { createDocumentHub } from '../api/document-api';
import { DocumentSessionRegistry, type DocumentSessionOptions } from './document-session';
import { HOST_VERSION } from './host-version';
import { injectPluginStyle, loadPluginModule } from './plugin-loader';
import { loadDiscoveredPlugins, type DiscoveredPlugin } from './plugin-registry';
import { PluginUiStore } from './ui-store';
import { joinPluginUrl } from './url';

const ACTIVATE_TIMEOUT_MS = 10_000;

type PluginState = 'discovered' | 'loading' | 'active' | 'failed' | 'disposed';

interface PluginRuntime {
  module: PluginModule;
  context: PluginContext;
  documentHubDispose: () => void;
  styleDispose: () => void;
}

interface RegisteredCommand {
  pluginId: string;
  handler: CommandHandler;
}

export interface PluginHostOptions {
  userId: string;
  notifier?: (level: MessageLevel, message: string) => void;
  /** 测试/嵌入时覆盖索引来源 */
  loadPlugins?: () => Promise<DiscoveredPlugin[]>;
  onError?: (info: { pluginId: string; context: string; error: unknown }) => void;
}

export class PluginHost {
  readonly ui = new PluginUiStore();

  private readonly sessions = new DocumentSessionRegistry();
  private readonly entries = new Map<string, DiscoveredPlugin>();
  private readonly states = new Map<string, PluginState>();
  private readonly activations = new Map<string, Promise<boolean>>();
  private readonly runtimes = new Map<string, PluginRuntime>();
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly manifestUiDisposables: Disposable[] = [];

  private disposed = false;
  private initializePromise: Promise<void> | null = null;
  private notifier: (level: MessageLevel, message: string) => void;

  constructor(private readonly options: PluginHostOptions) {
    this.notifier =
      options.notifier ??
      ((level, message) => {
        const log = level === 'error' ? console.error : level === 'warning' ? console.warn : console.info;
        log(`[plugins] ${message}`);
      });
  }

  setNotifier(notifier: (level: MessageLevel, message: string) => void): void {
    this.notifier = notifier;
  }

  // ─────────────────────────── 生命周期 ───────────────────────────

  initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = (async () => {
      try {
        const loader = this.options.loadPlugins ?? loadDiscoveredPlugins;
        const plugins = await loader();
        if (this.disposed) return;

        for (const plugin of plugins) {
          this.entries.set(plugin.id, plugin);
          this.states.set(plugin.id, 'discovered');
          this.registerManifestUi(plugin);
        }

        // 插件索引晚于文档就绪时，也要补一次文档激活
        if (this.sessions.active()) this.activateDocumentPlugins();

        for (const plugin of plugins) {
          if (plugin.activationEvents.includes('onStartup')) {
            void this.ensureActivated(plugin.id);
          }
        }
      } catch (err) {
        this.reportError('host', err, 'initialize');
      }
    })();

    return this.initializePromise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const pluginId of [...this.runtimes.keys()]) this.deactivate(pluginId);
    for (const disposable of this.manifestUiDisposables) {
      try {
        disposable.dispose();
      } catch {
        // 单个 UI 项释放失败不影响整体
      }
    }
    this.manifestUiDisposables.length = 0;

    this.ui.clear();
    this.commands.clear();
    this.entries.clear();
    this.states.clear();
    this.activations.clear();
    this.sessions.dispose();
  }

  // ─────────────────────────── 文档 ───────────────────────────

  attachDocument(options: DocumentSessionOptions): void {
    if (this.disposed) return;
    const session = this.sessions.attach(options);
    if (session.isDisposed) return;
    this.activateDocumentPlugins();
  }

  detachDocument(documentId?: string): void {
    this.sessions.detach(documentId);
  }

  isActiveDocumentReadOnly(): boolean {
    const session = this.sessions.active();
    return session ? !session.canWrite() : false;
  }

  private activateDocumentPlugins(): void {
    for (const plugin of this.entries.values()) {
      const events = plugin.activationEvents;
      if (events.includes('onDocumentOpen') || events.includes('onDocumentOpen:sheet')) {
        void this.ensureActivated(plugin.id);
      }
    }
  }

  // ─────────────────────────── 激活 / 停用 ───────────────────────────

  async ensureActivated(pluginId: string): Promise<boolean> {
    if (this.disposed) return false;
    const plugin = this.entries.get(pluginId);
    if (!plugin) return false;

    if (this.states.get(pluginId) === 'active') return true;

    const inFlight = this.activations.get(pluginId);
    if (inFlight) return inFlight;

    const promise = this.activate(plugin);
    this.activations.set(pluginId, promise);
    return promise.finally(() => {
      if (this.activations.get(pluginId) === promise) this.activations.delete(pluginId);
    });
  }

  private async activate(plugin: DiscoveredPlugin): Promise<boolean> {
    this.states.set(plugin.id, 'loading');
    let runtime: PluginRuntime | null = null;

    try {
      const module = await loadPluginModule(plugin);
      if (this.disposed) return false;

      const documentHub = createDocumentHub(
        this.sessions,
        plugin.id,
        new Set(plugin.permissions),
        (pluginId, error, context) => this.reportError(pluginId, error, context)
      );

      const context = createPluginContext({
        plugin,
        userId: this.options.userId,
        hostVersion: HOST_VERSION,
        documents: documentHub.hub,
        uiStore: this.ui,
        registerCommand: (pluginId, commandId, handler) =>
          this.registerCommand(pluginId, commandId, handler),
        executeCommand: (pluginId, commandId, ...args) =>
          this.executeCommand(pluginId, commandId, ...args),
        notify: (level, message) => this.notifier(level, message),
        onError: (pluginId, error, contextName) =>
          this.reportError(pluginId, error, contextName),
      });

      const styleDispose = injectPluginStyle(plugin);
      runtime = {
        module,
        context,
        documentHubDispose: documentHub.dispose,
        styleDispose,
      };

      await withTimeout(Promise.resolve(module.activate(context)), ACTIVATE_TIMEOUT_MS);

      if (this.disposed) {
        this.disposeRuntime(plugin.id, runtime);
        return false;
      }

      this.runtimes.set(plugin.id, runtime);
      this.states.set(plugin.id, 'active');
      return true;
    } catch (err) {
      this.states.set(plugin.id, 'failed');
      if (runtime) this.disposeRuntime(plugin.id, runtime);
      this.reportError(plugin.id, err, 'activate');
      return false;
    }
  }

  private deactivate(pluginId: string): void {
    const runtime = this.runtimes.get(pluginId);
    if (!runtime) return;

    this.runtimes.delete(pluginId);
    this.states.set(pluginId, 'disposed');

    try {
      const result = runtime.module.deactivate?.();
      if (result && typeof (result as Promise<void>).then === 'function') {
        void (result as Promise<void>).catch((err: unknown) =>
          this.reportError(pluginId, err, 'deactivate')
        );
      }
    } catch (err) {
      this.reportError(pluginId, err, 'deactivate');
    }

    this.disposeRuntime(pluginId, runtime);
  }

  private disposeRuntime(pluginId: string, runtime: PluginRuntime): void {
    for (const disposable of runtime.context.subscriptions) {
      try {
        disposable.dispose();
      } catch (err) {
        this.reportError(pluginId, err, 'dispose');
      }
    }
    try {
      runtime.documentHubDispose();
    } catch (err) {
      this.reportError(pluginId, err, 'dispose');
    }
    try {
      runtime.styleDispose();
    } catch {
      // 样式节点已被移除
    }
    for (const [commandId, command] of [...this.commands]) {
      if (command.pluginId === pluginId) this.commands.delete(commandId);
    }
  }

  // ─────────────────────────── 命令 ───────────────────────────

  async executeCommand(
    pluginId: string,
    commandId: string,
    ...args: unknown[]
  ): Promise<unknown> {
    if (this.disposed) {
      throw new PluginApiError('E_PLUGIN_DISPOSED', '插件宿主已关闭');
    }

    const activated = await this.ensureActivated(pluginId);
    if (!activated) {
      throw new PluginApiError(
        'E_PLUGIN_COMMAND_NOT_FOUND',
        `插件 ${pluginId} 未激活或激活失败`
      );
    }

    const command = this.commands.get(commandId);
    if (!command || command.pluginId !== pluginId) {
      throw new PluginApiError(
        'E_PLUGIN_COMMAND_NOT_FOUND',
        `命令 ${commandId} 不存在（或不属于插件 ${pluginId}）`
      );
    }

    return await command.handler(...args);
  }

  private registerCommand(
    pluginId: string,
    commandId: string,
    handler: CommandHandler
  ): Disposable {
    if (this.disposed) {
      throw new PluginApiError('E_PLUGIN_DISPOSED', '插件宿主已关闭');
    }

    const existing = this.commands.get(commandId);
    if (existing) {
      throw new PluginApiError(
        'E_PLUGIN_COMMAND_DUPLICATE',
        `命令 ${commandId} 已被插件 ${existing.pluginId} 注册`
      );
    }

    const entry: RegisteredCommand = { pluginId, handler };
    this.commands.set(commandId, entry);

    return {
      dispose: () => {
        if (this.commands.get(commandId) === entry) this.commands.delete(commandId);
      },
    };
  }

  private async runCommandFromUi(pluginId: string, commandId: string): Promise<void> {
    try {
      await this.executeCommand(pluginId, commandId);
    } catch (err) {
      this.reportUiError(pluginId, err);
    }
  }

  reportUiError(pluginId: string, error: unknown): void {
    this.reportError(pluginId, error, 'ui');
    const message = error instanceof Error ? error.message : String(error);
    this.notifier('error', `插件 ${pluginId} 执行失败：${message}`);
  }

  // ─────────────────────────── manifest UI ───────────────────────────

  private registerManifestUi(plugin: DiscoveredPlugin): void {
    const contributes = plugin.contributes;
    if (!contributes) return;

    for (const item of contributes.toolbar ?? []) {
      const title = item.title ?? this.commandTitle(plugin, item.command) ?? item.command;
      this.manifestUiDisposables.push(
        this.ui.addToolbar({
          id: `${plugin.id}:toolbar:${item.slot}:${item.command}`,
          pluginId: plugin.id,
          slot: item.slot,
          title,
          iconUrl: item.icon ? joinPluginUrl(plugin.baseUrl, item.icon) : undefined,
          order: item.order ?? 100,
          requiresWrite: item.requiresWrite ?? false,
          command: item.command,
          run: () => this.runCommandFromUi(plugin.id, item.command),
        })
      );
    }

    for (const item of contributes.statusBar ?? []) {
      const title = item.title ?? this.commandTitle(plugin, item.command) ?? item.command;
      this.manifestUiDisposables.push(
        this.ui.addStatusBar({
          id: `${plugin.id}:status:${item.slot}:${item.command}`,
          pluginId: plugin.id,
          slot: item.slot,
          title,
          iconUrl: item.icon ? joinPluginUrl(plugin.baseUrl, item.icon) : undefined,
          order: item.order ?? 100,
          requiresWrite: item.requiresWrite ?? false,
          command: item.command,
          run: () => this.runCommandFromUi(plugin.id, item.command),
        })
      );
    }

    for (const item of contributes.menus ?? []) {
      const title = item.title ?? this.commandTitle(plugin, item.command) ?? item.command;
      this.manifestUiDisposables.push(
        this.ui.addMenu({
          id: `${plugin.id}:menu:${item.menu}:${item.command}`,
          pluginId: plugin.id,
          menu: item.menu,
          group: item.group,
          title,
          iconUrl: item.icon ? joinPluginUrl(plugin.baseUrl, item.icon) : undefined,
          order: item.order ?? 100,
          requiresWrite: false,
          command: item.command,
          run: () => this.runCommandFromUi(plugin.id, item.command),
        })
      );
    }
  }

  private commandTitle(plugin: DiscoveredPlugin, commandId: string): string | undefined {
    return plugin.contributes?.commands?.find((command) => command.id === commandId)?.title;
  }

  // ─────────────────────────── 错误 ───────────────────────────

  private reportError(pluginId: string, error: unknown, context: string): void {
    console.error(`[plugin:${pluginId}] ${context} 失败`, error);
    this.options.onError?.({ pluginId, context, error });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`插件激活超时（${ms}ms）`));
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
