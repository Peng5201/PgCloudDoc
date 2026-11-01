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
import type { SidePanelView } from '../../../shared/side-panel';
import {
  createPluginContext,
  pluginPanelViewId,
  type PluginSidePanelBridge,
} from '../api/context';
import { createDocumentHub } from '../api/document-api';
import { DocumentSessionRegistry, type DocumentSessionOptions } from './document-session';
import { HOST_VERSION } from './host-version';
import { injectPluginStyle, loadPluginModule } from './plugin-loader';
import { loadDiscoveredPlugins, type DiscoveredPlugin } from './plugin-registry';
import { PluginUiStore, type PanelItemView } from './ui-store';
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
  /** 宿主侧面板（shared/side-panel 的 store）。没有挂载容器时插件面板 API 退化为 no-op */
  sidePanel?: PluginSidePanelHost;
}

/** 宿主侧面板的窄接口，由 SidePanelStore 结构实现 */
export interface PluginSidePanelHost {
  register(view: SidePanelView): { dispose(): void };
  show(id?: string): void;
  hide(): void;
  isVisible(id: string): boolean;
}

/** manifest 里声明的面板：插件未激活时先占个位 */
interface ManifestPanelMeta {
  pluginId: string;
  title: string;
  iconUrl?: string;
  order: number;
}

interface PanelViewEntry {
  /** 来源项：运行时注册的面板对象；null 表示 manifest 占位 */
  source: PanelItemView | null;
  disposable: Disposable;
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
  /** 已注册到宿主侧面板的视图（运行时面板与 manifest 占位共用一张表） */
  private readonly panelViews = new Map<string, PanelViewEntry>();
  /** manifest 声明的面板元信息，插件停用后用来恢复占位视图 */
  private readonly manifestPanels = new Map<string, ManifestPanelMeta>();
  private readonly sidePanelBridge: PluginSidePanelBridge | undefined;

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

    const sidePanel = options.sidePanel;
    this.sidePanelBridge = sidePanel
      ? {
          show: (viewId) => sidePanel.show(viewId),
          hide: () => sidePanel.hide(),
          isVisible: (viewId) => sidePanel.isVisible(viewId),
        }
      : undefined;

    // 运行时面板注册/释放都落在这里：ui-store 只存数据，视图注册由宿主完成
    this.ui.subscribe(() => this.syncPanels());
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

    for (const entry of this.panelViews.values()) {
      try {
        entry.disposable.dispose();
      } catch {
        // 视图释放失败不影响其余清理
      }
    }
    this.panelViews.clear();
    this.manifestPanels.clear();

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
        sidePanel: this.sidePanelBridge,
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

    // 面板只登记元信息：内容要等插件激活后通过 registerPanel 提供。
    // 这里先放一个占位视图，用户点开时才触发激活（onView 懒激活模型）。
    for (const item of contributes.panels ?? []) {
      if (item.slot !== 'editor.sidebar') continue;
      this.manifestPanels.set(pluginPanelViewId(plugin.id, item.id), {
        pluginId: plugin.id,
        title: item.title,
        iconUrl: item.icon ? joinPluginUrl(plugin.baseUrl, item.icon) : undefined,
        order: 100,
      });
    }

    this.syncPanels();
  }

  // ─────────────────────────── 侧面板 ───────────────────────────

  /**
   * 把「manifest 占位 + 运行时面板」同步成宿主侧面板里的视图。
   *
   * 运行时面板优先；插件停用后面板被释放，自动退回占位视图。
   * 用来源对象做幂等判断：工具栏/状态栏的变动也会触发 bump，不能每次都重建视图。
   */
  private syncPanels(): void {
    const sidePanel = this.options.sidePanel;
    if (!sidePanel || this.disposed) return;

    const runtime = new Map(this.ui.panelItems().map((item) => [item.id, item] as const));
    const desired = new Set<string>([...this.manifestPanels.keys(), ...runtime.keys()]);

    // 先摘掉内容已经变化（或来源消失）的视图
    for (const [id, entry] of [...this.panelViews]) {
      const nextSource = runtime.get(id) ?? null;
      if (!desired.has(id) || entry.source !== nextSource) {
        entry.disposable.dispose();
        this.panelViews.delete(id);
      }
    }

    // 再补上缺失的视图
    for (const id of desired) {
      if (this.panelViews.has(id)) continue;
      const item = runtime.get(id) ?? null;
      const view = item ? this.runtimePanelView(item) : this.manifestPanelView(id);
      if (!view) continue;
      this.panelViews.set(id, { source: item, disposable: sidePanel.register(view) });
    }
  }

  private runtimePanelView(item: PanelItemView): SidePanelView {
    return {
      id: item.id,
      title: item.title,
      icon: item.iconUrl,
      order: item.order,
      owner: { kind: 'plugin', pluginId: item.pluginId },
      requiresWrite: item.requiresWrite,
      mount: item.mount,
      onFirstShow: () => {
        void this.ensureActivated(item.pluginId);
      },
    };
  }

  private manifestPanelView(viewId: string): SidePanelView | null {
    const meta = this.manifestPanels.get(viewId);
    if (!meta) return null;
    return {
      id: viewId,
      title: meta.title,
      icon: meta.iconUrl,
      order: meta.order,
      owner: { kind: 'plugin', pluginId: meta.pluginId },
      pending: true,
      // 打开占位视图 = 用户要这个插件的面板，按 onView 语义激活它
      onFirstShow: () => {
        void this.ensureActivated(meta.pluginId);
      },
    };
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
