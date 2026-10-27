/**
 * 工作表模型。
 *
 * 对照 Univer: packages/core/src/sheets/worksheet.ts (1463 行)
 *
 * 职责边界：模型层**完全不知道** canvas 的存在。
 * 渲染层来读它，它不主动通知谁 —— 变更通知由 SheetEngine 的事件总线统一发。
 */

import { ObjectArray, ObjectMatrix } from './object-matrix';
import type {
    ICellData,
    IColumnData,
    IFreeze,
    IRange,
    IRowData,
    IStyleData,
    ObjectArrayPrimitive,
    ObjectMatrixPrimitive,
} from './types';
import { normalizeRange } from './types';

export const DEFAULT_ROW_HEIGHT = 24;
export const DEFAULT_COLUMN_WIDTH = 88;
export const DEFAULT_HEADER_WIDTH = 46;
export const DEFAULT_HEADER_HEIGHT = 24;

export class Worksheet {
    readonly id: string;
    name: string;
    tabColor: string;
    hidden: 0 | 1;

    rowCount: number;
    columnCount: number;
    zoomRatio: number;
    scrollTop: number;
    scrollLeft: number;
    defaultRowHeight: number;
    defaultColumnWidth: number;

    showGridlines: 0 | 1;
    gridlinesColor: string | null;

    rowHeaderWidth: number;
    columnHeaderHeight: number;

    /** 合并单元格。本次只存不渲染（见计划的「不做」清单） */
    readonly mergeData: IRange[];
    /** 冻结区。本次只存不渲染 */
    freeze: IFreeze;

    readonly cellData: ObjectMatrix<ICellData>;
    readonly rowData: ObjectArray<IRowData>;
    readonly columnData: ObjectArray<IColumnData>;

    constructor(init: {
        id: string;
        name: string;
        rowCount: number;
        columnCount: number;
        tabColor?: string;
        hidden?: 0 | 1;
        freeze?: IFreeze;
        zoomRatio?: number;
        scrollTop?: number;
        scrollLeft?: number;
        defaultRowHeight?: number;
        defaultColumnWidth?: number;
        showGridlines?: 0 | 1;
        gridlinesColor?: string | null;
        rowHeaderWidth?: number;
        columnHeaderHeight?: number;
        mergeData?: IRange[];
        cellData?: ObjectMatrixPrimitive<ICellData>;
        rowData?: ObjectArrayPrimitive<IRowData>;
        columnData?: ObjectArrayPrimitive<IColumnData>;
    }) {
        this.id = init.id;
        this.name = init.name;
        this.tabColor = init.tabColor ?? '';
        this.hidden = init.hidden ?? 0;
        this.rowCount = init.rowCount;
        this.columnCount = init.columnCount;
        this.zoomRatio = init.zoomRatio ?? 1;
        this.scrollTop = init.scrollTop ?? 0;
        this.scrollLeft = init.scrollLeft ?? 0;
        this.defaultRowHeight = init.defaultRowHeight ?? DEFAULT_ROW_HEIGHT;
        this.defaultColumnWidth = init.defaultColumnWidth ?? DEFAULT_COLUMN_WIDTH;
        this.showGridlines = init.showGridlines ?? 1;
        this.gridlinesColor = init.gridlinesColor ?? null;
        this.rowHeaderWidth = init.rowHeaderWidth ?? DEFAULT_HEADER_WIDTH;
        this.columnHeaderHeight = init.columnHeaderHeight ?? DEFAULT_HEADER_HEIGHT;
        this.mergeData = (init.mergeData ?? []).map(normalizeRange);
        this.freeze = init.freeze ?? {
            xSplit: 0,
            ySplit: 0,
            startRow: 0,
            startColumn: 0,
        };

        this.cellData = ObjectMatrix.fromJSON(init.cellData ?? {});
        this.rowData = ObjectArray.fromJSON(init.rowData ?? {});
        this.columnData = ObjectArray.fromJSON(init.columnData ?? {});
    }

    // ───────────────────────── 读接口 ─────────────────────────

    /** 渲染层唯一的单元格读入口 */
    getCell(row: number, column: number): ICellData | undefined {
        return this.cellData.getValue(row, column);
    }

    /**
     * 给样式引用解引用 —— 单元格 / 行 / 列的 `s` 都可能是共享表 id，也可能是内联对象。
     * 共享表在 Workbook 上，所以这里把表传进来。
     */
    resolveStyle(
        ref: IStyleData | string | null | undefined,
        styles: Record<string, IStyleData | null>
    ): IStyleData | undefined {
        if (ref == null) return undefined;
        return typeof ref === 'string' ? styles[ref] ?? undefined : ref;
    }

    /**
     * 取某个格子最终生效的样式。
     *
     * 优先级：单元格 > 行 > 列（对应 univer 的 defaultStyle 继承语义）。
     * 只取一层不做深合并 —— 合并会让每帧都产生新对象，得不偿失；
     * 真要「行背景 + 格子加粗」这种组合，写值时就把两者合并好存进共享表。
     */
    resolveCell(
        row: number,
        column: number,
        styles: Record<string, IStyleData | null>
    ): IStyleData | undefined {
        const cell = this.getCell(row, column);
        const fromCell = this.resolveStyle(cell?.s, styles);
        if (fromCell) return fromCell;

        const fromRow = this.resolveStyle(this.rowData.get(row)?.s, styles);
        if (fromRow) return fromRow;

        return this.resolveStyle(this.columnData.get(column)?.s, styles);
    }

    /** 行高：自定义值优先，否则默认 */
    getRowHeight(row: number): number {
        const data = this.rowData.get(row);
        return data?.h ?? this.defaultRowHeight;
    }

    getColumnWidth(column: number): number {
        const data = this.columnData.get(column);
        return data?.w ?? this.defaultColumnWidth;
    }

    isRowHidden(row: number): boolean {
        return this.rowData.get(row)?.hd === 1;
    }

    isColumnHidden(column: number): boolean {
        return this.columnData.get(column)?.hd === 1;
    }

    // ───────────────────────── 写接口 ─────────────────────────

    setRowHeight(row: number, height: number): void {
        this.rowData.merge(row, { h: height });
    }

    setColumnWidth(column: number, width: number): void {
        this.columnData.merge(column, { w: width });
    }

    // ───────────────────────── 帮助方法 ─────────────────────────

    /** 把越界的部分裁掉；裁完为空返回 null */
    clampRange(r: IRange): IRange | null {
        const normalized = normalizeRange(r);
        const startRow = Math.max(0, normalized.startRow);
        const startColumn = Math.max(0, normalized.startColumn);
        const endRow = Math.min(this.rowCount - 1, normalized.endRow);
        const endColumn = Math.min(this.columnCount - 1, normalized.endColumn);
        if (endRow < startRow || endColumn < startColumn) return null;
        return { startRow, startColumn, endRow, endColumn };
    }

    /** 整张表 */
    fullRange(): IRange {
        return {
            startRow: 0,
            startColumn: 0,
            endRow: Math.max(0, this.rowCount - 1),
            endColumn: Math.max(0, this.columnCount - 1),
        };
    }

    /** 单元格里显示的文本（公式优先显示公式原文，与 Excel 的编辑栏一致） */
    cellText(cell: ICellData | undefined): string {
        if (!cell) return '';
        if (cell.f != null) return cell.f;
        if (cell.v == null) return '';
        return String(cell.v);
    }

    /**
     * 拍平成可序列化 JSON —— 发给服务端的就是这个。
     *
     * 空的可选字段一律省略：`mergeData: []` 这种东西发出去只是噪音，
     * 而且会让「与输入往返一致」的校验失败。协议上越干净越好。
     */
    toJSON(): Record<string, unknown> {
        const json: Record<string, unknown> = {
            id: this.id,
            name: this.name,
            tabColor: this.tabColor,
            hidden: this.hidden,
            freeze: { ...this.freeze },
            rowCount: this.rowCount,
            columnCount: this.columnCount,
            zoomRatio: this.zoomRatio,
            scrollTop: this.scrollTop,
            scrollLeft: this.scrollLeft,
            defaultColumnWidth: this.defaultColumnWidth,
            defaultRowHeight: this.defaultRowHeight,
            mergeData: this.mergeData.map((r) => ({ ...r })),
            cellData: this.cellData.toJSON(),
            rowData: this.rowData.toJSON(),
            columnData: this.columnData.toJSON(),
            rowHeader: { width: this.rowHeaderWidth },
            columnHeader: { height: this.columnHeaderHeight },
            showGridlines: this.showGridlines,
        };
        if (this.gridlinesColor) {
            json.gridlinesColor = this.gridlinesColor;
        }
        return json;
    }
}
