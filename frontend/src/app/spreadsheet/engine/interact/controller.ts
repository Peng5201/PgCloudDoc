/**
 * 交互控制器 —— 把 DOM 事件翻译成命令和状态变更。
 *
 * 对照 Univer: packages/sheets-ui/src/controllers/ 下的一堆 controller
 *              （shortcuts/ 、clipboard/、editor/ …）
 *
 * 这一层的唯一职责是「翻译」：DOM 事件 → 选区变化 / 命令执行 / 滚动缩放。
 * 它**不直接改数据** —— 所有内容修改都走 history.push(edit)，
 * 这样撤销重做和将来的协同编辑才有统一入口。
 */

import { History } from '../command/history';
import {
    InternalClipboard,
    buildPayload,
    createCutEdit,
    createPasteEdit,
    matrixFromText,
    type IClipboardPayload,
} from '../command/clipboard';
import {
    createClearRangeEdit,
    createSetRangeValuesEdit,
    inferCellData,
} from '../command/set-range-values';
import type { Workbook } from '../model/workbook';
import type { Worksheet } from '../model/worksheet';
import type { Renderer } from '../render/renderer';
import type { SheetSkeleton } from '../render/skeleton';
import type { IRange } from '../model/types';
import { CellEditor } from './editor';
import {
    allSelection,
    appendSelection,
    columnSelection,
    primaryRange,
    rangeSelection,
    rowSelection,
    selectionEquals,
    singleSelection,
    type ISelection,
} from './selection';

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

/**
 * 当前活动的工作簿 / 工作表 / 骨架。
 *
 * 都放在同一个可变对象里而不是当构造参数传进来：切换工作表、
 * 重载 snapshot 时 SheetEngine 只换这里的引用，控制器和编辑器每次现取，
 * 拿到的永远是当前的，不会拿着旧引用不放。
 */
export interface ISheetRef {
    workbook: Workbook;
    worksheet: Worksheet;
    skeleton: SheetSkeleton;
}

export interface IControllerHooks {
    /** 选区变了 */
    selectionChange(): void;
    /** 数据变了（写值/样式/粘贴…） */
    contentChange(): void;
    /** 滚动了 */
    scrollChange(): void;
    /** 缩放变了 */
    zoomChange(): void;
    /** 编辑态开关 */
    editChange(open: boolean): void;
    /** 编辑器内容变化（公式栏联动） */
    editInput(text: string): void;
    /** Ctrl+B / Ctrl+I / Ctrl+U 这类开关样式，由引擎层套到整个选区 */
    toggleStyle(key: 'bl' | 'it' | 'ul' | 'st'): void;
}

type HitRegion =
    | { kind: 'corner' }
    | { kind: 'row'; row: number }
    | { kind: 'column'; column: number }
    | { kind: 'cell'; row: number; column: number };

interface IDragState {
    kind: 'cell' | 'row' | 'column';
    anchorRow: number;
    anchorColumn: number;
    /** Ctrl 多选时要保留的旧矩形 */
    extraRanges: IRange[];
}

export class Controller {
    selection: ISelection = singleSelection(0, 0);

    private _readOnly = false;

    private readonly _editor: CellEditor;
    private readonly _clipboard = new InternalClipboard();
    private _disposables: Array<() => void> = [];
    private _disposed = false;

    private _drag: IDragState | null = null;

    constructor(
        private readonly _host: HTMLElement,
        private readonly _ref: ISheetRef,
        private readonly _renderer: Renderer,
        private readonly _history: History,
        private readonly _hooks: IControllerHooks
    ) {
        this._editor = new CellEditor(
            _host,
            {
                // _ref 里的引用会被换掉（切表 / load 新 snapshot），
                // 所以一律走 getter 现取，不要在这里存快照
                get workbook(): Workbook {
                    return _ref.workbook;
                },
                get worksheet(): Worksheet {
                    return _ref.worksheet;
                },
                get skeleton(): SheetSkeleton {
                    return _ref.skeleton;
                },
                renderer: _renderer,
            },
            {
                commit: (text, move) => this._commitEdit(text, move),
                cancel: () => {
                    this._focusHost();
                    this._hooks.editChange(false);
                },
                input: (text) => this._hooks.editInput(text),
            }
        );

        this._bind();
    }

    get editor(): CellEditor {
        return this._editor;
    }

    private get _worksheet(): Worksheet {
        return this._ref.worksheet;
    }

    private get _skeleton(): SheetSkeleton {
        return this._ref.skeleton;
    }

    // ─────────────────────────── 选区 ───────────────────────────

    setSelection(next: ISelection, emit = true): void {
        if (selectionEquals(this.selection, next)) return;
        this.selection = next;
        if (emit) this._hooks.selectionChange();
        this._renderer.invalidate();
    }

    setActiveCell(row: number, column: number): void {
        this.setSelection(singleSelection(row, column));
    }

    /** 只读模式：允许浏览/选中/复制，禁止一切写操作 */
    setReadOnly(readonly: boolean): void {
        this._readOnly = readonly;
        if (readonly && this._editor.isOpen) {
            this._editor.close();
            this._hooks.editChange(false);
        }
    }

    // ─────────────────────────── 编辑 ───────────────────────────

    beginEdit(row: number, column: number, initialValue?: string, selectAll = true): void {
        if (this._readOnly) return;
        this.setActiveCell(row, column);
        this._editor.open(row, column, initialValue, selectAll);
        this._hooks.editChange(true);
    }

    /**
     * 公式栏实时输入 —— 只同步到浮动编辑器，**不落库**。
     * 每敲一个字符就 push 一次 undo 是灾难，落库交给 commitFromFormulaBar。
     */
    syncFromFormulaBar(text: string): void {
        if (this._editor.isOpen) {
            this._editor.syncText(text);
        }
    }

    /** 公式栏确认（Enter / 失焦）：关掉编辑器并落库 */
    commitFromFormulaBar(text: string): void {
        if (this._editor.isOpen) this._editor.close();
        this._commitEdit(text, null);
    }

    private _commitEdit(text: string, move: { row: number; column: number } | null): void {
        const worksheet = this._worksheet;
        const { row, column } = this.selection.active;

        // 唯一写数据的地方 —— 统一走 history
        this._history.push(
            createSetRangeValuesEdit(worksheet, rangeOf(row, column), inferCellData(text), '输入内容')
        );

        if (move) {
            const nextRow = clamp(move.row, 0, worksheet.rowCount - 1);
            const nextColumn = clamp(move.column, 0, worksheet.columnCount - 1);
            this.setActiveCell(nextRow, nextColumn);
            this.scrollCellIntoView(nextRow, nextColumn);
        }

        this._focusHost();
        this._hooks.editChange(false);
    }

    /** 清空当前选区（Delete / Backspace / 清除内容按钮） */
    clearSelection(): void {
        if (this._readOnly) return;
        for (const range of this.selection.ranges) {
            this._history.push(createClearRangeEdit(this._worksheet, range));
        }
    }

    // ─────────────────────────── 视口 ───────────────────────────

    scrollCellIntoView(row: number, column: number): void {
        const rect = this._skeleton.cellRect(row, column);
        const vp = this._renderer.viewport();
        const zoom = this._renderer.zoom;

        const screenLeft = (rect.x - this._renderer.scrollX) * zoom;
        const screenTop = (rect.y - this._renderer.scrollY) * zoom;
        const screenRight = screenLeft + rect.width * zoom;
        const screenBottom = screenTop + rect.height * zoom;

        let dx = 0;
        let dy = 0;
        if (screenLeft < 0) dx = screenLeft;
        else if (screenRight > vp.width) dx = screenRight - vp.width;
        if (screenTop < 0) dy = screenTop;
        else if (screenBottom > vp.height) dy = screenBottom - vp.height;

        if (dx !== 0 || dy !== 0) {
            this._renderer.scrollX += dx / zoom;
            this._renderer.scrollY += dy / zoom;
            this.clampScroll();
            this._hooks.scrollChange();
        }
    }

    clampScroll(): void {
        const vp = this._renderer.viewport();
        const zoom = this._renderer.zoom;
        this._renderer.scrollX = clamp(
            this._renderer.scrollX,
            0,
            Math.max(0, this._skeleton.contentWidth - vp.width / zoom)
        );
        this._renderer.scrollY = clamp(
            this._renderer.scrollY,
            0,
            Math.max(0, this._skeleton.contentHeight - vp.height / zoom)
        );
    }

    /** 以某个屏幕点为锚点缩放（Ctrl+滚轮的手感关键） */
    zoomAt(factor: number, screenX: number, screenY: number): void {
        const zoom = clamp(this._renderer.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        if (zoom === this._renderer.zoom) return;

        const contentX = screenX / this._renderer.zoom + this._renderer.scrollX;
        const contentY = screenY / this._renderer.zoom + this._renderer.scrollY;

        this._renderer.zoom = zoom;

        // 缩放后把锚点下面的内容保持在光标处
        this._renderer.scrollX = contentX - screenX / zoom;
        this._renderer.scrollY = contentY - screenY / zoom;

        this.clampScroll();
        this._editor.layout();
        this._hooks.zoomChange();
        this._renderer.invalidate();
    }

    setZoom(zoom: number): void {
        const vp = this._renderer.viewport();
        this.zoomAt(zoom / this._renderer.zoom, vp.width / 2, vp.height / 2);
    }

    // ─────────────────────────── 剪贴板 ───────────────────────────

    /** copy / cut 事件里调：把载荷写进剪贴板 */
    writeClipboard(event: ClipboardEvent, cut: boolean): void {
        const range = primaryRange(this.selection);
        const payload = buildPayload(this._worksheet, range);

        event.preventDefault();
        event.clipboardData?.setData('text/plain', payload.text);
        event.clipboardData?.setData('text/html', payload.html);
        this._clipboard.set(payload);

        if (cut && !this._readOnly) {
            this._history.push(createCutEdit(this._worksheet, range));
            this._hooks.contentChange();
        }
    }

    /** paste 事件里调 */
    readClipboard(event: ClipboardEvent): void {
        event.preventDefault();
        if (this._readOnly) return;

        const text = event.clipboardData?.getData('text/plain') ?? '';
        const payload: IClipboardPayload | null = this._clipboard.matches(text)
            ? this._clipboard.payload
            : null;

        this.pasteMatrix(payload ? payload.matrix : matrixFromText(text));
    }

    /** 也允许外部直接贴一坨文本（公式栏/右键菜单将来要用） */
    pasteText(text: string): void {
        if (this._readOnly) return;
        this.pasteMatrix(matrixFromText(text));
    }

    private pasteMatrix(matrix: ReturnType<typeof matrixFromText>): void {
        const target = primaryRange(this.selection);
        this._history.push(createPasteEdit(this._worksheet, target, matrix));

        const rows = matrix.length;
        const columns = matrix[0]?.length ?? 1;
        const endRow = Math.min(this._worksheet.rowCount - 1, target.startRow + rows - 1);
        const endColumn = Math.min(this._worksheet.columnCount - 1, target.startColumn + columns - 1);

        this.setSelection(rangeSelection(target.startRow, target.startColumn, endRow, endColumn));
        this._hooks.contentChange();
    }

    // ─────────────────────────── 事件绑定 ───────────────────────────

    private _bind(): void {
        const on = <E extends Event>(
            target: EventTarget,
            type: string,
            handler: (event: E) => void,
            options?: AddEventListenerOptions
        ) => {
            target.addEventListener(type, handler as EventListener, options);
            this._disposables.push(() =>
                target.removeEventListener(type, handler as EventListener, options)
            );
        };

        on<MouseEvent>(this._host, 'mousedown', (e) => this._onMouseDown(e));
        on<MouseEvent>(this._host, 'mousemove', (e) => this._onMouseMove(e));
        on<MouseEvent>(document, 'mouseup', () => this._onMouseUp());
        on<MouseEvent>(this._host, 'dblclick', (e) => this._onDoubleClick(e));
        on<WheelEvent>(this._host, 'wheel', (e) => this._onWheel(e), { passive: false });
        on<KeyboardEvent>(this._host, 'keydown', (e) => this._onKeyDown(e));
        on<ClipboardEvent>(this._host, 'copy', (e) => this.writeClipboard(e, false));
        on<ClipboardEvent>(this._host, 'cut', (e) => this.writeClipboard(e, true));
        on<ClipboardEvent>(this._host, 'paste', (e) => this.readClipboard(e));
        on<MouseEvent>(this._host, 'contextmenu', (e) => e.preventDefault());
        on<FocusEvent>(this._host, 'focusin', () => this._renderer.invalidate());
    }

    /** 屏幕坐标 → 命中区域（格子 / 行头 / 列头 / 左上角） */
    private _hitTest(event: MouseEvent): HitRegion {
        const bounds = this._host.getBoundingClientRect();
        const localX = event.clientX - bounds.left;
        const localY = event.clientY - bounds.top;

        const hw = this._renderer.headerWidth;
        const hh = this._renderer.headerHeight;

        if (localX < hw && localY < hh) return { kind: 'corner' };

        const content = this._renderer.screenToContent(localX, localY);
        const { row, column } = this._skeleton.locate(content.x, content.y);

        if (localX < hw) return { kind: 'row', row };
        if (localY < hh) return { kind: 'column', column };
        return { kind: 'cell', row, column };
    }

    private _onMouseDown(event: MouseEvent): void {
        if (event.button !== 0) return;

        // 点在编辑器上由编辑器自己处理（那边已 stopPropagation）
        const hit = this._hitTest(event);

        if (this._editor.isOpen) {
            // Excel 的行为：点别处 = 确认当前编辑
            const text = this._editor.value;
            this._editor.close();
            this._commitEdit(text, null);
        }

        this._focusHost();
        event.preventDefault();

        const worksheet = this._worksheet;
        const isToggle = event.ctrlKey || event.metaKey;
        const isExtend = event.shiftKey;

        const extraRanges = isToggle ? [...this.selection.ranges] : [];
        const anchor = isExtend ? this.selection.active : this._anchorOf(hit);

        switch (hit.kind) {
            case 'corner':
                this._drag = null;
                this.setSelection(allSelection(worksheet.rowCount, worksheet.columnCount));
                return;

            case 'row': {
                const focusRow = isExtend ? anchor.row : hit.row;
                this._drag = {
                    kind: 'row',
                    anchorRow: isExtend ? anchor.row : hit.row,
                    anchorColumn: 0,
                    extraRanges,
                };
                const sel = rowSelection(this._drag.anchorRow, focusRow, worksheet.columnCount);
                this.setSelection(
                    extraRanges.length > 0 ? appendRanges(sel, extraRanges) : sel
                );
                return;
            }

            case 'column': {
                const focusColumn = isExtend ? anchor.column : hit.column;
                this._drag = {
                    kind: 'column',
                    anchorRow: 0,
                    anchorColumn: isExtend ? anchor.column : hit.column,
                    extraRanges,
                };
                const sel = columnSelection(
                    this._drag.anchorColumn,
                    focusColumn,
                    worksheet.rowCount
                );
                this.setSelection(
                    extraRanges.length > 0 ? appendRanges(sel, extraRanges) : sel
                );
                return;
            }

            case 'cell': {
                const anchorRow = isExtend ? anchor.row : hit.row;
                const anchorColumn = isExtend ? anchor.column : hit.column;
                this._drag = { kind: 'cell', anchorRow, anchorColumn, extraRanges };
                const sel = rangeSelection(anchorRow, anchorColumn, hit.row, hit.column);
                this.setSelection(
                    extraRanges.length > 0 ? appendRanges(sel, extraRanges) : sel
                );
                return;
            }
        }
    }

    private _anchorOf(hit: HitRegion): { row: number; column: number } {
        switch (hit.kind) {
            case 'corner':
                return { row: 0, column: 0 };
            case 'row':
                return { row: hit.row, column: 0 };
            case 'column':
                return { row: 0, column: hit.column };
            case 'cell':
                return { row: hit.row, column: hit.column };
        }
    }

    private _onMouseMove(event: MouseEvent): void {
        const drag = this._drag;
        if (!drag) return;

        const hit = this._hitTest(event);
        let sel: ISelection;

        if (drag.kind === 'row') {
            const focusRow = hit.kind === 'row' ? hit.row : hit.kind === 'cell' ? hit.row : drag.anchorRow;
            sel = rowSelection(drag.anchorRow, focusRow, this._worksheet.columnCount);
        } else if (drag.kind === 'column') {
            const focusColumn =
                hit.kind === 'column' ? hit.column : hit.kind === 'cell' ? hit.column : drag.anchorColumn;
            sel = columnSelection(drag.anchorColumn, focusColumn, this._worksheet.rowCount);
        } else {
            const focusRow = hit.kind === 'cell' || hit.kind === 'row' ? hit.row : drag.anchorRow;
            const focusColumn =
                hit.kind === 'cell' || hit.kind === 'column' ? hit.column : drag.anchorColumn;
            sel = rangeSelection(drag.anchorRow, drag.anchorColumn, focusRow, focusColumn);
        }

        this.setSelection(drag.extraRanges.length > 0 ? appendRanges(sel, drag.extraRanges) : sel);
    }

    private _onMouseUp(): void {
        this._drag = null;
    }

    private _onDoubleClick(event: MouseEvent): void {
        const hit = this._hitTest(event);
        if (hit.kind !== 'cell') return;
        this.beginEdit(hit.row, hit.column);
    }

    private _onWheel(event: WheelEvent): void {
        event.preventDefault();

        const bounds = this._host.getBoundingClientRect();

        if (event.ctrlKey || event.metaKey) {
            const factor = event.deltaY > 0 ? 0.9 : 1.1;
            this.zoomAt(
                factor,
                event.clientX - bounds.left - this._renderer.headerWidth,
                event.clientY - bounds.top - this._renderer.headerHeight
            );
            return;
        }

        if (event.shiftKey) {
            this._renderer.scrollX += event.deltaY;
        } else {
            this._renderer.scrollX += event.deltaX;
            this._renderer.scrollY += event.deltaY;
        }

        this.clampScroll();
        this._editor.layout();
        this._hooks.scrollChange();
        this._renderer.invalidate();
    }

    private _onKeyDown(event: KeyboardEvent): void {
        if (this._editor.isOpen) return;
        // 输入法组合中不要拦按键，否则中文输入会断
        if (event.isComposing) return;

        if (this._handleShortcut(event)) return;

        const { row, column } = this.selection.active;
        const move = this._arrowMove(event);
        if (!move) {
            // 没有方向键 —— 说明用户想直接输入
            if (this._isPrintable(event)) {
                event.preventDefault();
                this.beginEdit(row, column, event.key, true);
            }
            return;
        }

        event.preventDefault();
        const worksheet = this._worksheet;
        const nextRow = clamp(row + move.row, 0, worksheet.rowCount - 1);
        const nextColumn = clamp(column + move.column, 0, worksheet.columnCount - 1);

        // Shift = 扩选区；否则整格移动
        const primary = primaryRange(this.selection);
        if (event.shiftKey) {
            this.setSelection(rangeSelection(primary.startRow, primary.startColumn, nextRow, nextColumn));
        } else {
            this.setActiveCell(nextRow, nextColumn);
        }

        this.scrollCellIntoView(this.selection.active.row, this.selection.active.column);
    }

    private _handleShortcut(event: KeyboardEvent): boolean {
        const mod = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();

        // 只读时编辑类快捷键直接吞掉；Ctrl+A 全选 / 方向键导航仍允许
        if (this._readOnly) {
            const editingWithMod =
                mod && (key === 'z' || key === 'y' || key === 'b' || key === 'i' || key === 'u');
            const editingPlain =
                event.key === 'F2' || event.key === 'Delete' || event.key === 'Backspace';
            if (editingWithMod || editingPlain) {
                event.preventDefault();
                return true;
            }
        }

        // Ctrl/⌘ 组合
        if (mod) {
            switch (key) {
                case 'z':
                    event.preventDefault();
                    if (event.shiftKey) this._history.redo();
                    else this._history.undo();
                    this._hooks.contentChange();
                    return true;
                case 'y':
                    event.preventDefault();
                    this._history.redo();
                    this._hooks.contentChange();
                    return true;
                case 'a':
                    event.preventDefault();
                    this.setSelection(
                        allSelection(this._worksheet.rowCount, this._worksheet.columnCount)
                    );
                    return true;
                case 'b':
                    event.preventDefault();
                    this._hooks.toggleStyle('bl');
                    return true;
                case 'i':
                    event.preventDefault();
                    this._hooks.toggleStyle('it');
                    return true;
                case 'u':
                    event.preventDefault();
                    this._hooks.toggleStyle('ul');
                    return true;
                // c/x/v 交给 copy/cut/paste 事件，那里能读写 clipboardData
                default:
                    return false;
            }
        }

        switch (event.key) {
            case 'F2':
                event.preventDefault();
                this.beginEdit(this.selection.active.row, this.selection.active.column, undefined, false);
                return true;
            case 'Delete':
            case 'Backspace':
                event.preventDefault();
                this.clearSelection();
                this._hooks.contentChange();
                return true;
            case 'Escape':
                this._clipboard.clear();
                this._hooks.contentChange();
                return true;
            default:
                return false;
        }
    }

    private _arrowMove(event: KeyboardEvent): { row: number; column: number } | null {
        const pageRows = Math.max(1, Math.floor(this._renderer.viewport().height / this._skeleton.getRowHeight(0) / this._renderer.zoom) - 1);
        switch (event.key) {
            case 'ArrowUp':
                return { row: -1, column: 0 };
            case 'ArrowDown':
                return { row: 1, column: 0 };
            case 'ArrowLeft':
                return { row: 0, column: -1 };
            case 'ArrowRight':
                return { row: 0, column: 1 };
            case 'Enter':
                return { row: event.shiftKey ? -1 : 1, column: 0 };
            case 'Tab':
                return { row: 0, column: event.shiftKey ? -1 : 1 };
            case 'Home':
                return event.ctrlKey || event.metaKey
                    ? { row: -this._worksheet.rowCount, column: -this._worksheet.columnCount }
                    : { row: 0, column: -this._worksheet.columnCount };
            case 'End':
                return { row: 0, column: this._worksheet.columnCount };
            case 'PageDown':
                return { row: pageRows, column: 0 };
            case 'PageUp':
                return { row: -pageRows, column: 0 };
            default:
                return null;
        }
    }

    private _isPrintable(event: KeyboardEvent): boolean {
        if (event.ctrlKey || event.metaKey || event.altKey) return false;
        if (event.key.length !== 1) return false;
        // 空格是可打印的，但常常被用作快捷键 —— 表格里空格也确实该进入编辑
        return true;
    }

    private _focusHost(): void {
        // canvas 不可聚焦，用 tabindex 让容器接键盘
        if (document.activeElement !== this._host) {
            this._host.focus({ preventScroll: true });
        }
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        for (const dispose of this._disposables) dispose();
        this._disposables = [];
        this._editor.dispose();
    }
}

// ─────────────────────────── 小工具 ───────────────────────────

function rangeOf(row: number, column: number): IRange {
    return { startRow: row, startColumn: column, endRow: row, endColumn: column };
}

/** 把 Ctrl 多选保留的旧矩形接在新选区后面 */
function appendRanges(selection: ISelection, extra: IRange[]): ISelection {
    let next = selection;
    for (const range of extra) {
        next = appendSelection(next, range);
    }
    return next;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}
