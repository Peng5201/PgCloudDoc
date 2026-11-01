/**
 * 插件 UI 贡献的运行时仓库。
 *
 * manifest 贡献与运行时注册都落到这里；React 通过 useSyncExternalStore 订阅版本号。
 * 只存数据和执行回调，不 import React —— 宿主 UI 层决定怎么画。
 */

import type { Disposable, MenuId, StatusBarSlot, ToolbarSlot } from '@pgclouddoc/plugin-api';

export interface UiItem {
  id: string;
  pluginId: string;
  title: string;
  iconUrl?: string;
  order: number;
  requiresWrite: boolean;
  command?: string;
  run: () => void | Promise<void>;
}

export interface ToolbarItemView extends UiItem {
  slot: ToolbarSlot;
}

export interface StatusBarItemView extends UiItem {
  slot: StatusBarSlot;
}

export interface MenuItemView extends UiItem {
  menu: MenuId;
  group?: string;
}

/** 面板视图。内容是容器挂载函数（插件侧无 React 运行时） */
export interface PanelItemView {
  id: string;
  pluginId: string;
  title: string;
  iconUrl?: string;
  order: number;
  requiresWrite: boolean;
  mount: (container: HTMLElement) => void | (() => void);
}

export class PluginUiStore {
  private readonly toolbar = new Map<string, ToolbarItemView>();
  private readonly statusBar = new Map<string, StatusBarItemView>();
  private readonly menus = new Map<string, MenuItemView>();
  private readonly panels = new Map<string, PanelItemView>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  addToolbar(item: ToolbarItemView): Disposable {
    this.toolbar.set(item.id, item);
    this.bump();
    return {
      dispose: () => {
        if (this.toolbar.delete(item.id)) this.bump();
      },
    };
  }

  addStatusBar(item: StatusBarItemView): Disposable {
    this.statusBar.set(item.id, item);
    this.bump();
    return {
      dispose: () => {
        if (this.statusBar.delete(item.id)) this.bump();
      },
    };
  }

  addMenu(item: MenuItemView): Disposable {
    this.menus.set(item.id, item);
    this.bump();
    return {
      dispose: () => {
        if (this.menus.delete(item.id)) this.bump();
      },
    };
  }

  addPanel(item: PanelItemView): Disposable {
    this.panels.set(item.id, item);
    this.bump();
    return {
      dispose: () => {
        if (this.panels.delete(item.id)) this.bump();
      },
    };
  }

  toolbarItems(slot: ToolbarSlot): ToolbarItemView[] {
    return [...this.toolbar.values()]
      .filter((item) => item.slot === slot)
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }

  statusBarItems(slot: StatusBarSlot): StatusBarItemView[] {
    return [...this.statusBar.values()]
      .filter((item) => item.slot === slot)
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }

  menuItems(menu: MenuId): MenuItemView[] {
    return [...this.menus.values()]
      .filter((item) => item.menu === menu)
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }

  panelItems(): PanelItemView[] {
    return [...this.panels.values()].sort(
      (a, b) => a.order - b.order || a.title.localeCompare(b.title)
    );
  }

  clear(): void {
    this.toolbar.clear();
    this.statusBar.clear();
    this.menus.clear();
    this.panels.clear();
    this.bump();
  }

  private bump(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // 订阅方出错不能反过来影响插件系统
      }
    }
  }
}
