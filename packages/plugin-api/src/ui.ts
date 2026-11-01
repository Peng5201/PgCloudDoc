/**
 * 插件 UI 注册与宿主通知。
 */

import type { Disposable } from './common.js';
import type { MenuId, StatusBarSlot, ToolbarSlot } from './constants.js';

export type MessageLevel = 'info' | 'success' | 'warning' | 'error';

interface ItemBase {
  /** 不传时宿主自动生成；同一插件内唯一 */
  id?: string;
  title: string;
  /** 插件包内相对路径或完整 URL；相对路径由宿主拼上 baseUrl */
  icon?: string;
  /** 越小越靠前，默认 100 */
  order?: number;
  /** 文档只读时自动禁用 */
  requiresWrite?: boolean;
  /** 执行已注册命令；与 onClick 二选一 */
  command?: string;
  /** 运行时回调（manifest 贡献不支持） */
  onClick?: () => void | Promise<void>;
}

export interface ToolbarItemOptions extends ItemBase {
  slot: ToolbarSlot;
}

export interface StatusBarItemOptions extends ItemBase {
  slot: StatusBarSlot;
}

export interface MenuItemOptions extends ItemBase {
  menu: MenuId;
  group?: string;
}

export interface PanelOptions {
  /** 插件内唯一，宿主内部会拼成 `<pluginId>:<panelId>` */
  id: string;
  title: string;
  slot: 'editor.sidebar';
  icon?: string;
  /** 越小越靠前，默认 100 */
  order?: number;
  /** 文档只读时不展示内容，只给提示 */
  requiresWrite?: boolean;
  /**
   * 把面板内容挂到宿主提供的容器里。
   *
   * 为什么是容器而不是 React 组件：宿主还没有 import map / plugin-runtime
   * 共享实例，插件里的 `import 'react'` 解析不到。容器挂载对插件零运行时依赖，
   * 也是后续 iframe + RPC 隔离模型的同一套接缝。
   *
   * 返回的函数在面板关闭、切换视图或插件停用时调用，用来清理监听和 DOM。
   */
  mount(container: HTMLElement): void | (() => void);
}

export interface UiApi {
  registerToolbarItem(item: ToolbarItemOptions): Disposable;
  registerStatusBarItem(item: StatusBarItemOptions): Disposable;
  registerMenuItem(item: MenuItemOptions): Disposable;
  /**
   * 注册右侧面板。同一 id 重复注册会替换内容（manifest 占位 → 真实面板就走这条路）。
   * manifest 里声明过 `panels` 的插件，用户打开面板时宿主会自动激活它，
   * 插件在 `activate` 里调用本方法把内容补上即可。
   */
  registerPanel(panel: PanelOptions): Disposable;
  /** 打开侧面板并切到这个面板（会触发对应插件的 onView 激活） */
  showPanel(id: string): void;
  /** 收起整个侧面板 */
  hidePanel(): void;
  /** 该面板此刻是否可见（侧面板打开且它是活动视图） */
  isPanelVisible(id: string): boolean;
  showMessage(level: MessageLevel, message: string): void;
}
