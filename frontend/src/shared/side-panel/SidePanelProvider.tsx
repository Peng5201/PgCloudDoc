/**
 * 侧面板的 React 绑定。
 *
 * Provider 放在应用根部（AuthProvider 之内、PluginHostProvider 之外）：
 * 宿主页面和插件宿主拿的是同一个 store，所以「页面注册的视图」和
 * 「插件注册的视图」出现在同一个活动栏里。
 */

import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useState,
    useSyncExternalStore,
    type ReactNode,
} from 'react';
import { SidePanelStore } from './store';
import type { SidePanelOptions, SidePanelState, SidePanelView } from './types';

const SidePanelContext = createContext<SidePanelStore | null>(null);

export function SidePanelProvider({
    children,
    options,
}: {
    children: ReactNode;
    /** 只影响首次创建；后续变更不会重建 store */
    options?: SidePanelOptions;
}) {
    const [store] = useState(() => new SidePanelStore(options));
    return <SidePanelContext.Provider value={store}>{children}</SidePanelContext.Provider>;
}

/** 宿主页面用：拿不到 store 属于装配错误，直接抛，避免注册静默丢失 */
export function useSidePanel(): SidePanelStore {
    const store = useContext(SidePanelContext);
    if (!store) {
        throw new Error('useSidePanel 必须在 <SidePanelProvider> 内使用');
    }
    return store;
}

/** 可选依赖场景（插件 Provider 可能在独立渲染的测试里出现） */
export function useSidePanelOptional(): SidePanelStore | null {
    return useContext(SidePanelContext);
}

export function useSidePanelState(): SidePanelState {
    const store = useSidePanel();
    return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/**
 * 注册一个视图，卸载时自动注销。
 *
 *   useSidePanelView({ id: 'host:versions', title: '版本历史', render: () => <Versions /> })
 *
 * deps 变化（比如路由 id 变了）会重注册，同 id 原地替换，活动栏不会闪。
 */
export function useSidePanelView(
    view: Omit<SidePanelView, 'owner'> & { owner?: SidePanelView['owner'] },
    deps: unknown[] = []
): void {
    const store = useSidePanel();
    const { id } = view;

    useEffect(() => {
        const disposable = store.register({
            ...view,
            owner: view.owner ?? { kind: 'host' },
        });
        return () => disposable.dispose();
        // view 对象每次渲染都是新的，显式用 deps 控制重注册时机
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [store, id, ...deps]);
}

/** 供 UI 组件判断「这个视图现在能不能点」 */
export function useSidePanelVisibility(): {
    hasViews: boolean;
    visible: boolean;
    activeId: string | null;
} {
    const state = useSidePanelState();
    return useMemo(
        () => ({
            hasViews: state.views.length > 0,
            visible: state.open && state.views.length > 0,
            activeId: state.activeId,
        }),
        [state.open, state.views.length, state.activeId]
    );
}
