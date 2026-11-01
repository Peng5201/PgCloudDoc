/**
 * 侧面板（右侧辅助栏）的类型契约。
 *
 * 侧面板是宿主级固有能力，不属于插件系统：宿主页面与插件都往同一个容器里
 * 注册「视图」，容器负责活动栏、标题栏、拖拽改宽和显示/隐藏。
 *
 * 内容有两种形态，对应两条信任边界：
 *   - `render()`  → React 节点，宿主自己的页面用；
 *   - `mount(el)` → 挂到宿主给的 DOM 容器里，插件用。
 *
 * 插件为什么不用 React：宿主尚未提供 import map / plugin-runtime 共享实例，
 * 插件代码里 `import 'react'` 解析不到。容器挂载对插件零运行时依赖，
 * 而且和后续 iframe + RPC 的隔离模型是同一套接缝（换成 iframe 只改宿主挂载侧）。
 */

import type { ReactNode } from 'react';

export type SidePanelViewOwner = { kind: 'host' } | { kind: 'plugin'; pluginId: string };

export interface SidePanelView {
    /** 全局唯一。宿主用业务 id；插件由宿主拼成 `<pluginId>:<panelId>` */
    id: string;
    title: string;
    /** 活动栏图标：React 节点，或图片 URL（插件只给 URL） */
    icon?: ReactNode | string;
    /** 越小越靠前，默认 100 */
    order?: number;
    /** 是否显示标题栏的关闭按钮，默认 true */
    closable?: boolean;
    owner: SidePanelViewOwner;
    /** 文档只读时该视图不可用（仍留在活动栏里，点击只提示） */
    requiresWrite?: boolean;
    /** React 内容。与 mount 二选一 */
    render?: () => ReactNode;
    /** 容器内容。与 render 二选一；返回值在卸载时调用 */
    mount?: (container: HTMLElement) => void | (() => void);
    /**
     * 首次显示前调用：插件懒激活、按需取数。
     * 抛出异常只影响该视图，不会让面板崩溃。
     */
    onFirstShow?: () => void | Promise<void>;
    /** 内容还没准备好（manifest 已声明、运行时面板尚未注册） */
    pending?: boolean;
}

export interface SidePanelState {
    /** 用户意图上的开合（没有视图时界面不会显示面板） */
    open: boolean;
    /** 面板宽度（px） */
    width: number;
    /** 当前视图 id；没有视图时为 null */
    activeId: string | null;
    /** 已按 order 排好序，可直接渲染 */
    views: SidePanelView[];
}

export interface SidePanelPrefs {
    width?: number;
    open?: boolean;
    activeId?: string | null;
}

/** 持久化出口。默认写 localStorage，测试可以注入内存实现 */
export interface SidePanelStorage {
    read(): SidePanelPrefs | null;
    write(prefs: Required<SidePanelPrefs>): void;
}

export interface SidePanelOptions {
    defaultWidth?: number;
    minWidth?: number;
    maxWidth?: number;
    /** 首次使用时的开合状态，默认关闭（和 VS Code 辅助栏一致） */
    defaultOpen?: boolean;
    storage?: SidePanelStorage;
}

export interface RegisterSidePanelView
    extends Omit<SidePanelView, 'owner' | 'id' | 'title'> {
    owner?: SidePanelViewOwner;
}

export const SIDE_PANEL_MIN_WIDTH = 220;
export const SIDE_PANEL_MAX_WIDTH = 720;
export const SIDE_PANEL_DEFAULT_WIDTH = 320;
