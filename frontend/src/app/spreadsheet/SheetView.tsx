/**
 * 表格视图 —— UI 外壳的装配。
 *
 * 上下结构（对应 Univer 的 sheets-ui views/sheet-container）：
 *   工具栏 → 公式栏 → 画布区 → Sheet 标签栏 → 状态栏
 *
 * 注意画布区必须 `flex: 1; min-height: 0`，否则 canvas 拿不到确定高度，
 * 整个渲染层（viewport / 视口裁剪）都会算错。
 */

import { useEffect, useRef } from 'react';
import type { IWorkbookData, SheetEngine } from './engine';
import { useSheetEngine } from './hooks/useSheetEngine';
import { FormulaBar } from './ui/FormulaBar';
import { SheetBar } from './ui/SheetBar';
import { StatusBar } from './ui/StatusBar';
import { Toolbar } from './ui/Toolbar';

export interface SheetViewProps {
    snapshot: Partial<IWorkbookData>;
    /**
     * 引擎实例就绪时回调。协同层靠它把 Y.Doc 桥接上来。
     * 用 ref 转发，调用方不用关心回调的引用稳定性。
     */
    onEngineReady?: (engine: SheetEngine | null) => void;
    /** 只读模式：禁用输入/编辑，仅可浏览、选中、复制 */
    readOnly?: boolean;
}

export function SheetView({ snapshot, onEngineReady, readOnly = false }: SheetViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const { engine, state } = useSheetEngine(containerRef, snapshot, readOnly);

    const readyRef = useRef(onEngineReady);
    readyRef.current = onEngineReady;

    useEffect(() => {
        readyRef.current?.(engine);
    }, [engine]);

    return (
        <div style={styles.root}>
            <Toolbar engine={engine} state={state} />
            <FormulaBar engine={engine} state={state} />
            <div ref={containerRef} style={styles.grid} />
            <SheetBar engine={engine} state={state} />
            <StatusBar engine={engine} state={state} />
        </div>
    );
}

const styles = {
    root: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column' as const,
        width: '100%',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        background: '#fff',
    },
    grid: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        width: '100%',
        position: 'relative' as const,
    },
};
