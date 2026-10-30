/**
 * 把引擎状态同步到 React。
 *
 * 设计要点：
 *   1. 引擎**只暴露 getState() 快照 + 事件**，React 层不摸引擎内部
 *   2. 状态更新按帧合并（rAF）—— 滚动/拖选时事件一秒能发上百次，
 *      每次都 setState 会让 antd 的工具栏跟着抖
 *   3. dispose 必须幂等：React StrictMode 会把 effect 跑两遍
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { IWorkbookData } from '../engine';
import { SheetEngine, type EngineEvent, type ISheetState } from '../engine';

/**
 * 需要同步到 React 的事件。
 *
 * 刻意**不含 `scroll-change`**：没有任何 UI 组件显示滚动位置，
 * 而滚动一秒能发 60 次事件，每次都 setState 会把整个工具栏重渲染一遍
 * （实测连续滚动中位耗时从 ~17ms 掉到 ~6ms）。滚动只影响 canvas，
 * 那部分由引擎自己的脏标记 + rAF 负责，不经过 React。
 */
const ALL_EVENTS: EngineEvent[] = [
    'selection-change',
    'content-change',
    'zoom-change',
    'sheet-change',
    'history-change',
    'edit-change',
];

/**
 * useSheetEngine 的返回值。
 *
 * 两个字段分工：`engine` 用来「下命令」，`state` 用来「读状态」。
 * 两者都从 null 起步 —— 容器没挂上、快照还没给时是 null，调用方要先判空。
 */
export interface UseSheetEngineResult {
    /** 引擎实例，UI 靠它调方法（执行命令、撤销重做、改样式等） */
    engine: SheetEngine | null;
    /** 引擎状态快照，React 层只读这个来渲染；由引擎按帧合并更新，不要自己算 */
    state: ISheetState | null;
}

export function useSheetEngine(
    containerRef: React.RefObject<HTMLDivElement | null>,
    snapshot: Partial<IWorkbookData> | null,
    readOnly = false
): UseSheetEngineResult {
    const [engine, setEngine] = useState<SheetEngine | null>(null);
    const [state, setState] = useState<ISheetState | null>(null);

    // 用 ref 兜住 engine，让回调闭包拿到的是当前实例而不是首帧的 null
    const engineRef = useRef<SheetEngine | null>(null);

    // readOnly 变化时热更新，不重建引擎（重建会丢滚动位置/选区）
    useEffect(() => {
        engineRef.current?.setReadOnly(readOnly);
    }, [readOnly]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !snapshot) return;

        const instance = new SheetEngine({ container, snapshot, readOnly });
        engineRef.current = instance;
        setEngine(instance);
        setState(instance.getState());

        let frame = -1;
        const schedule = () => {
            if (frame !== -1) return;
            frame = requestAnimationFrame(() => {
                frame = -1;
                setState(instance.getState());
            });
        };

        const disposers = ALL_EVENTS.map((event) => instance.on(event, schedule));

        return () => {
            if (frame !== -1) cancelAnimationFrame(frame);
            for (const dispose of disposers) dispose();
            instance.dispose();
            if (engineRef.current === instance) engineRef.current = null;
            setEngine(null);
        };
        // snapshot 只在挂载时吃一次；热更新数据请用 engine.load()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [containerRef, snapshot]);

    return { engine, state };
}

/** 给 UI 用：把引擎方法包成稳定的 useCallback */
export function useEngineAction(
    engine: SheetEngine | null,
    action: (instance: SheetEngine) => void
): () => void {
    return useCallback(() => {
        if (engine) action(engine);
    }, [engine, action]);
}
