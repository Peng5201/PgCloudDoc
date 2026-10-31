/**
 * xlsx 读写 —— ExcelJS ↔ 服务端快照（`SnapshotWorkbook`）。
 *
 * 放在服务端而不是浏览器的原因：
 *   1. 协同真源是服务端 Y.Doc，导出必须基于它，前端手里的数据可能是旧的
 *   2. 解析大文件不该占用浏览器主线程，也不该把 ExcelJS 打进前端包
 *   3. 导入是一条「数据摄取」流程：解析 → 写入 Y.Doc → 落库，天然属于服务端
 *
 * 映射规则与前端显示保持一致（日期 = 序列号 + `n.pattern`），
 * 保证「导入 → 协同编辑 → 导出」一个来回不丢结构。
 */

import { Workbook } from 'exceljs';
import type {
    Cell as ExcelCell,
    CellFormulaValue,
    Column as ExcelColumn,
    Row as ExcelRow,
    Style as ExcelStyle,
    Worksheet as ExcelWorksheet,
} from 'exceljs';
import type {
    SnapshotCellData,
    SnapshotRange,
    SnapshotWorkbook,
    SnapshotWorksheet,
} from '../../../../infrastructure/yjs/ydoc.types';
import {
    CellValueType,
    EXCEL_ROW_PT_TO_PX,
    excelColumnWidthToPx,
    excelStyleToIStyle,
    iStyleToExcelStyle,
    pxToExcelColumnWidth,
    type StyleData,
} from './style-map';
import { dateToExcelSerial } from './value-format';
import { CellLimitExceededError } from '../types';

export interface IXlsxReadOptions {
    /** 工作簿显示名。缺省用「导入的工作簿」 */
    name?: string;
}

export interface IXlsxReadResult {
    workbook: SnapshotWorkbook;
    warnings: string[];
    /** 非空单元格总数，调用方据此做体量限制 */
    cellCount: number;
}

// ─────────────────────────── 样式去重 ───────────────────────────

function canonicalKey(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalKey).join(',')}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalKey(obj[k])}`).join(',')}}`;
}

class StyleRegistry {
    private readonly ids = new Map<string, string>();
    private readonly styles: Record<string, Record<string, unknown> | null> = {};
    private counter = 0;

    intern(style: StyleData | undefined): string | undefined {
        if (!style) return undefined;
        const key = canonicalKey(style);
        const existing = this.ids.get(key);
        if (existing) return existing;
        const id = `s${++this.counter}`;
        this.ids.set(key, id);
        this.styles[id] = style as Record<string, unknown>;
        return id;
    }

    toJSON(): Record<string, Record<string, unknown> | null> {
        return this.styles;
    }
}

// ─────────────────────────── 值 ───────────────────────────

interface IConvertedValue {
    v: string | number | boolean;
    t: number;
    f?: string;
}

function richTextToPlain(value: { richText?: Array<{ text?: string }> }): string {
    return (value.richText ?? []).map((run) => run.text ?? '').join('');
}

function convertValue(
    raw: unknown,
    numFmt: string | undefined,
    warnings: Set<string>,
    /**
     * 已翻译好的公式原文（来自 `cell.formula` getter）。
     *
     * 共享公式的从属格在 `cell.value` 里只有 `sharedFormula`（主格地址），
     * 拿它当公式会存成 `=A1` 这种错值；必须用 ExcelJS 翻译后的公式。
     */
    formulaText?: string
): IConvertedValue | null {
    if (raw === null || raw === undefined) return null;

    if (typeof raw === 'number') return { v: raw, t: CellValueType.NUMBER };
    if (typeof raw === 'boolean') return { v: raw, t: CellValueType.BOOLEAN };
    if (typeof raw === 'string') {
        if (raw === '') return null;
        return { v: raw, t: numFmt === '@' ? CellValueType.FORCE_STRING : CellValueType.STRING };
    }
    if (raw instanceof Date) return { v: dateToExcelSerial(raw), t: CellValueType.NUMBER };

    if (typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;

        // 普通公式有 obj.formula；共享公式从属格只有 translated 的 formulaText
        const formula =
            formulaText ?? (typeof obj.formula === 'string' ? obj.formula : undefined);
        if (formula !== undefined) {
            const converted = convertValue(obj.result, numFmt, warnings);
            const f = formula.startsWith('=') ? formula : `=${formula}`;
            return converted ? { ...converted, f } : { v: '', t: CellValueType.STRING, f };
        }

        if (typeof obj.error === 'string') {
            return { v: obj.error, t: CellValueType.STRING };
        }

        if (Array.isArray(obj.richText)) {
            warnings.add('富文本已压平为纯文本');
            return { v: richTextToPlain(obj), t: CellValueType.STRING };
        }

        if (typeof obj.text === 'string') {
            warnings.add('超链接已降级为纯文本');
            return { v: obj.text, t: CellValueType.STRING };
        }

        warnings.add(`未识别的单元格值类型，已跳过：${Object.keys(obj).join('/')}`);
        return null;
    }

    return null;
}

// ─────────────────────────── 地址 / 范围 ───────────────────────────

function parseCellAddress(address: string): { row: number; column: number } | null {
    const match = /^([A-Z]+)(\d+)$/i.exec(address.trim());
    if (!match) return null;
    let column = 0;
    for (const ch of match[1].toUpperCase()) {
        column = column * 26 + (ch.charCodeAt(0) - 64);
    }
    return { row: Number(match[2]) - 1, column: column - 1 };
}

export function cellAddress(row: number, column: number): string {
    let n = column + 1;
    let letters = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        letters = String.fromCharCode(65 + rem) + letters;
        n = Math.floor((n - 1) / 26);
    }
    return `${letters}${row + 1}`;
}

function parseRange(range: string): SnapshotRange | null {
    const parts = range.split(':');
    const start = parseCellAddress(parts[0]);
    const end = parseCellAddress(parts[1] ?? parts[0]);
    if (!start || !end) return null;
    return {
        startRow: Math.min(start.row, end.row),
        startColumn: Math.min(start.column, end.column),
        endRow: Math.max(start.row, end.row),
        endColumn: Math.max(start.column, end.column),
    };
}

function argbToCss(argb: string | undefined): string {
    if (!argb) return '';
    const hex = argb.replace(/^#/, '');
    if (hex.length === 8) return `#${hex.slice(2).toLowerCase()}`;
    if (hex.length === 6) return `#${hex.toLowerCase()}`;
    return '';
}

function defaultDatePattern(value: Date): string {
    const hasTime =
        value.getUTCHours() !== 0 || value.getUTCMinutes() !== 0 || value.getUTCSeconds() !== 0;
    return hasTime ? 'yyyy-mm-dd hh:mm:ss' : 'yyyy-mm-dd';
}

function readFreeze(ws: ExcelWorksheet): {
    xSplit: number;
    ySplit: number;
    startRow: number;
    startColumn: number;
} {
    const empty = { xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 };
    const view = ws.views?.[0];
    if (!view || view.state !== 'frozen') return empty;

    const xSplit = view.xSplit ?? 0;
    const ySplit = view.ySplit ?? 0;
    let startRow = ySplit;
    let startColumn = xSplit;

    const tl = (view as { topLeftCell?: string }).topLeftCell;
    if (tl) {
        const parsed = parseCellAddress(tl);
        if (parsed) {
            startRow = parsed.row;
            startColumn = parsed.column;
        }
    }
    return { xSplit, ySplit, startRow, startColumn };
}

// ─────────────────────────── 读 ───────────────────────────

/**
 * 是否是合并区里的从属格（不是左上角那格）。
 *
 * ExcelJS 对合并区里的每一格都返回主格的值（`cell.master` 指向左上角），
 * 直接读会把同一个值复制到合并区的每个格子。
 */
function isMergedSlave(cell: ExcelCell): boolean {
    return cell.isMerged === true && cell.master != null && cell.master.address !== cell.address;
}

function readWorksheet(
    ws: ExcelWorksheet,
    index: number,
    registry: StyleRegistry,
    warnings: Set<string>
): { sheet: SnapshotWorksheet; cellCount: number } {
    const id = `sheet${index + 1}`;

    const cellData: Record<number, Record<number, SnapshotCellData>> = {};
    const rowData: SnapshotWorksheet['rowData'] = {};
    const columnData: SnapshotWorksheet['columnData'] = {};

    let maxRow = 0;
    let maxColumn = 0;
    let cellCount = 0;

    ws.eachRow({ includeEmpty: true }, (row: ExcelRow, rowNumber: number) => {
        const r = rowNumber - 1;

        const rowMeta: SnapshotWorksheet['rowData'][number] = {};
        if (typeof row.height === 'number') rowMeta.h = row.height * EXCEL_ROW_PT_TO_PX;
        if (row.hidden) rowMeta.hd = 1;
        const rowStyleId = registry.intern(excelStyleToIStyle(row.model?.style));
        if (rowStyleId) rowMeta.s = rowStyleId;
        if (Object.keys(rowMeta).length > 0) rowData[r] = rowMeta;

        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            const c = colNumber - 1;
            const rawStyle = cell.style as Partial<ExcelStyle> | undefined;
            const numFmt = rawStyle?.numFmt;

            // 合并区的从属格：ExcelJS 会把主格的值复制到每一格。只保留左上角，
            // 否则同一个值会在合并区里重复出现（引擎目前也不渲染合并）。
            const isMergeSlave = isMergedSlave(cell);

            // `cell.formula` 会把共享公式翻译成当前格的公式；`cell.value` 里只有主格地址
            const formulaText = isMergeSlave
                ? undefined
                : typeof cell.formula === 'string'
                  ? cell.formula
                  : undefined;
            const converted = isMergeSlave
                ? null
                : convertValue(cell.value, numFmt, warnings, formulaText);

            let style = excelStyleToIStyle(rawStyle);
            if (cell.value instanceof Date && (!numFmt || numFmt === 'General' || numFmt === '@')) {
                style = { ...(style ?? {}), n: { pattern: defaultDatePattern(cell.value) } };
            }
            const styleId = registry.intern(style);

            if (!converted && !styleId) return;

            const out: SnapshotCellData = {};
            if (converted) {
                out.v = converted.v;
                out.t = converted.t;
                if (converted.f) out.f = converted.f;
            }
            if (styleId) out.s = styleId;

            (cellData[r] ??= {})[c] = out;
            cellCount += 1;
            if (r > maxRow) maxRow = r;
            if (c > maxColumn) maxColumn = c;
        });
    });

    const columns: Array<Partial<ExcelColumn> | null> = ws.columns ?? [];
    columns.forEach((col, idx) => {
        if (!col) return;
        const meta: SnapshotWorksheet['columnData'][number] = {};
        if (typeof col.width === 'number') meta.w = excelColumnWidthToPx(col.width);
        if (col.hidden) meta.hd = 1;
        const styleId = registry.intern(excelStyleToIStyle(col.style));
        if (styleId) meta.s = styleId;
        if (Object.keys(meta).length > 0) {
            columnData[idx] = meta;
            if (typeof col.width === 'number') maxColumn = Math.max(maxColumn, idx);
        }
    });

    const mergeData: SnapshotRange[] = [];
    for (const merge of ws.model?.merges ?? []) {
        const parsed = parseRange(merge);
        if (parsed) mergeData.push(parsed);
    }

    const props = ws.properties ?? {};

    return {
        cellCount,
        sheet: {
            id,
            name: ws.name,
            tabColor: argbToCss(props.tabColor?.argb),
            hidden: ws.state === 'visible' ? 0 : 1,
            freeze: readFreeze(ws),
            rowCount: Math.max(maxRow + 1, 100),
            columnCount: Math.max(maxColumn + 1, 26),
            zoomRatio: 1,
            scrollTop: 0,
            scrollLeft: 0,
            defaultRowHeight:
                typeof props.defaultRowHeight === 'number'
                    ? props.defaultRowHeight * EXCEL_ROW_PT_TO_PX
                    : 24,
            defaultColumnWidth:
                typeof props.defaultColWidth === 'number'
                    ? excelColumnWidthToPx(props.defaultColWidth)
                    : 88,
            mergeData,
            cellData,
            rowData,
            columnData,
            rowHeader: { width: 46 },
            columnHeader: { height: 24 },
            showGridlines: props.showGridLines === false ? 0 : 1,
            gridlinesColor: null,
        },
    };
}

/**
 * 解析 xlsx。
 *
 * @param source 文件内容（Buffer）
 * @param maxCells 单元格总数上限，超限抛 `CellLimitExceededError`
 */
export async function readXlsx(
    source: Buffer,
    options: IXlsxReadOptions & { maxCells?: number } = {}
): Promise<IXlsxReadResult> {
    const wb = new Workbook();
    await wb.xlsx.load(source as unknown as Parameters<typeof wb.xlsx.load>[0]);

    const registry = new StyleRegistry();
    const warnings = new Set<string>();

    const sheets: Record<string, SnapshotWorksheet> = {};
    const sheetOrder: string[] = [];
    let cellCount = 0;

    let index = 0;
    wb.eachSheet((ws) => {
        const { sheet, cellCount: sheetCells } = readWorksheet(ws, index, registry, warnings);
        sheets[sheet.id] = sheet;
        sheetOrder.push(sheet.id);
        cellCount += sheetCells;
        index += 1;
    });

    if (sheetOrder.length === 0) throw new Error('xlsx 里没有工作表');
    if (options.maxCells !== undefined && cellCount > options.maxCells) {
        throw new CellLimitExceededError(cellCount, options.maxCells);
    }

    if (sheetOrder.every((id) => sheets[id]?.hidden === 1)) {
        sheets[sheetOrder[0]].hidden = 0;
        warnings.add('全部工作表都是隐藏状态，已显示第一张');
    }

    const workbook: SnapshotWorkbook = {
        id: 'imported',
        name: options.name ?? '导入的工作簿',
        appVersion: '1.0.0',
        locale: '',
        styles: registry.toJSON(),
        sheetOrder,
        sheets,
        resources: [],
    };

    return { workbook, warnings: [...warnings], cellCount };
}

// ─────────────────────────── 写 ───────────────────────────

function resolveStyle(
    ref: string | Record<string, unknown> | null | undefined,
    styles: SnapshotWorkbook['styles']
): StyleData | undefined {
    if (ref == null) return undefined;
    if (typeof ref === 'string') return (styles[ref] ?? undefined) as StyleData | undefined;
    return ref as StyleData;
}

/** 生成 xlsx Buffer。只稀疏遍历实际单元格，不按 rowCount×columnCount 铺满 */
export async function writeXlsx(data: SnapshotWorkbook): Promise<Buffer> {
    const wb = new Workbook();
    wb.creator = 'PgCloudDoc';

    for (const sheetId of data.sheetOrder) {
        const sheet = data.sheets[sheetId];
        if (!sheet) continue;

        const ws = wb.addWorksheet(sheet.name || sheetId);
        const props = ws.properties;
        if (sheet.tabColor) props.tabColor = { argb: cssToArgb(sheet.tabColor) };
        if (typeof sheet.defaultRowHeight === 'number') {
            props.defaultRowHeight = sheet.defaultRowHeight / EXCEL_ROW_PT_TO_PX;
        }
        if (typeof sheet.defaultColumnWidth === 'number') {
            props.defaultColWidth = pxToExcelColumnWidth(sheet.defaultColumnWidth);
        }
        if (sheet.showGridlines === 0) props.showGridLines = false;
        ws.state = sheet.hidden === 1 ? 'hidden' : 'visible';

        if (sheet.freeze && (sheet.freeze.xSplit > 0 || sheet.freeze.ySplit > 0)) {
            ws.views = [
                {
                    state: 'frozen',
                    xSplit: sheet.freeze.xSplit,
                    ySplit: sheet.freeze.ySplit,
                    topLeftCell: cellAddress(sheet.freeze.startRow, sheet.freeze.startColumn),
                },
            ];
        }

        for (const key of Object.keys(sheet.rowData ?? {})) {
            const r = Number(key);
            const meta = sheet.rowData[r];
            if (!meta) continue;
            const row = ws.getRow(r + 1);
            if (typeof meta.h === 'number') row.height = meta.h / EXCEL_ROW_PT_TO_PX;
            if (meta.hd === 1) row.hidden = true;
            const style = resolveStyle(meta.s, data.styles);
            if (style) {
                (row as unknown as { style: Partial<ExcelStyle> }).style = iStyleToExcelStyle(style);
            }
        }

        for (const key of Object.keys(sheet.columnData ?? {})) {
            const c = Number(key);
            const meta = sheet.columnData[c];
            if (!meta) continue;
            const col = ws.getColumn(c + 1);
            if (typeof meta.w === 'number') col.width = pxToExcelColumnWidth(meta.w);
            if (meta.hd === 1) col.hidden = true;
            const style = resolveStyle(meta.s, data.styles);
            if (style) col.style = iStyleToExcelStyle(style);
        }

        for (const rowKey of Object.keys(sheet.cellData ?? {})) {
            const r = Number(rowKey);
            const rowMap = sheet.cellData[r];
            if (!rowMap) continue;
            for (const colKey of Object.keys(rowMap)) {
                const c = Number(colKey);
                const cell = rowMap[c];
                if (!cell) continue;

                const excelCell = ws.getCell(r + 1, c + 1);

                if (cell.f) {
                    excelCell.value = {
                        formula: cell.f.replace(/^=/, ''),
                        result: (cell.v ?? undefined) as CellFormulaValue['result'],
                    };
                } else if (cell.v !== undefined && cell.v !== null) {
                    excelCell.value = cell.v;
                }

                const style = resolveStyle(cell.s, data.styles);
                if (style) excelCell.style = iStyleToExcelStyle(style);
            }
        }

        for (const merge of sheet.mergeData ?? []) {
            const start = cellAddress(merge.startRow, merge.startColumn);
            const end = cellAddress(merge.endRow, merge.endColumn);
            if (start === end) continue;
            try {
                ws.mergeCells(`${start}:${end}`);
            } catch {
                // 重叠 / 非法合并：跳过，不让整个导出失败
            }
        }
    }

    return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}

function cssToArgb(color: string): string {
    const hex = color.replace(/^#/, '');
    if (hex.length === 8) return hex.toUpperCase();
    if (hex.length === 6) return `FF${hex.toUpperCase()}`;
    if (hex.length === 3) {
        return `FF${hex
            .split('')
            .map((c) => c + c)
            .join('')
            .toUpperCase()}`;
    }
    return 'FF000000';
}
