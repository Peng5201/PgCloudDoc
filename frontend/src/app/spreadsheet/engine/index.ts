/**
 * SheetEngine —— 顶层装配。
 *
 * 对照 Univer: packages/core/src/univer.ts + packages/sheets/src/sheets.plugin.ts
 *
 * 分层原则：**顶层类只管依赖注入，不含业务**。
 * new 出各层、把引用喂进去、处理尺寸变化、转发事件 —— 仅此而已。
 * 真正的逻辑都在下面的子模块里。
 */

import { History, type IEdit } from './command/history';
import { createSetRangeStylesEdit, readActiveStyle, togglePatch } from './command/set-range-styles';
import { loadWorkbook, saveWorkbook, createEmptyWorksheet } from './model/snapshot';
import type { Workbook } from './model/workbook';
import type { Worksheet } from './model/worksheet';
import type {
    ICellData,
    IColumnData,
    IRange,
    IRowData,
    IStyleData,
    IStylePatch,
    IWorkbookData,
} from './model/types';
import { HorizontalAlign as HA, VerticalAlign as VA, WrapStrategy as WS } from './model/types';
import { Renderer } from './render/renderer';
import type { IRemoteSelection } from './render/extensions';
import { SheetSkeleton } from './render/skeleton';
import { Controller, MAX_ZOOM, MIN_ZOOM, type ISheetRef } from './interact/controller';
import {
    rangeLabel,
    selectedCount,
    singleSelection,
    type ISelection,
} from './interact/selection';

export type EngineEvent =
    | 'selection-change'
    | 'content-change'
    | 'scroll-change'
    | 'zoom-change'
    | 'sheet-change'
    | 'history-change'
    | 'edit-change';

export type EngineEventHandler = () => void;

export interface ISheetSummary {
    id: string;
    name: string;
    tabColor: string;
    hidden: boolean;
}

/** 选区里数字格的统计（状态栏） */
export interface ISelectionStats {
    /** 有值的格子数 */
    count: number;
    numericCount: number;
    sum: number;
    avg: number;
    min: number;
    max: number;
}

/**
 * 给 UI 的一次性快照。
 *
 * React 层**只读这个**，不摸引擎内部 —— 将来引擎换渲染后端 UI 不用动。
 */
export interface ISheetState {
    sheets: ISheetSummary[];
    sheetId: string;
    sheetName: string;

    selection: ISelection;
    selectionLabel: string;
    selectedCount: number;

    /** 活动单元格的内容，公式栏显示的就是它 */
    cellText: string;
    /** 编辑器当前内容（编辑态下公式栏跟着变） */
    editText: string;
    isEditing: boolean;

    zoom: number;
    scrollX: number;
    scrollY: number;

    canUndo: boolean;
    canRedo: boolean;
    undoLabel: string;
    redoLabel: string;

    stats: ISelectionStats;
    /** 活动格的生效样式，工具栏按钮的按下态靠它 */
    style: IStyleData;
}

export interface ISheetEngineOptions {
    container: HTMLElement;
    snapshot?: Partial<IWorkbookData>;
    /** 历史栈长度 */
    historyLimit?: number;
    /** 把实例挂到 window.__sheetEngine，方便 DevTools 里灌数据压测 */
    exposeGlobal?: boolean;
    /** 只读：允许浏览/选中/复制，禁止一切写操作 */
    readOnly?: boolean;
}

/**
 * 数据变更钩子 —— 协同层接入用。
 *
 * 只覆盖**高频**的三类改动（单元格 / 行高 / 列宽），走增量同步。
 * 结构性改动（增删 sheet、改文档名）频率极低，由协同层直接
 * `engine.load(物化结果)` 整体重建，不在这套钩子里。
 *
 * 钩子打在 ObjectMatrix/ObjectArray 的写方法上，所以命令层和交互层
 * 一行都不用改（见 object-matrix.ts 的说明）。
 */
export interface IEngineChangeHooks {
    onCellChange(
        sheetId: string,
        row: number,
        column: number,
        next: ICellData | undefined,
        before: ICellData | undefined
    ): void;
    onRowChange(
        sheetId: string,
        index: number,
        next: IRowData | undefined,
        before: IRowData | undefined
    ): void;
    onColumnChange(
        sheetId: string,
        index: number,
        next: IColumnData | undefined,
        before: IColumnData | undefined
    ): void;
    /**
     * 结构性改动：增删 / 重命名工作表。
     *
     * 频率极低，但必须同步 —— 否则本地新建的 sheet 只存在于当前浏览器里。
     * 单元格数据仍走上面的增量钩子。
     */
    onSheetAdd?(sheet: Worksheet, index: number): void;
    onSheetRemove?(sheetId: string, index: number): void;
    onSheetRename?(sheetId: string, name: string): void;
}

const EMPTY_STATS: ISelectionStats = {
    count: 0,
    numericCount: 0,
    sum: 0,
    avg: 0,
    min: 0,
    max: 0,
};

/** 统计的上限。选中一整张 10 万行的表时不逐格求和 */
const STATS_CELL_LIMIT = 20000;

export class SheetEngine {
    /** 工作簿对象。改数据请走 execute() / setRangeStyle()，别直接改这里 */
    get workbook(): Workbook {
        return this._workbook;
    }

    readonly renderer: Renderer;
    readonly history: History;
    readonly controller: Controller;

    private _workbook: Workbook;
    private _readOnly = false;

    private readonly _measureCtx: CanvasRenderingContext2D;
    private readonly _skeletons = new Map<string, SheetSkeleton>();
    private readonly _ref: ISheetRef;
    private readonly _resizeObserver: ResizeObserver;
    private readonly _listeners = new Map<EngineEvent, Set<EngineEventHandler>>();

    private _disposed = false;
    private _editText = '';
    private _changeHooks: IEngineChangeHooks | null = null;

    constructor(options: ISheetEngineOptions) {
        const {
            container,
            snapshot,
            historyLimit = 200,
            exposeGlobal = true,
            readOnly = false,
        } = options;
        this._readOnly = readOnly;

        // 1. 工作簿对象
        this._workbook = loadWorkbook(snapshot ?? {});

        // 2. 渲染层。容器必须有明确尺寸，canvas 才能正常工作
        container.style.position = 'relative';
        container.style.overflow = 'hidden';

        // canvas 自己不可聚焦，所以让容器可聚焦 —— 否则键盘快捷键
        // （方向键 / Ctrl+Z / Delete / 直接键入进编辑）一个都收不到。
        container.tabIndex = 0;
        container.style.outline = 'none';

        this.renderer = new Renderer(container);
        this.renderer.canvas.style.userSelect = 'none';

        // 文本测量要一个离屏 ctx，不挂到 DOM 上
        const measureCanvas = document.createElement('canvas');
        const measureCtx = measureCanvas.getContext('2d');
        if (!measureCtx) throw new Error('measure context unavailable');
        this._measureCtx = measureCtx;

        const worksheet = this.workbook.getActiveSheet();
        if (!worksheet) throw new Error('snapshot has no active worksheet');

        this._ref = {
            workbook: this._workbook,
            worksheet,
            skeleton: this._skeletonFor(worksheet),
        };

        this.renderer.skeleton = this._ref.skeleton;
        this.renderer.worksheet = worksheet;
        this.renderer.styles = this.workbook.styles;
        this.renderer.zoom = worksheet.zoomRatio;

        // 3. 编辑历史
        this.history = new History(historyLimit, () => {
            this._ref.skeleton.invalidate();
            this.renderer.invalidate();
            this._emit('history-change');
            this._emit('content-change');
        });

        // 4. 交互层
        this.controller = new Controller(
            container,
            this._ref,
            this.renderer,
            this.history,
            {
                selectionChange: () => this._emit('selection-change'),
                contentChange: () => {
                    this._ref.skeleton.invalidate();
                    this.renderer.invalidate();
                    this._emit('content-change');
                },
                scrollChange: () => this._emit('scroll-change'),
                zoomChange: () => this._emit('zoom-change'),
                editChange: (open) => {
                    if (!open) this._editText = '';
                    this._emit('edit-change');
                },
                editInput: (text) => {
                    this._editText = text;
                    this._emit('edit-change');
                },
                toggleStyle: (key) => this.toggleStyle(key),
            }
        );

        // selection 用 getter：Controller 会整体替换 selection 对象，存快照会过期
        this.renderer.getSelection = () => this.controller.selection;
        this.controller.setReadOnly(this._readOnly);

        this._resizeObserver = new ResizeObserver(() => this.renderer.invalidate());
        this._resizeObserver.observe(container);

        this.renderer.invalidate();

        if (exposeGlobal && typeof window !== 'undefined') {
            (window as unknown as { __sheetEngine?: SheetEngine }).__sheetEngine = this;
        }
    }

    // ─────────────────────────── 事件 ───────────────────────────

    on(event: EngineEvent, handler: EngineEventHandler): () => void {
        let set = this._listeners.get(event);
        if (!set) {
            set = new Set();
            this._listeners.set(event, set);
        }
        set.add(handler);
        return () => this.off(event, handler);
    }

    off(event: EngineEvent, handler: EngineEventHandler): void {
        this._listeners.get(event)?.delete(handler);
    }

    private _emit(event: EngineEvent): void {
        const set = this._listeners.get(event);
        if (!set) return;
        for (const handler of [...set]) {
            if (this._disposed) return;
            handler();
        }
    }

    // ─────────────────────────── 状态 ───────────────────────────

    getState(): ISheetState {
        const worksheet = this._ref.worksheet;
        const selection = this.controller.selection;
        const active = selection.active;
        const cell = worksheet.getCell(active.row, active.column);
        // 活动格样式算一次，cellText（数字格式渲染）和工具栏按下态共用
        const activeStyle = readActiveStyle(this.workbook, worksheet, active);

        return {
            sheets: this.workbook.getSheets().map((sheet) => ({
                id: sheet.id,
                name: sheet.name,
                tabColor: sheet.tabColor,
                hidden: sheet.hidden === 1,
            })),
            sheetId: worksheet.id,
            sheetName: worksheet.name,

            selection,
            selectionLabel: rangeLabel(selection, worksheet.rowCount, worksheet.columnCount),
            selectedCount: selectedCount(selection),

            cellText: worksheet.cellText(cell, activeStyle),
            editText: this.controller.editor.isOpen ? this.controller.editor.value : this._editText,
            isEditing: this.controller.editor.isOpen,

            zoom: this.renderer.zoom,
            scrollX: this.renderer.scrollX,
            scrollY: this.renderer.scrollY,

            canUndo: this.history.canUndo,
            canRedo: this.history.canRedo,
            undoLabel: this.history.undoLabel ?? '',
            redoLabel: this.history.redoLabel ?? '',

            stats: this._computeStats(),
            style: activeStyle,
        };
    }

    private _computeStats(): ISelectionStats {
        const worksheet = this._ref.worksheet;
        const selection = this.controller.selection;
        const total = selectedCount(selection);
        if (total > STATS_CELL_LIMIT) return EMPTY_STATS;

        let count = 0;
        let numericCount = 0;
        let sum = 0;
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;

        for (const range of selection.ranges) {
            for (let row = range.startRow; row <= range.endRow; row++) {
                for (let column = range.startColumn; column <= range.endColumn; column++) {
                    const value = worksheet.getCell(row, column)?.v;
                    if (value === undefined || value === null || value === '') continue;
                    count++;
                    if (typeof value !== 'number') continue;
                    numericCount++;
                    sum += value;
                    if (value < min) min = value;
                    if (value > max) max = value;
                }
            }
        }

        return {
            count,
            numericCount,
            sum,
            avg: numericCount > 0 ? sum / numericCount : 0,
            min: numericCount > 0 ? min : 0,
            max: numericCount > 0 ? max : 0,
        };
    }

    // ─────────────────────────── 编辑 ───────────────────────────

    beginEdit(row: number, column: number, initialValue?: string, selectAll = true): void {
        this.controller.beginEdit(row, column, initialValue, selectAll);
    }

    cancelEdit(): void {
        if (!this.controller.editor.isOpen) return;
        this.controller.editor.close();
        this._editText = '';
        this._emit('edit-change');
    }

    /** 公式栏实时输入：只同步到浮动编辑器，不产生撤销记录 */
    syncFromFormulaBar(text: string): void {
        this.controller.syncFromFormulaBar(text);
    }

    /** 公式栏确认（Enter / 失焦）：落库，产生一条撤销记录 */
    commitFromFormulaBar(text: string): void {
        this.controller.commitFromFormulaBar(text);
    }

    setSelection(selection: ISelection): void {
        this.controller.setSelection(selection);
    }

    getSelection(): ISelection {
        return this.controller.selection;
    }

    // ─────────────────────────── 只读 ───────────────────────────

    get isReadOnly(): boolean {
        return this._readOnly;
    }

    /** 只读：允许浏览/选中/复制，禁止一切写操作 */
    setReadOnly(readonly: boolean): void {
        this._readOnly = readonly;
        this.controller.setReadOnly(readonly);
        this.renderer.invalidate();
    }

    // ─────────────────────────── 命令 ───────────────────────────

    /** 执行任意编辑并入撤销栈 */
    execute(edit: IEdit): void {
        if (this._readOnly) return;
        this.history.push(edit);
    }

    /** 对整个选区套样式增量 —— 工具栏所有按钮的统一入口 */
    setRangeStyle(
        patch: IStylePatch | ((row: number, column: number, range: IRange) => IStylePatch),
        label = '设置样式'
    ): void {
        if (this._readOnly) return;
        const worksheet = this._ref.worksheet;
        for (const range of this.controller.selection.ranges) {
            this.history.push(createSetRangeStylesEdit(this.workbook, worksheet, range, patch, label));
        }
    }

    /** Ctrl+B / Ctrl+I / Ctrl+U：基于活动格当前状态取反 */
    toggleStyle(key: 'bl' | 'it' | 'ul' | 'st'): void {
        const current = readActiveStyle(
            this.workbook,
            this._ref.worksheet,
            this.controller.selection.active
        );
        this.setRangeStyle(togglePatch(current, key), `切换 ${key}`);
    }

    clearSelection(): void {
        if (this._readOnly) return;
        this.controller.clearSelection();
        this._emit('content-change');
    }

    undo(): void {
        if (this._readOnly) return;
        this.history.undo();
    }

    redo(): void {
        if (this._readOnly) return;
        this.history.redo();
    }

    // ─────────────────────────── 视口 ───────────────────────────

    setZoom(zoom: number): void {
        this.controller.setZoom(clamp(zoom, MIN_ZOOM, MAX_ZOOM));
    }

    /**
     * 更新其他协作者的选区。只影响渲染，不碰数据 —— 由协同层在 peers 变化时调用。
     */
    setRemoteSelections(selections: IRemoteSelection[]): void {
        this.renderer.remoteSelections = selections;
        this.renderer.invalidate();
    }

    get zoom(): number {
        return this.renderer.zoom;
    }

    scrollTo(x: number, y: number): void {
        this.renderer.scrollX = x;
        this.renderer.scrollY = y;
        this.controller.clampScroll();
        this._emit('scroll-change');
        this.renderer.invalidate();
    }

    // ─────────────────────────── 多 sheet ───────────────────────────

    getSheets(): ISheetSummary[] {
        return this.workbook.getSheets().map((sheet) => ({
            id: sheet.id,
            name: sheet.name,
            tabColor: sheet.tabColor,
            hidden: sheet.hidden === 1,
        }));
    }

    setActiveSheet(sheetId: string): void {
        if (sheetId === this._ref.worksheet.id) return;

        const next = this.workbook.getSheet(sheetId);
        if (!next) return;

        // 旧表记下滚动/缩放位置，将来切回来还是那个视角
        const current = this._ref.worksheet;
        current.scrollLeft = this.renderer.scrollX;
        current.scrollTop = this.renderer.scrollY;
        current.zoomRatio = this.renderer.zoom;

        if (!this.workbook.setActiveSheet(sheetId)) return;
        this._activate(next);
    }

    /** 把渲染/交互引用对齐到某张表 */
    private _activate(next: Worksheet): void {
        this._ref.worksheet = next;
        this._ref.skeleton = this._skeletonFor(next);
        this.renderer.skeleton = this._ref.skeleton;
        this.renderer.worksheet = next;
        this.renderer.scrollX = next.scrollLeft;
        this.renderer.scrollY = next.scrollTop;
        this.renderer.zoom = next.zoomRatio;
        this.controller.setSelection(singleSelection(0, 0));
        this.controller.clampScroll();

        this._emit('sheet-change');
        this._emit('selection-change');
        this.renderer.invalidate();
    }

    /** 新增一张空表并切过去，返回新表 id */
    addSheet(name?: string): string {
        if (this._readOnly) return '';
        const index = this.workbook.sheetOrder.length;
        const id = `sheet${Date.now().toString(36)}`;
        const sheet = createEmptyWorksheet({
            id,
            name: name ?? `Sheet${index + 1}`,
            rowCount: this._ref.worksheet.rowCount,
            columnCount: this._ref.worksheet.columnCount,
        });
        this.workbook.addSheet(sheet);
        this._registerWorksheet(sheet);
        // 协同层据此在 Y.Doc 里建出同样的表（index 是追加位置）
        this._changeHooks?.onSheetAdd?.(sheet, index);
        this.setActiveSheet(id);
        this._emit('content-change');
        return id;
    }

    removeSheet(sheetId: string): boolean {
        if (this._readOnly) return false;
        // 至少留一张表，否则整个视图没东西可画
        if (this.workbook.sheetOrder.length <= 1) return false;

        const index = this.workbook.sheetOrder.indexOf(sheetId);
        if (index < 0) return false;
        const wasActive = this._ref.worksheet.id === sheetId;
        if (!this.workbook.removeSheet(sheetId)) return false;

        this._skeletons.delete(sheetId);
        this._changeHooks?.onSheetRemove?.(sheetId, index);

        if (wasActive) {
            const next = this.workbook.getActiveSheet();
            if (next) this._activate(next);
        }
        this._emit('content-change');
        return true;
    }

    renameSheet(sheetId: string, name: string): boolean {
        if (this._readOnly) return false;
        const ok = this.workbook.renameSheet(sheetId, name);
        if (ok) {
            this._changeHooks?.onSheetRename?.(sheetId, name);
            this._emit('content-change');
            this._emit('sheet-change');
        }
        return ok;
    }

    // ─────────────────────────── 协同钩子 ───────────────────────────

    /**
     * 接上协同层。调用后所有本地数据变更都会回调出去。
     * 一个 `SheetEngine` 只接一个协同层（重复调用会覆盖）。
     */
    attachChangeHooks(hooks: IEngineChangeHooks | null): void {
        this._changeHooks = hooks;
        for (const sheet of this.workbook.getSheets()) {
            this._registerWorksheet(sheet);
        }
    }

    /** 给某张表的三个数据注册回调。新加的表也要走一遍 */
    private _registerWorksheet(worksheet: Worksheet): void {
        const hooks = this._changeHooks;
        const sheetId = worksheet.id;

        worksheet.cellData.onChange = hooks
            ? (row, column, next, before) =>
                  hooks.onCellChange(sheetId, row, column, next, before)
            : null;
        worksheet.rowData.onChange = hooks
            ? (index, next, before) => hooks.onRowChange(sheetId, index, next, before)
            : null;
        worksheet.columnData.onChange = hooks
            ? (index, next, before) => hooks.onColumnChange(sheetId, index, next, before)
            : null;
    }

    /**
     * 远端改动已写进工作表，通知 UI 刷新。
     *
     * 协同层收到别人更新后用 `applySilently` 写进矩阵（不触发 onChange 防回声），
     * 写完调这里把骨架缓存作废、重绘、发 content-change 让 React 重渲染。
     */
    notifyExternalChange(): void {
        if (this._disposed) return;
        for (const skeleton of this._skeletons.values()) {
            skeleton.invalidate();
        }
        this.renderer.invalidate();
        this._emit('content-change');
    }

    /**
     * 远端改了表级元信息（名字 / tabColor / 隐藏）。
     *
     * 和 notifyExternalChange 分开：这类改动不涉及单元格数据，不需要清骨架，
     * 但要发 `sheet-change` 让标签栏重新读 state。
     */
    notifySheetMetaChange(): void {
        if (this._disposed) return;
        this.renderer.invalidate();
        this._emit('sheet-change');
    }

    // ─────────────────────────── 序列化 ───────────────────────────

    toJSON(): IWorkbookData {
        const worksheet = this._ref.worksheet;
        worksheet.scrollLeft = this.renderer.scrollX;
        worksheet.scrollTop = this.renderer.scrollY;
        worksheet.zoomRatio = this.renderer.zoom;
        return saveWorkbook(this.workbook);
    }

    /** 从一份新 snapshot 重建。DevTools 灌压测数据用 */
    load(snapshot: Partial<IWorkbookData>): void {
        this._workbook = loadWorkbook(snapshot);
        this._skeletons.clear();
        // 撤销栈里存的是对旧 worksheet 的引用，留着会把数据写回旧对象
        this.history.clear();
        // 新的 worksheet 对象要重新挂协同钩子
        for (const sheet of this._workbook.getSheets()) {
            this._registerWorksheet(sheet);
        }

        const worksheet = this._workbook.getActiveSheet();
        if (!worksheet) return;

        this._ref.workbook = this._workbook;
        this._ref.worksheet = worksheet;
        this._ref.skeleton = this._skeletonFor(worksheet);
        this.renderer.skeleton = this._ref.skeleton;
        this.renderer.worksheet = worksheet;
        this.renderer.styles = this._workbook.styles;
        this.renderer.scrollX = 0;
        this.renderer.scrollY = 0;

        this.controller.setSelection(singleSelection(0, 0));
        this._emit('sheet-change');
        this._emit('content-change');
    }

    // ─────────────────────────── 生命周期 ───────────────────────────

    private _skeletonFor(worksheet: Worksheet): SheetSkeleton {
        let skeleton = this._skeletons.get(worksheet.id);
        if (!skeleton) {
            skeleton = new SheetSkeleton(worksheet, this._measureCtx);
            this._skeletons.set(worksheet.id, skeleton);
        }
        return skeleton;
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;

        this._resizeObserver.disconnect();
        this.controller.dispose();
        this.renderer.dispose();
        this._listeners.clear();
        this._skeletons.clear();

        const global = window as unknown as { __sheetEngine?: SheetEngine };
        if (global.__sheetEngine === this) delete global.__sheetEngine;
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

// ─────────────────────────── 对外再导出 ───────────────────────────
// UI 层只从这个入口取东西，不深入子目录 —— 将来换渲染后端 UI 不用动。

export * from './model/types';
export { loadWorkbook, saveWorkbook, createEmptyWorksheet } from './model/snapshot';
export { Workbook } from './model/workbook';
export { Worksheet } from './model/worksheet';
export { History, type IEdit } from './command/history';
export {
    createSetRangeValuesEdit,
    createClearRangeEdit,
    inferCellData,
} from './command/set-range-values';
export {
    createBorderPatch,
    createSetRangeStylesEdit,
    readActiveStyle,
    togglePatch,
    type BorderMode,
} from './command/set-range-styles';
export {
    InternalClipboard,
    buildPayload,
    createPasteEdit,
    matrixFromText,
    parseTSV,
    serializeToTSV,
} from './command/clipboard';
export { SheetSkeleton, cellReference, columnLabel, parseCellReference } from './render/skeleton';
export { Renderer } from './render/renderer';
export type { IRemoteSelection } from './render/extensions';
export {
    allSelection,
    columnSelection,
    primaryRange,
    rangeSelection,
    rowSelection,
    selectedCount,
    singleSelection,
    type ISelection,
} from './interact/selection';

/** 缩放范围，UI 的滑条要用 */
export { MIN_ZOOM, MAX_ZOOM };

/** 把样式 patch 拼成「置为某水平/垂直对齐 / 换行」 */
export function alignPatch(align: HA): IStylePatch {
    return { ht: align };
}

export function valignPatch(align: VA): IStylePatch {
    return { vt: align };
}

export function wrapPatch(wrap: boolean): IStylePatch {
    return { tb: wrap ? WS.WRAP : WS.CLIP };
}
