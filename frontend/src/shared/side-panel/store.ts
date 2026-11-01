/**
 * 侧面板状态机（框架无关）。
 *
 * 只存数据和回调，不 import React —— React 层通过 useSyncExternalStore 订阅。
 * 宿主页面、插件宿主都往同一个 store 里注册视图，显示的始终只有一个。
 */

import type {
    SidePanelOptions,
    SidePanelPrefs,
    SidePanelState,
    SidePanelStorage,
    SidePanelView,
} from './types';
import {
    SIDE_PANEL_DEFAULT_WIDTH,
    SIDE_PANEL_MAX_WIDTH,
    SIDE_PANEL_MIN_WIDTH,
} from './types';

const STORAGE_KEY = 'pgclouddoc.side_panel.v1';
const DEFAULT_ORDER = 100;

/** localStorage 可能被禁用（隐私模式 / 站点设置），读写都必须兜住 */
function createLocalStorage(): SidePanelStorage {
    return {
        read() {
            try {
                const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
                return raw ? (JSON.parse(raw) as SidePanelPrefs) : null;
            } catch {
                return null;
            }
        },
        write(prefs) {
            try {
                globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
            } catch {
                // 存不了就算了：面板宽度不是关键数据
            }
        },
    };
}

export class SidePanelStore {
    private readonly views = new Map<string, SidePanelView>();
    private readonly listeners = new Set<() => void>();
    /** 已经触发过 onFirstShow 的视图，避免每次切回来都重跑 */
    private readonly shown = new Set<string>();

    private readonly min: number;
    private readonly max: number;
    private readonly defaultWidth: number;
    private readonly storage: SidePanelStorage;

    private open: boolean;
    private width: number;
    private activeId: string | null;
    /**
     * 上次会话记住的活动视图。视图是异步注册的（插件按需激活），
     * 它可能比 store 构造晚到，所以先记着，等它注册上来再切过去。
     */
    private restoredActiveId: string | null;

    private snapshot: SidePanelState;

    constructor(options: SidePanelOptions = {}) {
        this.min = options.minWidth ?? SIDE_PANEL_MIN_WIDTH;
        this.max = Math.max(this.min, options.maxWidth ?? SIDE_PANEL_MAX_WIDTH);
        this.defaultWidth = this.clampWidth(options.defaultWidth ?? SIDE_PANEL_DEFAULT_WIDTH);
        this.storage = options.storage ?? createLocalStorage();

        const prefs = this.storage.read();
        this.width = this.clampWidth(prefs?.width ?? this.defaultWidth);
        this.open = prefs?.open ?? options.defaultOpen ?? false;
        this.activeId = prefs?.activeId ?? null;
        this.restoredActiveId = prefs?.activeId ?? null;

        this.snapshot = this.buildSnapshot();
    }

    // ─────────────────────────── 订阅 ───────────────────────────

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    getSnapshot = (): SidePanelState => this.snapshot;

    // ─────────────────────────── 视图注册 ───────────────────────────

    /**
     * 注册视图。同 id 重复注册会原地替换内容（保留位置），
     * 插件场景里 manifest 占位 → 运行时面板就是靠这个完成替换。
     */
    register(view: SidePanelView): { dispose: () => void } {
        // pending 视图（插件 manifest 占位）允许暂时没有内容
        if (!view.pending && !view.render && !view.mount) {
            throw new Error(`侧面板视图 ${view.id} 必须提供 render 或 mount`);
        }
        if (view.render && view.mount) {
            throw new Error(`侧面板视图 ${view.id} 的 render 与 mount 只能二选一`);
        }

        const previous = this.views.get(view.id);
        this.views.set(view.id, { ...view, order: view.order ?? DEFAULT_ORDER });

        // 换内容后允许重新触发一次 onFirstShow（例如占位视图变成真实面板）
        if (previous && previous.mount !== view.mount) {
            this.shown.delete(view.id);
        }

        this.normalizeActive();
        this.publish();
        this.maybeFirstShow();

        return {
            dispose: () => this.unregister(view.id),
        };
    }

    unregister(id: string): void {
        if (!this.views.delete(id)) return;
        this.shown.delete(id);
        this.normalizeActive();
        this.publish();
    }

    getView(id: string): SidePanelView | undefined {
        return this.views.get(id);
    }

    // ─────────────────────────── 显示控制 ───────────────────────────

    /** 打开侧面板（可同时切到指定视图）。未知 id 只告警，不抛错 */
    show(id?: string): void {
        if (id !== undefined && this.views.has(id)) {
            this.activeId = id;
            // 用户明确要这个视图，上次会话记住的活动视图就不再生效
            this.restoredActiveId = null;
        } else if (id !== undefined) {
            console.warn(`[side-panel] 视图 ${id} 尚未注册，忽略切换`);
        }
        this.open = true;
        this.publish();
        this.maybeFirstShow();
    }

    hide(): void {
        if (!this.open) return;
        this.open = false;
        this.publish();
    }

    /** 不带 id：开/关；带 id：切到该视图，已经是它则收起 */
    toggle(id?: string): void {
        if (id !== undefined) {
            if (this.open && this.activeId === id) {
                this.hide();
                return;
            }
            this.show(id);
            return;
        }
        if (this.open) this.hide();
        else this.show();
    }

    /** 切换活动视图（不改变开合状态） */
    activate(id: string): void {
        if (!this.views.has(id)) {
            console.warn(`[side-panel] 视图 ${id} 尚未注册，忽略切换`);
            return;
        }
        if (this.activeId === id) return;
        this.activeId = id;
        this.restoredActiveId = null;
        this.publish();
        this.maybeFirstShow();
    }

    setWidth(width: number): void {
        const next = this.clampWidth(width);
        if (next === this.width) return;
        this.width = next;
        this.publish();
    }

    resetWidth(): void {
        this.setWidth(this.defaultWidth);
    }

    /** 该视图此刻是否真的显示在屏幕上 */
    isVisible(id: string): boolean {
        return this.open && this.views.size > 0 && this.activeId === id;
    }

    /** 拖拽时用：宽度上下限（不含容器宽度约束，UI 自己再按容器夹一次） */
    get widthLimits(): { min: number; max: number } {
        return { min: this.min, max: this.max };
    }

    // ─────────────────────────── 内部 ───────────────────────────

    private clampWidth(width: number): number {
        if (!Number.isFinite(width)) return this.min;
        return Math.min(this.max, Math.max(this.min, Math.round(width)));
    }

    /**
     * 活动视图失效时的回退顺序：上次会话记住的视图 → 已注册的第一个 → null。
     *
     * 记住的视图优先级最高：视图是异步注册的（插件按需激活），用户上次停在
     * 插件面板时，宿主视图先注册上来不能把它顶掉。
     */
    private normalizeActive(): void {
        if (this.restoredActiveId && this.views.has(this.restoredActiveId)) {
            this.activeId = this.restoredActiveId;
            this.restoredActiveId = null;
            return;
        }

        if (this.activeId && this.views.has(this.activeId)) return;

        this.activeId = this.sortedViews()[0]?.id ?? null;
    }

    private sortedViews(): SidePanelView[] {
        return [...this.views.values()].sort(
            (a, b) =>
                (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER) ||
                a.title.localeCompare(b.title, 'zh-Hans-CN')
        );
    }

    private buildSnapshot(): SidePanelState {
        return {
            open: this.open,
            width: this.width,
            activeId: this.activeId,
            views: this.sortedViews(),
        };
    }

    private publish(): void {
        this.snapshot = this.buildSnapshot();
        this.storage.write({
            width: this.width,
            open: this.open,
            activeId: this.activeId,
        });

        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (err) {
                // 订阅方异常不能反过来打断面板状态
                console.error('[side-panel] 订阅者执行失败', err);
            }
        }
    }

    /** 面板打开且活动视图就绪时，触发一次 onFirstShow */
    private maybeFirstShow(): void {
        if (!this.open || this.views.size === 0) return;
        const id = this.activeId;
        if (!id) return;

        const view = this.views.get(id);
        if (!view || !view.onFirstShow || this.shown.has(id)) return;

        this.shown.add(id);
        try {
            const result = view.onFirstShow();
            if (result && typeof (result as Promise<void>).then === 'function') {
                void (result as Promise<void>).catch((err: unknown) => {
                    console.error(`[side-panel] 视图 ${id} 首次显示钩子失败`, err);
                });
            }
        } catch (err) {
            console.error(`[side-panel] 视图 ${id} 首次显示钩子失败`, err);
        }
    }
}
