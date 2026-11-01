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
  id: string;
  title: string;
  slot: 'editor.sidebar';
  icon?: string;
}

export interface UiApi {
  registerToolbarItem(item: ToolbarItemOptions): Disposable;
  registerStatusBarItem(item: StatusBarItemOptions): Disposable;
  registerMenuItem(item: MenuItemOptions): Disposable;
  /** P0 仅登记，侧栏渲染在后续阶段接入 */
  registerPanel(panel: PanelOptions): Disposable;
  showMessage(level: MessageLevel, message: string): void;
}
