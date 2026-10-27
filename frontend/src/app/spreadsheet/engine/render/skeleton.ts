/**
 * 骨架 (Skeleton) —— 布局缓存层。
 *
 * 对照 Univer: packages/engine-render/src/components/sheets/sheet.render-skeleton.ts (1914 行)
 *
 * 职责边界：skeleton **不画任何像素**，它只回答几何问题：
 *   - 第 (r,c) 格子的像素矩形是多少？     → cellRect()
 *   - 视口左上角 (x,y) 落在第几个行列？   → locate()
 *   - 当前视口能看到哪些行列？            → visibleRange()
 *   - 这段文字有多宽？怎么断行？          → measureText() / wrapLines()
 *   - 这个样式画出来是什么颜色/字体？     → resolveColor() / fontOf()
 *
 * 为什么单独一层：
 *   文本测量是整条渲染链路里最贵的操作（要走一次字体栅格化）。
 *   把测量结果缓存起来，滚动时只测「可见区」的格子，
 *   一帧里只测几十次而不是几十万次。
 *
 * 缓存策略：dirty 标记 + ensure() 惰性重建。
 *   改了数据 → invalidate()（只翻一个布尔位，O(1)）
 *   要读布局 → ensure()（真脏了才重建）
 */

import { Accumulator } from './accumulator';
import type { Worksheet } from '../model/worksheet';
import type {
    HorizontalAlign,
    ICellData,
    IColorStyle,
    IRange,
    IStyleData,
    VerticalAlign,
    WrapStrategy,
} from '../model/types';
import {
    HorizontalAlign as HA,
    VerticalAlign as VA,
    WrapStrategy as WS,
} from '../model/types';

export interface IViewRect {
    startRow: number;
    endRow: number;
    startColumn: number;
    endColumn: number;
}

export interface IRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** 文本测量缓存的上限。超过就丢掉最久没用的那条 */
const TEXT_CACHE_LIMIT = 8000;

export const DEFAULT_FONT_FAMILY = 'Arial, "Microsoft YaHei", "PingFang SC", sans-serif';
export const DEFAULT_FONT_SIZE = 14;
export const DEFAULT_TEXT_COLOR = '#1f2329';
export const CELL_PADDING_X = 6;

export class SheetSkeleton {
    private readonly _rowAcc = new Accumulator();
    private readonly _colAcc = new Accumulator();

    /** font + text → 宽度。这是渲染链路里最贵的一步，务必走缓存 */
    private readonly _textWidthCache = new Map<string, number>();

    private _dirty = true;

    /** 视口裁剪时额外多画几行/几列，避免快速滚动时边缘露白 */
    readonly overscan = 1;

    constructor(
        readonly worksheet: Worksheet,
        private readonly _measureCtx: CanvasRenderingContext2D
    ) {}

    invalidate(): void {
        this._dirty = true;
    }

    invalidateTextCache(): void {
        this._textWidthCache.clear();
    }

    /** 惰性重建。所有读接口都先经过这里 */
    ensure(): void {
        if (!this._dirty) return;

        const ws = this.worksheet;
        const rowHeights = new Array<number>(ws.rowCount);
        for (let i = 0; i < ws.rowCount; i++) {
            rowHeights[i] = ws.isRowHidden(i) ? 0 : ws.getRowHeight(i);
        }

        const colWidths = new Array<number>(ws.columnCount);
        for (let i = 0; i < ws.columnCount; i++) {
            colWidths[i] = ws.isColumnHidden(i) ? 0 : ws.getColumnWidth(i);
        }

        this._rowAcc.rebuild(rowHeights);
        this._colAcc.rebuild(colWidths);
        this._dirty = false;
    }

    // ───────────────────────── 几何查询 ─────────────────────────

    /** 内容区总宽/总高（不含表头） */
    get contentWidth(): number {
        return this._colAcc.total;
    }

    get contentHeight(): number {
        return this._rowAcc.total;
    }

    get rowCount(): number {
        return this.worksheet.rowCount;
    }

    get columnCount(): number {
        return this.worksheet.columnCount;
    }

    getRowHeight(row: number): number {
        return this._rowAcc.size(row);
    }

    getColumnWidth(column: number): number {
        return this._colAcc.size(column);
    }

    /** 第 (row, column) 格子在内容坐标系里的矩形 */
    cellRect(row: number, column: number): IRect {
        return {
            x: this._colAcc.start(column),
            y: this._rowAcc.start(row),
            width: this._colAcc.size(column),
            height: this._rowAcc.size(row),
        };
    }

    /** 整行 / 整列的矩形（表头点选用） */
    rowRect(row: number): IRect {
        return {
            x: 0,
            y: this._rowAcc.start(row),
            width: this._colAcc.total,
            height: this._rowAcc.size(row),
        };
    }

    columnRect(column: number): IRect {
        return {
            x: this._colAcc.start(column),
            y: 0,
            width: this._colAcc.size(column),
            height: this._rowAcc.total,
        };
    }

    /** 一片区域的矩形（选区描边用） */
    rangeRect(range: IRange): IRect {
        const start = this.cellRect(range.startRow, range.startColumn);
        const end = this.cellRect(range.endRow, range.endColumn);
        return {
            x: start.x,
            y: start.y,
            width: end.x + end.width - start.x,
            height: end.y + end.height - start.y,
        };
    }

    /** 内容坐标 → 单元格下标 */
    locate(x: number, y: number): { row: number; column: number } {
        return { row: this._rowAcc.locate(y), column: this._colAcc.locate(x) };
    }

    /** 当前视口（内容坐标）能看到的行列范围。带 overscan，避免边缘闪烁 */
    visibleRange(view: { left: number; top: number; right: number; bottom: number }): IViewRect {
        const startRow = Math.max(0, this._rowAcc.locate(view.top) - this.overscan);
        const startColumn = Math.max(0, this._colAcc.locate(view.left) - this.overscan);
        const endRow = Math.min(this.rowCount - 1, this._rowAcc.locate(view.bottom) + this.overscan);
        const endColumn = Math.min(
            this.columnCount - 1,
            this._colAcc.locate(view.right) + this.overscan
        );
        return { startRow, endRow, startColumn, endColumn };
    }

    // ───────────────────────── 样式解析 ─────────────────────────

    /**
     * IColorStyle → CSS 颜色串。
     *
     * 样式里存的是 univer 的 `{ rgb: '#RRGGBB' }` 形状，画布只吃 CSS 颜色。
     * 这是模型层唯一的「形状转换」出口，保证 toJSON 往返不受渲染影响。
     */
    resolveColor(color?: IColorStyle | null, fallback = ''): string {
        if (!color) return fallback;
        if (color.rgb) return color.rgb;
        // 主题色 token 本引擎不解析，退回 fallback，避免画出 undefined
        return fallback;
    }

    /** 从样式拼出 CSS 字体串 */
    fontOf(style?: IStyleData): string {
        const size = style?.fs ?? DEFAULT_FONT_SIZE;
        const italic = style?.it ? 'italic ' : '';
        const bold = style?.bl ? 'bold ' : '';
        const family = style?.ff ? `${style.ff}, ${DEFAULT_FONT_FAMILY}` : DEFAULT_FONT_FAMILY;
        return `${italic}${bold}${size}px ${family}`;
    }

    /** 字号（px），垂直对齐时要用 */
    fontSize(style?: IStyleData): number {
        return style?.fs ?? DEFAULT_FONT_SIZE;
    }

    /** 水平对齐。样式优先，其次按数据类型给默认值（数字右对齐，文本左对齐） */
    horizontalAlign(cell: ICellData | undefined, style?: IStyleData): HorizontalAlign {
        const explicit = style?.ht;
        if (explicit !== undefined && explicit !== null && explicit !== HA.UNSPECIFIED) {
            return explicit;
        }
        return typeof cell?.v === 'number' ? HA.RIGHT : HA.LEFT;
    }

    /** 垂直对齐。默认居中 */
    verticalAlign(style?: IStyleData): VerticalAlign {
        const explicit = style?.vt;
        if (explicit !== undefined && explicit !== null && explicit !== VA.UNSPECIFIED) {
            return explicit;
        }
        return VA.MIDDLE;
    }

    /** 换行策略。默认溢出（Excel 的默认行为） */
    wrapStrategy(style?: IStyleData): WrapStrategy {
        const explicit = style?.tb;
        if (explicit !== undefined && explicit !== null && explicit !== WS.UNSPECIFIED) {
            return explicit;
        }
        return WS.OVERFLOW;
    }

    // ───────────────────────── 文本测量 ─────────────────────────

    /**
     * 缓存化的文本测量。
     *
     * LRU 语义：命中后挪到队尾，超限删队首。滚动大量不同内容时不会无限增长
     * （mini-sheets 里遗留的问题，这里补上）。
     */
    measureText(text: string, style?: IStyleData): number {
        const key = `${this.fontOf(style)} ${text}`;
        const hit = this._textWidthCache.get(key);
        if (hit !== undefined) {
            this._textWidthCache.delete(key);
            this._textWidthCache.set(key, hit);
            return hit;
        }

        this._measureCtx.font = this.fontOf(style);
        const width = this._measureCtx.measureText(text).width;

        if (this._textWidthCache.size >= TEXT_CACHE_LIMIT) {
            const oldest = this._textWidthCache.keys().next();
            if (!oldest.done) this._textWidthCache.delete(oldest.value);
        }
        this._textWidthCache.set(key, width);
        return width;
    }

    /**
     * 按可用宽度断行（WRAP 策略用）。
     *
     * 策略：贪心逐字符填充；放不下时回退到本行最后一个空格断开。
     * 对 CJK（无空格）等价于按字符断，对英文能保住单词完整。
     * 不做「自动行高」—— 行高仍是固定的，多出的行由绘制层裁剪。
     */
    wrapLines(text: string, style: IStyleData | undefined, maxWidth: number): string[] {
        if (maxWidth <= 0) return [text];

        const paragraphs = text.split('\n');
        const lines: string[] = [];

        for (const paragraph of paragraphs) {
            if (paragraph === '') {
                lines.push('');
                continue;
            }
            if (this.measureText(paragraph, style) <= maxWidth) {
                lines.push(paragraph);
                continue;
            }

            let line = '';
            let lastSpaceIndex = -1;

            for (const char of paragraph) {
                const candidate = line + char;
                if (this.measureText(candidate, style) <= maxWidth) {
                    line = candidate;
                    if (char === ' ') lastSpaceIndex = line.length;
                    continue;
                }

                if (line === '') {
                    // 单个字符就超宽 —— 也得放一个，否则会死循环
                    lines.push(char);
                    lastSpaceIndex = -1;
                    continue;
                }

                if (lastSpaceIndex > 0) {
                    lines.push(line.slice(0, lastSpaceIndex));
                    line = line.slice(lastSpaceIndex) + char;
                } else {
                    lines.push(line);
                    line = char;
                }
                lastSpaceIndex = -1;
            }
            if (line !== '') lines.push(line);
        }

        return lines.length > 0 ? lines : [''];
    }
}

/** 列下标 → Excel 字母：0→A, 25→Z, 26→AA */
export function columnLabel(index: number): string {
    let n = index;
    let label = '';
    do {
        label = String.fromCharCode(65 + (n % 26)) + label;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return label;
}

/** 列字母 → 下标：A→0, Z→25, AA→26。解析失败返回 -1 */
export function columnIndexFromLabel(label: string): number {
    const upper = label.toUpperCase();
    if (!/^[A-Z]+$/.test(upper)) return -1;
    let n = 0;
    for (const char of upper) {
        n = n * 26 + (char.charCodeAt(0) - 64);
    }
    return n - 1;
}

/** `B3` → { row: 2, column: 1 }。解析失败返回 null */
export function parseCellReference(ref: string): { row: number; column: number } | null {
    const match = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
    if (!match) return null;
    const column = columnIndexFromLabel(match[1] as string);
    const row = Number(match[2]) - 1;
    if (column < 0 || row < 0) return null;
    return { row, column };
}

/** { row, column } → `B3` */
export function cellReference(row: number, column: number): string {
    return `${columnLabel(column)}${row + 1}`;
}
