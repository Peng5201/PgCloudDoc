/**
 * 复制 / 剪切 / 粘贴。
 *
 * 对照 Univer: packages/sheets-ui/src/controllers/clipboard/
 *              clipboard.controller.ts + utils.ts
 *
 * 两套载荷同时维护：
 *   - **外部载荷** `text/plain`（TSV）+ `text/html`（<table>）
 *     给 Excel / WPS / 网页用。TSV 是表格界的通用语，Excel 粘贴时优先认它。
 *   - **内部载荷** 完整的 ICellData 二维数组
 *     表内粘贴用，能带上样式和公式，不只是纯文本。
 *
 * 写剪贴板走 `copy`/`cut` 事件的 `event.clipboardData`：
 * 这是唯一同步、无权限提示、且能同时写多种 MIME 的通道。
 * `navigator.clipboard.writeText()` 是异步的，在事件里调会来不及。
 */

import type { Worksheet } from '../model/worksheet';
import type { ICellData, IRange } from '../model/types';
import type { IEdit } from './history';
import { captureRange, inferCellData, restoreRange } from './set-range-values';

export const MIME_PLAIN = 'text/plain';
export const MIME_HTML = 'text/html';

export interface IClipboardPayload {
    /** TSV 文本，给外部应用 */
    text: string;
    /** HTML 表格，让 Excel 保留更好的结构 */
    html: string;
    /** 完整单元格数据，表内粘贴用 */
    matrix: ICellData[][];
    /** 来源区域，用于「粘贴到原处不动」的判断 */
    source: IRange | null;
}

// ─────────────────────────── 序列化 ───────────────────────────

/** 单个字段的 TSV 转义：含制表符/换行/引号就包一层引号，内部引号翻倍 */
function escapeTSVField(value: string): string {
    if (/[\t\n\r"]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

/** 一片区域 → TSV 文本 */
export function serializeToTSV(matrix: ICellData[][]): string {
    return matrix
        .map((row) => row.map((cell) => escapeTSVField(cellText(cell))).join('\t'))
        .join('\n');
}

/** 一片区域 → HTML 表格。Excel 读剪贴板时会优先用它 */
export function serializeToHTML(matrix: ICellData[][]): string {
    const rows = matrix
        .map(
            (row) =>
                `<tr>${row
                    .map((cell) => {
                        const text = escapeHTML(cellText(cell));
                        // \n 在 HTML 里不换行，转成 <br> 才能还原
                        return `<td>${text.replace(/\n/g, '<br>')}</td>`;
                    })
                    .join('')}</tr>`
        )
        .join('');
    return `<table data-sheet-engine="1">${rows}</table>`;
}

function escapeHTML(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 单元格显示文本。公式显示公式原文，与 Excel 编辑栏一致 */
export function cellText(cell: ICellData | undefined): string {
    if (!cell) return '';
    if (cell.f != null) return cell.f;
    if (cell.v == null) return '';
    return String(cell.v);
}

// ─────────────────────────── 反序列化 ───────────────────────────

/**
 * TSV → 文本矩阵。
 *
 * 处理 Excel 的引号包裹语法：字段含制表符/换行时整体加引号，内部引号写两个。
 * 不解析 `text/html` —— 各家表格软件的 HTML 千奇百怪，TSV 才是稳定契约。
 */
export function parseTSV(text: string): string[][] {
    if (text === '') return [['']];

    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i] as string;

        if (inQuotes) {
            if (char === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += char;
            }
            continue;
        }

        if (char === '"') {
            inQuotes = true;
        } else if (char === '\t') {
            row.push(field);
            field = '';
        } else if (char === '\n') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else if (char !== '\r') {
            field += char;
        }
    }

    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    return rows.length > 0 ? rows : [['']];
}

/** 文本矩阵 → 单元格矩阵（按输入推断类型） */
export function matrixFromText(text: string): ICellData[][] {
    return parseTSV(text).map((row) => row.map((cell) => inferCellData(cell)));
}

// ─────────────────────────── 取值 ───────────────────────────

/** 从工作表里抠出一片区域的单元格（含样式引用） */
export function extractMatrix(
    worksheet: Worksheet,
    range: IRange
): ICellData[][] {
    const out: ICellData[][] = [];
    for (let row = range.startRow; row <= range.endRow; row++) {
        const line: ICellData[] = [];
        for (let column = range.startColumn; column <= range.endColumn; column++) {
            const cell = worksheet.cellData.getValue(row, column);
            line.push(cell ? structuredClone(cell) : {});
        }
        out.push(line);
    }
    return out;
}

/** 构造一份可以直接塞进 clipboardData 的载荷 */
export function buildPayload(
    worksheet: Worksheet,
    range: IRange
): IClipboardPayload {
    const matrix = extractMatrix(worksheet, range);
    return {
        text: serializeToTSV(matrix),
        html: serializeToHTML(matrix),
        matrix,
        source: { ...range },
    };
}

// ─────────────────────────── 命令 ───────────────────────────

/**
 * 粘贴到 target 的左上角。
 *
 * - `matrix` 超出表边界的部分直接裁掉（Excel 会提示放不下，这里静默裁）
 * - 源区域比目标大时按源的形状铺开；目标选区 > 1 格且是源的整数倍时也铺开
 *   （Excel 的「选中 4 格粘贴 1 格 → 铺成 2×2」）
 * - undo 一次性回退整块
 */
export function createPasteEdit(
    worksheet: Worksheet,
    target: IRange,
    matrix: ICellData[][],
    label = '粘贴'
): IEdit {
    const sourceRows = matrix.length;
    const sourceColumns = matrix[0]?.length ?? 0;
    if (sourceRows === 0 || sourceColumns === 0) {
        return { label, redo() {}, undo() {} };
    }

    const targetRows = target.endRow - target.startRow + 1;
    const targetColumns = target.endColumn - target.startColumn + 1;

    // 铺开：目标区大于源时按整数倍平铺，否则只贴左上角
    const tileRows = targetRows > sourceRows && targetRows % sourceRows === 0 ? targetRows : sourceRows;
    const tileColumns =
        targetColumns > sourceColumns && targetColumns % sourceColumns === 0
            ? targetColumns
            : sourceColumns;

    const endRow = Math.min(worksheet.rowCount - 1, target.startRow + tileRows - 1);
    const endColumn = Math.min(worksheet.columnCount - 1, target.startColumn + tileColumns - 1);

    const area: IRange = {
        startRow: target.startRow,
        startColumn: target.startColumn,
        endRow,
        endColumn,
    };

    const snapshots = captureRange(worksheet, area);

    return {
        label,
        redo() {
            for (let row = area.startRow; row <= area.endRow; row++) {
                for (let column = area.startColumn; column <= area.endColumn; column++) {
                    const source =
                        matrix[(row - area.startRow) % sourceRows]?.[
                            (column - area.startColumn) % sourceColumns
                        ];
                    worksheet.cellData.setValue(row, column, structuredClone(source ?? {}));
                }
            }
        },
        undo: () => restoreRange(worksheet, snapshots),
    };
}

/**
 * 剪切 = 复制 + 清空，做成**一个** IEdit。
 * 这样 Ctrl+Z 一次就能把剪走的内容找回来，不会出现「粘贴撤销了但内容还是空的」。
 */
export function createCutEdit(
    worksheet: Worksheet,
    range: IRange
): IEdit {
    const snapshots = captureRange(worksheet, range);

    return {
        label: '剪切',
        redo() {
            for (const { row, column } of snapshots) {
                worksheet.cellData.realDeleteValue(row, column);
            }
        },
        undo: () => restoreRange(worksheet, snapshots),
    };
}

/**
 * 内部剪贴板。
 *
 * 为什么需要：`document.paste` 事件里读 `clipboardData` 拿到的只是文本，
 * 样式会丢。所以我们自己记一份完整的 ICellData 矩阵，
 * 粘贴时先看文本是否和上次复制的一致 —— 一致就说明是表内粘贴，用内部载荷。
 */
export class InternalClipboard {
    private _payload: IClipboardPayload | null = null;

    get payload(): IClipboardPayload | null {
        return this._payload;
    }

    set(payload: IClipboardPayload): void {
        this._payload = payload;
    }

    clear(): void {
        this._payload = null;
    }

    /**
     * 判断这份剪贴板文本是不是我们自己写进去的。
     * 是 → 表内粘贴，可以带样式；否 → 外部粘贴，按 TSV 解析。
     */
    matches(text: string): boolean {
        return this._payload !== null && this._payload.text === text;
    }
}
