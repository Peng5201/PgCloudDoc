/**
 * ExcelJS 样式 ↔ 快照样式（`SnapshotCellData.s` 引用的样式对象）的双向映射。
 *
 * 样式结构必须与前端 `IStyleData` 逐字段一致（见 ydoc.types.ts 的契约说明）：
 * 这里写进去的 `s` 会被前端按 id 解引用后直接当样式渲染。
 *
 * 关键约定：
 *   - 颜色：ExcelJS 用 ARGB（`FFRRGGBB`），快照里用 CSS 色（`#rrggbb`）
 *   - 主题色：只给 `{ theme, tint }` 没有 argb 的，直接跳过（不写错色）
 */

import type {
    Alignment,
    Border as ExcelBorder,
    Borders as ExcelBorders,
    Fill as ExcelFill,
    Font as ExcelFont,
    Style as ExcelStyle,
} from 'exceljs';

export type BooleanNumber = 0 | 1;

/** 与前端 IStyleData 同构 */
export interface StyleData {
    ff?: string | null;
    fs?: number;
    it?: BooleanNumber;
    bl?: BooleanNumber;
    ul?: { s: BooleanNumber; c?: BooleanNumber; cl?: ColorStyle } | null;
    st?: { s: BooleanNumber; c?: BooleanNumber; cl?: ColorStyle } | null;
    bg?: ColorStyle | null;
    cl?: ColorStyle | null;
    bd?: BorderData | null;
    ht?: number | null;
    vt?: number | null;
    tb?: number | null;
    pd?: { t?: number; r?: number; b?: number; l?: number } | null;
    n?: { pattern: string } | null;
}

export interface ColorStyle {
    rgb?: string | null;
    th?: string | null;
}

export interface BorderStyleData {
    s: number;
    cl: ColorStyle;
}

export interface BorderData {
    t?: BorderStyleData | null;
    r?: BorderStyleData | null;
    b?: BorderStyleData | null;
    l?: BorderStyleData | null;
    tl_br?: BorderStyleData | null;
    bl_tr?: BorderStyleData | null;
}

/** 值类型枚举（与前端 CellValueType 一致） */
export const CellValueType = {
    STRING: 1,
    NUMBER: 2,
    BOOLEAN: 3,
    FORCE_STRING: 4,
} as const;

/** 对齐 / 换行枚举（与前端一致） */
export const HorizontalAlign = {
    UNSPECIFIED: 0,
    LEFT: 1,
    CENTER: 2,
    RIGHT: 3,
    JUSTIFIED: 4,
    BOTH: 5,
    DISTRIBUTED: 6,
} as const;

export const VerticalAlign = {
    UNSPECIFIED: 0,
    TOP: 1,
    MIDDLE: 2,
    BOTTOM: 3,
} as const;

export const WrapStrategy = {
    UNSPECIFIED: 0,
    OVERFLOW: 1,
    CLIP: 2,
    WRAP: 3,
} as const;

export const BorderStyleTypes = {
    NONE: 0,
    THIN: 1,
    HAIR: 2,
    DOTTED: 3,
    DASHED: 4,
    DASH_DOT: 5,
    DASH_DOT_DOT: 6,
    DOUBLE: 7,
    MEDIUM: 8,
    MEDIUM_DASHED: 9,
    MEDIUM_DASH_DOT: 10,
    MEDIUM_DASH_DOT_DOT: 11,
    SLANT_DASH_DOT: 12,
    THICK: 13,
} as const;

// ─────────────────────────── 颜色 ───────────────────────────

export function argbToRgb(argb: string | undefined): string | undefined {
    if (!argb) return undefined;
    const hex = argb.replace(/^#/, '');
    if (hex.length === 8) return `#${hex.slice(2).toLowerCase()}`;
    if (hex.length === 6) return `#${hex.toLowerCase()}`;
    if (hex.length === 3) return `#${hex.toLowerCase()}`;
    return undefined;
}

export function rgbToArgb(rgb: string | undefined | null): string | undefined {
    if (!rgb) return undefined;
    const hex = rgb.replace(/^#/, '');
    if (hex.length === 6) return `FF${hex.toUpperCase()}`;
    if (hex.length === 8) return hex.toUpperCase();
    if (hex.length === 3) {
        return `FF${hex
            .split('')
            .map((c) => c + c)
            .join('')
            .toUpperCase()}`;
    }
    return undefined;
}

function toColorStyle(color: { argb?: string } | undefined): ColorStyle | undefined {
    const rgb = argbToRgb(color?.argb);
    return rgb ? { rgb } : undefined;
}

// ─────────────────────────── 边框 ───────────────────────────

const BORDER_FROM_EXCEL: Record<string, number> = {
    thin: BorderStyleTypes.THIN,
    hair: BorderStyleTypes.HAIR,
    dotted: BorderStyleTypes.DOTTED,
    dashed: BorderStyleTypes.DASHED,
    dashDot: BorderStyleTypes.DASH_DOT,
    dashDotDot: BorderStyleTypes.DASH_DOT_DOT,
    double: BorderStyleTypes.DOUBLE,
    medium: BorderStyleTypes.MEDIUM,
    mediumDashed: BorderStyleTypes.MEDIUM_DASHED,
    mediumDashDot: BorderStyleTypes.MEDIUM_DASH_DOT,
    mediumDashDotDot: BorderStyleTypes.MEDIUM_DASH_DOT_DOT,
    slantDashDot: BorderStyleTypes.SLANT_DASH_DOT,
    thick: BorderStyleTypes.THICK,
};

const BORDER_TO_EXCEL: Record<number, ExcelBorder['style']> = {
    [BorderStyleTypes.THIN]: 'thin',
    [BorderStyleTypes.HAIR]: 'hair',
    [BorderStyleTypes.DOTTED]: 'dotted',
    [BorderStyleTypes.DASHED]: 'dashed',
    [BorderStyleTypes.DASH_DOT]: 'dashDot',
    [BorderStyleTypes.DASH_DOT_DOT]: 'dashDotDot',
    [BorderStyleTypes.DOUBLE]: 'double',
    [BorderStyleTypes.MEDIUM]: 'medium',
    [BorderStyleTypes.MEDIUM_DASHED]: 'mediumDashed',
    [BorderStyleTypes.MEDIUM_DASH_DOT]: 'mediumDashDot',
    [BorderStyleTypes.MEDIUM_DASH_DOT_DOT]: 'mediumDashDotDot',
    [BorderStyleTypes.SLANT_DASH_DOT]: 'slantDashDot',
    [BorderStyleTypes.THICK]: 'thick',
};

function borderFromExcel(border: Partial<ExcelBorder> | undefined): BorderStyleData | undefined {
    if (!border?.style) return undefined;
    const s = BORDER_FROM_EXCEL[border.style];
    if (s === undefined) return undefined;
    return { s, cl: toColorStyle(border.color as { argb?: string } | undefined) ?? {} };
}

function borderToExcel(border: BorderStyleData | null | undefined): Partial<ExcelBorder> | undefined {
    if (!border) return undefined;
    const style = BORDER_TO_EXCEL[border.s];
    if (!style) return undefined;
    const argb = rgbToArgb(border.cl?.rgb);
    return argb ? { style, color: { argb } } : { style };
}

function bordersFromExcel(borders: Partial<ExcelBorders> | undefined): BorderData | undefined {
    if (!borders) return undefined;
    const out: BorderData = {};
    const t = borderFromExcel(borders.top);
    const r = borderFromExcel(borders.right);
    const b = borderFromExcel(borders.bottom);
    const l = borderFromExcel(borders.left);
    if (t) out.t = t;
    if (r) out.r = r;
    if (b) out.b = b;
    if (l) out.l = l;
    const diag = borders.diagonal;
    if (diag?.style) {
        const d = borderFromExcel(diag);
        if (d) {
            if (diag.down) out.tl_br = d;
            if (diag.up) out.bl_tr = d;
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function bordersToExcel(bd: BorderData | null | undefined): Partial<ExcelBorders> | undefined {
    if (!bd) return undefined;
    const out: Partial<ExcelBorders> = {};
    const t = borderToExcel(bd.t);
    const r = borderToExcel(bd.r);
    const b = borderToExcel(bd.b);
    const l = borderToExcel(bd.l);
    if (t) out.top = t;
    if (r) out.right = r;
    if (b) out.bottom = b;
    if (l) out.left = l;
    if (bd.tl_br?.s !== undefined) {
        out.diagonal = { ...borderToExcel(bd.tl_br), down: true } as Partial<ExcelBorders['diagonal']>;
    } else if (bd.bl_tr?.s !== undefined) {
        out.diagonal = { ...borderToExcel(bd.bl_tr), up: true } as Partial<ExcelBorders['diagonal']>;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

// ─────────────────────────── 对齐 ───────────────────────────

const H_ALIGN_FROM_EXCEL: Record<string, number> = {
    left: HorizontalAlign.LEFT,
    center: HorizontalAlign.CENTER,
    right: HorizontalAlign.RIGHT,
    fill: HorizontalAlign.BOTH,
    justify: HorizontalAlign.JUSTIFIED,
    centerContinuous: HorizontalAlign.CENTER,
    distributed: HorizontalAlign.DISTRIBUTED,
};

const H_ALIGN_TO_EXCEL: Record<number, Alignment['horizontal']> = {
    [HorizontalAlign.LEFT]: 'left',
    [HorizontalAlign.CENTER]: 'center',
    [HorizontalAlign.RIGHT]: 'right',
    [HorizontalAlign.JUSTIFIED]: 'justify',
    [HorizontalAlign.BOTH]: 'fill',
    [HorizontalAlign.DISTRIBUTED]: 'distributed',
};

const V_ALIGN_FROM_EXCEL: Record<string, number> = {
    top: VerticalAlign.TOP,
    middle: VerticalAlign.MIDDLE,
    bottom: VerticalAlign.BOTTOM,
    justify: VerticalAlign.BOTTOM,
    distributed: VerticalAlign.MIDDLE,
};

const V_ALIGN_TO_EXCEL: Record<number, Alignment['vertical']> = {
    [VerticalAlign.TOP]: 'top',
    [VerticalAlign.MIDDLE]: 'middle',
    [VerticalAlign.BOTTOM]: 'bottom',
};

// ─────────────────────────── 读 / 写 ───────────────────────────

function decorationFromExcel(value: boolean | string | undefined): { s: BooleanNumber } | undefined {
    if (!value || value === 'none') return undefined;
    return { s: 1 };
}

function decorationToExcel(
    decoration: { s: BooleanNumber; c?: BooleanNumber; cl?: ColorStyle } | null | undefined
): 'single' | undefined {
    return decoration?.s === 1 ? 'single' : undefined;
}

/** ExcelJS `cell.style` → 快照样式。返回 undefined 表示无可表达样式 */
export function excelStyleToIStyle(style: Partial<ExcelStyle> | undefined): StyleData | undefined {
    if (!style) return undefined;
    const out: StyleData = {};

    const font = style.font as Partial<ExcelFont> | undefined;
    if (font) {
        if (font.name) out.ff = font.name;
        if (typeof font.size === 'number') out.fs = font.size;
        if (font.bold) out.bl = 1;
        if (font.italic) out.it = 1;
        const ul = decorationFromExcel(font.underline);
        if (ul) out.ul = ul;
        if (font.strike) out.st = { s: 1 };
        const cl = toColorStyle(font.color as { argb?: string } | undefined);
        if (cl) out.cl = cl;
    }

    const fill = style.fill as ExcelFill | undefined;
    if (fill && fill.type === 'pattern' && fill.pattern === 'solid') {
        const bg = toColorStyle(fill.fgColor as { argb?: string } | undefined);
        if (bg) out.bg = bg;
    }

    const alignment = style.alignment as Partial<Alignment> | undefined;
    if (alignment) {
        if (alignment.horizontal) {
            const ht = H_ALIGN_FROM_EXCEL[alignment.horizontal];
            if (ht !== undefined) out.ht = ht;
        }
        if (alignment.vertical) {
            const vt = V_ALIGN_FROM_EXCEL[alignment.vertical];
            if (vt !== undefined) out.vt = vt;
        }
        if (alignment.wrapText) out.tb = WrapStrategy.WRAP;
    }

    if (style.numFmt && style.numFmt !== 'General' && style.numFmt !== '@') {
        out.n = { pattern: style.numFmt };
    }

    const bd = bordersFromExcel(style.border as Partial<ExcelBorders> | undefined);
    if (bd) out.bd = bd;

    return Object.keys(out).length > 0 ? out : undefined;
}

/** 快照样式 → ExcelJS `cell.style` */
export function iStyleToExcelStyle(style: StyleData | undefined): Partial<ExcelStyle> {
    if (!style) return {};
    const out: Partial<ExcelStyle> = {};

    const font: Partial<ExcelFont> = {};
    if (style.ff) font.name = style.ff;
    if (typeof style.fs === 'number') font.size = style.fs;
    if (style.bl === 1) font.bold = true;
    if (style.it === 1) font.italic = true;
    const ul = decorationToExcel(style.ul);
    if (ul) font.underline = ul;
    if (style.st?.s === 1) font.strike = true;
    const clArgb = rgbToArgb(style.cl?.rgb);
    if (clArgb) font.color = { argb: clArgb };
    if (Object.keys(font).length > 0) out.font = font;

    const bgArgb = rgbToArgb(style.bg?.rgb);
    if (bgArgb) {
        out.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
    }

    const alignment: Partial<Alignment> = {};
    if (style.ht != null && style.ht !== HorizontalAlign.UNSPECIFIED) {
        alignment.horizontal = H_ALIGN_TO_EXCEL[style.ht];
    }
    if (style.vt != null && style.vt !== VerticalAlign.UNSPECIFIED) {
        alignment.vertical = V_ALIGN_TO_EXCEL[style.vt];
    }
    if (style.tb === WrapStrategy.WRAP) alignment.wrapText = true;
    if (Object.keys(alignment).length > 0) out.alignment = alignment;

    if (style.n?.pattern) out.numFmt = style.n.pattern;

    const border = bordersToExcel(style.bd);
    if (border) out.border = border;

    return out;
}

// ─────────────────────────── 尺寸换算 ───────────────────────────

/** 行：Excel 磅 → 像素；默认 15 磅 ≈ 20px */
export const EXCEL_ROW_PT_TO_PX = 96 / 72;

/** 列：Excel 字符宽 → 像素 */
export function excelColumnWidthToPx(width: number): number {
    return Math.round(width * 7 + 5);
}

export function pxToExcelColumnWidth(px: number): number {
    return Math.max(0, (px - 5) / 7);
}
