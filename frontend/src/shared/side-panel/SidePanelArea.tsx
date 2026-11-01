/**
 * 侧面板布局：主内容 + 可拖拽分隔条 + 侧面板。
 *
 * 为什么不用 antd 的 Splitter：Splitter 的面板尺寸是内部状态，动态增删面板时
 * 记不住宽度；而且收起/展开要重挂 Splitter，会把主内容（表格引擎）一起卸载重建。
 * 这里用 flex + 指针事件自己实现约 60 行，主内容始终是同一棵子树。
 */

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
    type KeyboardEvent,
    type PointerEvent,
    type ReactNode,
} from 'react';
import { SidePanel } from './SidePanel';
import { useSidePanel, useSidePanelState } from './SidePanelProvider';

export interface SidePanelAreaProps {
    /** 主内容（编辑器 / 列表） */
    children: ReactNode;
    /** 文档只读时传给面板，requiresWrite 的视图会只展示提示 */
    readOnly?: boolean;
    emptyText?: ReactNode;
    style?: CSSProperties;
    className?: string;
}

const KEYBOARD_STEP = 16;
const HANDLE_WIDTH = 5;

export function SidePanelArea({
    children,
    readOnly,
    emptyText,
    style,
    className,
}: SidePanelAreaProps) {
    const store = useSidePanel();
    const state = useSidePanelState();
    const rootRef = useRef<HTMLDivElement>(null);

    /** 拖拽中的临时宽度：松手才写回 store，避免每一帧都落 localStorage */
    const [dragWidth, setDragWidth] = useState<number | null>(null);
    const [dragging, setDragging] = useState(false);
    const [hovering, setHovering] = useState(false);
    const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
    const dragWidthRef = useRef<number | null>(null);

    const visible = state.open && state.views.length > 0;
    const width = dragWidth ?? state.width;

    useEffect(() => {
        if (!visible) setDragWidth(null);
    }, [visible]);

    // 拖到一半组件卸载（切换文档等）：把全局光标和选择禁用还回去
    useEffect(
        () => () => {
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        },
        []
    );

    /**
     * 宽度上限还要受容器约束：面板最宽不能把主内容挤到 320 以下。
     * 窗口缩小时这个上限跟着变小，但 store 里存的宽度不变，放大窗口后能恢复。
     */
    const clamp = useCallback(
        (value: number) => {
            const limits = store.widthLimits;
            const containerWidth = rootRef.current?.clientWidth ?? 0;
            const maxByContainer = containerWidth
                ? Math.max(limits.min, containerWidth - 320 - HANDLE_WIDTH)
                : limits.max;
            return Math.round(
                Math.min(limits.max, maxByContainer, Math.max(limits.min, value))
            );
        },
        [store]
    );

    const handlePointerDown = useCallback(
        (event: PointerEvent<HTMLDivElement>) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = { startX: event.clientX, startWidth: state.width };
            dragWidthRef.current = state.width;
            setDragWidth(state.width);
            setDragging(true);
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        },
        [state.width]
    );

    const handlePointerMove = useCallback(
        (event: PointerEvent<HTMLDivElement>) => {
            const drag = dragRef.current;
            if (!drag) return;
            // 分隔条向左拖 = 面板变宽
            const next = clamp(drag.startWidth - (event.clientX - drag.startX));
            dragWidthRef.current = next;
            setDragWidth(next);
        },
        [clamp]
    );

    const endDrag = useCallback(
        (event: PointerEvent<HTMLDivElement>) => {
            if (!dragRef.current) return;
            dragRef.current = null;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
            }
            // 只在松手时落盘：拖拽过程中每秒几十次写入没有意义
            if (dragWidthRef.current !== null) store.setWidth(dragWidthRef.current);
            dragWidthRef.current = null;
            setDragWidth(null);
            setDragging(false);
        },
        [store]
    );

    const handleKeyDown = useCallback(
        (event: KeyboardEvent<HTMLDivElement>) => {
            if (event.key === 'ArrowLeft') {
                event.preventDefault();
                store.setWidth(clamp(state.width + KEYBOARD_STEP));
            } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                store.setWidth(clamp(state.width - KEYBOARD_STEP));
            } else if (event.key === 'Home') {
                event.preventDefault();
                store.resetWidth();
            }
        },
        [clamp, state.width, store]
    );

    return (
        <div ref={rootRef} className={className} style={{ ...styles.root, ...style }}>
            <div style={styles.main}>{children}</div>

            {visible && (
                <>
                    <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label="调整侧面板宽度"
                        aria-valuemin={store.widthLimits.min}
                        aria-valuemax={store.widthLimits.max}
                        aria-valuenow={width}
                        tabIndex={0}
                        style={{
                            ...styles.handle,
                            background: dragging || hovering ? 'rgba(51, 112, 255, 0.35)' : 'transparent',
                        }}
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                        onPointerEnter={() => setHovering(true)}
                        onPointerLeave={() => setHovering(false)}
                        onDoubleClick={() => store.resetWidth()}
                        onKeyDown={handleKeyDown}
                    />
                    <div style={{ ...styles.panel, width }} data-side-panel>
                        <SidePanel readOnly={readOnly} emptyText={emptyText} />
                    </div>
                </>
            )}
        </div>
    );
}

const styles = {
    root: {
        display: 'flex',
        flexDirection: 'row' as const,
        width: '100%',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
    },
    main: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        position: 'relative' as const,
    },
    handle: {
        flex: `0 0 ${HANDLE_WIDTH}px`,
        width: HANDLE_WIDTH,
        cursor: 'col-resize',
        // 视觉上是细线，热区仍然是 5px，避免拖不到
        borderLeft: '1px solid #e5e6eb',
        transition: 'background 120ms',
        outline: 'none',
    },
    panel: {
        flex: '0 0 auto',
        minWidth: 0,
        height: '100%',
        overflow: 'hidden',
    },
};
