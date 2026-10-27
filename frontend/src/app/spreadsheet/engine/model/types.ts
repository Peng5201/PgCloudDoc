/**
 * 表格数据契约 —— 与 Univer 的 IWorkbookData 同构的类型子集。
 *
 * 这些类型**手写**而非 `import '@univerjs/core'`：我们要的是「数据格式兼容」，
 * 不是「运行时依赖」。字段名和枚举取值都与 univer 对齐：
 *   packages/core/src/sheets/typedef.ts
 *   packages/core/src/types/interfaces/i-style-data.ts
 *   packages/core/src/types/enum/text-style.ts
 *   packages/core/src/types/enum/border-style-types.ts
 *
 * 对齐枚举取值很重要 —— 将来真要换回 univer（或后端按 univer 格式解析），
 * 一个 HorizontalAlign.LEFT=0/1 的错位就会让所有左对齐变居中。
 */

export type Nullable<T> = T | null;

/** univer 的 BooleanNumber：0 = false, 1 = true */
export type BooleanNumber = 0 | 1;

// ────────────────────────────── 枚举 ──────────────────────────────

/** 单元格值类型。1=字符串 2=数字 3=布尔 4=强制字符串（绿色小三角） */
export enum CellValueType {
    STRING = 1,
    NUMBER = 2,
    BOOLEAN = 3,
    FORCE_STRING = 4,
}

export enum HorizontalAlign {
    UNSPECIFIED = 0,
    LEFT = 1,
    CENTER = 2,
    RIGHT = 3,
    JUSTIFIED = 4,
    BOTH = 5,
    DISTRIBUTED = 6,
}

export enum VerticalAlign {
    UNSPECIFIED = 0,
    TOP = 1,
    MIDDLE = 2,
    BOTTOM = 3,
}

/** 长文本的换行策略 */
export enum WrapStrategy {
    UNSPECIFIED = 0,
    /** 溢出到右边空格子 */
    OVERFLOW = 1,
    /** 裁剪 */
    CLIP = 2,
    /** 换行 */
    WRAP = 3,
}

export enum BorderStyleTypes {
    NONE = 0,
    THIN = 1,
    HAIR = 2,
    DOTTED = 3,
    DASHED = 4,
    DASH_DOT = 5,
    DASH_DOT_DOT = 6,
    DOUBLE = 7,
    MEDIUM = 8,
    MEDIUM_DASHED = 9,
    MEDIUM_DASH_DOT = 10,
    MEDIUM_DASH_DOT_DOT = 11,
    SLANT_DASH_DOT = 12,
    THICK = 13,
}

/** 下划线 / 删除线的线型 */
export enum TextDecoration {
    NONE = 11,
    SINGLE = 12,
    DOUBLE = 10,
    THICK = 13,
}

// ────────────────────────────── 样式 ──────────────────────────────

/** 颜色。rgb 是 CSS 颜色串，th 是主题色 token（本引擎暂不解析 th） */
export interface IColorStyle {
    rgb?: Nullable<string>;
    th?: Nullable<string>;
}

export interface IBorderStyleData {
    /** 线型 */
    s: BorderStyleTypes;
    /** 线色 */
    cl: IColorStyle;
}

/**
 * 四边 + 对角线。注意键名是 t/r/b/l（top/right/bottom/left），
 * 不是 tl/tr/bl/br —— 对角线才是带下划线的 tl_br 之类。
 */
export interface IBorderData {
    t?: Nullable<IBorderStyleData>;
    r?: Nullable<IBorderStyleData>;
    b?: Nullable<IBorderStyleData>;
    l?: Nullable<IBorderStyleData>;
    tl_br?: Nullable<IBorderStyleData>;
    bl_tr?: Nullable<IBorderStyleData>;
}

export interface ITextDecoration {
    /** show */
    s: BooleanNumber;
    /** true（或缺省）时颜色跟随字体色 */
    c?: BooleanNumber;
    cl?: IColorStyle;
}

export interface IPaddingData {
    t?: number;
    r?: number;
    b?: number;
    l?: number;
}

/**
 * 单元格样式。
 *
 * 字段名保留 univer 的缩写（fs/bl/it/bg/cl/ht…）：
 * 同一份样式可能被上万个单元格按 id 引用，缩写是实打实的体积收益。
 */
export interface IStyleData {
    /** font-family */
    ff?: Nullable<string>;
    /** font-size，pt */
    fs?: number;
    /** italic */
    it?: BooleanNumber;
    /** bold */
    bl?: BooleanNumber;
    /** underline */
    ul?: Nullable<ITextDecoration>;
    /** strikethrough */
    st?: Nullable<ITextDecoration>;
    /** background */
    bg?: Nullable<IColorStyle>;
    /** foreground */
    cl?: Nullable<IColorStyle>;
    /** border */
    bd?: Nullable<IBorderData>;
    /** horizontal alignment */
    ht?: Nullable<HorizontalAlign>;
    /** vertical alignment */
    vt?: Nullable<VerticalAlign>;
    /** wrap strategy */
    tb?: Nullable<WrapStrategy>;
    /** padding */
    pd?: Nullable<IPaddingData>;
    /** number format pattern（本引擎只存不解析） */
    n?: Nullable<{ pattern: string }>;
}

/** 传给 setRangeStyle 的样式增量：null 表示「清除该字段」 */
export type IStylePatch = {
    [K in keyof IStyleData]?: IStyleData[K] | null;
};

// ────────────────────────────── 单元格 ──────────────────────────────

export type CellValue = string | number | boolean;

export interface ICellData {
    /** 样式：共享表里的 id，或内联样式对象 */
    s?: Nullable<IStyleData | string>;
    /** 原始值 */
    v?: Nullable<CellValue>;
    /** 值类型 */
    t?: Nullable<CellValueType>;
    /** 公式原文，如 `=SUM(A1:B4)`。本引擎只存不计算 */
    f?: Nullable<string>;
    /** 富文本（univer 文档结构）。本引擎只存不渲染 */
    p?: Nullable<unknown>;
}

// ────────────────────────────── 行列 ──────────────────────────────

export interface IRowData {
    /** height，像素 */
    h?: number;
    /** hidden */
    hd?: BooleanNumber;
    /** 样式 */
    s?: Nullable<IStyleData | string>;
}

export interface IColumnData {
    /** width，像素 */
    w?: number;
    /** hidden */
    hd?: BooleanNumber;
    /** 样式 */
    s?: Nullable<IStyleData | string>;
}

// ────────────────────────────── 表 ──────────────────────────────

/** 二维矩形区域。下标一律 0 基 */
export interface IRange {
    startRow: number;
    startColumn: number;
    endRow: number;
    endColumn: number;
}

/** 冻结区。本引擎读写保留，渲染忽略（见计划的「不做」清单） */
export interface IFreeze {
    /** 冻结列数 */
    xSplit: number;
    /** 冻结行数 */
    ySplit: number;
    /** 滚动区起始行 */
    startRow: number;
    /** 滚动区起始列 */
    startColumn: number;
}

export interface IWorksheetData {
    id: string;
    name: string;
    tabColor: string;
    hidden: BooleanNumber;

    freeze: IFreeze;

    rowCount: number;
    columnCount: number;
    zoomRatio: number;
    scrollTop: number;
    scrollLeft: number;
    defaultColumnWidth: number;
    defaultRowHeight: number;

    mergeData: IRange[];
    /** 稀疏：{ [row]: { [column]: ICellData } } */
    cellData: ObjectMatrixPrimitive<ICellData>;
    /** 稀疏：{ [row]: IRowData } */
    rowData: ObjectArrayPrimitive<IRowData>;
    /** 稀疏：{ [column]: IColumnData } */
    columnData: ObjectArrayPrimitive<IColumnData>;

    rowHeader: { width: number; hidden?: BooleanNumber };
    columnHeader: { height: number; hidden?: BooleanNumber };

    showGridlines: BooleanNumber;
    gridlinesColor?: Nullable<string>;
}

export interface IWorkbookData {
    id: string;
    name: string;
    appVersion: string;
    /** 文档语言。本引擎不做 i18n，但要原样搬运，否则保存一次就丢了 */
    locale?: Nullable<string>;
    /** 共享样式表：单元格按 id 引用 */
    styles: Record<string, Nullable<IStyleData>>;
    sheetOrder: string[];
    sheets: { [sheetId: string]: Partial<IWorksheetData> };
    defaultStyle?: Nullable<IStyleData | string>;
    /** 插件数据（筛选/批注/条件格式）。本引擎原样搬运，不解析 */
    resources?: unknown[];
}

// ────────────────────────────── 稀疏容器 ──────────────────────────────

/** JSON 形态：{ [row]: { [column]: T } } */
export type ObjectMatrixPrimitive<T> = Record<number, Record<number, T>>;

/** JSON 形态：{ [index]: T } */
export type ObjectArrayPrimitive<T> = Record<number, T>;

// ────────────────────────────── 小工具 ──────────────────────────────

export const range = (
    startRow: number,
    startColumn: number,
    endRow: number,
    endColumn: number
): IRange => ({ startRow, startColumn, endRow, endColumn });

/** 把任意角序的两个点归一化成 start <= end 的矩形 */
export function normalizeRange(a: IRange): IRange {
    return {
        startRow: Math.min(a.startRow, a.endRow),
        startColumn: Math.min(a.startColumn, a.endColumn),
        endRow: Math.max(a.startRow, a.endRow),
        endColumn: Math.max(a.startColumn, a.endColumn),
    };
}

export function rangeWidth(r: IRange): number {
    return r.endColumn - r.startColumn + 1;
}

export function rangeHeight(r: IRange): number {
    return r.endRow - r.startRow + 1;
}

export function rangeCellCount(r: IRange): number {
    return rangeWidth(r) * rangeHeight(r);
}

/** 两个矩形是否相交 */
export function rangesIntersect(a: IRange, b: IRange): boolean {
    return !(
        a.endRow < b.startRow ||
        b.endRow < a.startRow ||
        a.endColumn < b.startColumn ||
        b.endColumn < a.startColumn
    );
}
