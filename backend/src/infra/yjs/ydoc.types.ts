/**
 * 快照数据契约 —— 与前端 `frontend/src/app/spreadsheet/engine/model/types.ts`
 * 的 `IWorkbookData` 同构。
 *
 * **刻意不 import 前端代码**：服务端不能依赖前端包。
 * 两边通过「字段名一致」达成契约，字段名变动必须同时改这两处，
 * 验收标准是「前端 loadWorkbook(后端快照) 往返后逐字段一致」。
 *
 * 这里只声明服务端真正会读写的字段，前端的完整类型以那边为准。
 */

export type CellValue = string | number | boolean;

export interface SnapshotCellData {
    /** 样式：共享表里的 id，或内联样式对象 */
    s?: string | Record<string, unknown> | null;
    /** 原始值 */
    v?: CellValue | null;
    /** 值类型：1=字符串 2=数字 3=布尔 4=强制字符串 */
    t?: number | null;
    /** 公式原文 */
    f?: string | null;
    /** 富文本，原样搬运 */
    p?: unknown;
}

export interface SnapshotRange {
    startRow: number;
    startColumn: number;
    endRow: number;
    endColumn: number;
}

export interface SnapshotWorksheet {
    id: string;
    name: string;
    tabColor?: string;
    hidden?: number;
    rowCount: number;
    columnCount: number;
    zoomRatio?: number;
    scrollTop?: number;
    scrollLeft?: number;
    defaultRowHeight?: number;
    defaultColumnWidth?: number;
    showGridlines?: number;
    gridlinesColor?: string | null;
    freeze?: { xSplit: number; ySplit: number; startRow: number; startColumn: number };
    rowHeader?: { width: number; hidden?: number };
    columnHeader?: { height: number; hidden?: number };
    cellData: Record<number, Record<number, SnapshotCellData>>;
    rowData: Record<number, { h?: number; hd?: number; s?: string | Record<string, unknown> }>;
    columnData: Record<number, { w?: number; hd?: number; s?: string | Record<string, unknown> }>;
    mergeData: SnapshotRange[];
}

export interface SnapshotWorkbook {
    id: string;
    name: string;
    appVersion: string;
    locale?: string | null;
    styles: Record<string, Record<string, unknown> | null>;
    sheetOrder: string[];
    sheets: Record<string, SnapshotWorksheet>;
    defaultStyle?: Record<string, unknown> | string | null;
    /** 插件数据，服务端不解析但要原样带回 */
    resources?: unknown[];
}
