/**
 * 工具层公共逻辑：参数校验、地址解析、读取、diff、基线校验。
 */

import type {
    CellSnapshot,
    RangeSnapshot,
    SheetDocumentApi,
    SheetInfoSnapshot,
} from '@pgclouddoc/plugin-api';
import {
    cellCount,
    clampRangeToSheet,
    parseA1Range,
    splitSheetPrefix,
    toA1,
    toA1Cell,
} from '../agent/a1';
import { ToolError, type DiffCell } from '../agent/types';

export const MAX_CELLS = 20_000;
export const MAX_DIFF_ITEMS = 50;

// ─────────────────────────── 参数 ───────────────────────────

export function argString(
    args: Record<string, unknown>,
    name: string,
    options: { required?: boolean; maxLength?: number } = {}
): string | undefined {
    const value = args[name];
    if (value === undefined || value === null || value === '') {
        if (options.required) throw new ToolError('INVALID_ARGS', `缺少参数 ${name}`);
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new ToolError('INVALID_ARGS', `参数 ${name} 必须是字符串`);
    }
    if (options.maxLength && value.length > options.maxLength) {
        throw new ToolError('INVALID_ARGS', `参数 ${name} 过长`);
    }
    return value;
}

export function argNumber(
    args: Record<string, unknown>,
    name: string,
    options: { required?: boolean; min?: number; max?: number } = {}
): number | undefined {
    const value = args[name];
    if (value === undefined || value === null || value === '') {
        if (options.required) throw new ToolError('INVALID_ARGS', `缺少参数 ${name}`);
        return undefined;
    }
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
        throw new ToolError('INVALID_ARGS', `参数 ${name} 必须是数字`);
    }
    if (options.min !== undefined && parsed < options.min) {
        throw new ToolError('INVALID_ARGS', `参数 ${name} 不能小于 ${options.min}`);
    }
    if (options.max !== undefined && parsed > options.max) {
        throw new ToolError('INVALID_ARGS', `参数 ${name} 不能大于 ${options.max}`);
    }
    return parsed;
}

export function argBoolean(
    args: Record<string, unknown>,
    name: string,
    fallback = false
): boolean {
    const value = args[name];
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new ToolError('INVALID_ARGS', `参数 ${name} 必须是布尔值`);
}

export function argArray(
    args: Record<string, unknown>,
    name: string,
    options: { required?: boolean } = {}
): unknown[] | undefined {
    const value = args[name];
    if (value === undefined || value === null) {
        if (options.required) throw new ToolError('INVALID_ARGS', `缺少参数 ${name}`);
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw new ToolError('INVALID_ARGS', `参数 ${name} 必须是数组`);
    }
    return value;
}

// ─────────────────────────── 地址 ───────────────────────────

export interface ResolvedLocation {
    sheet: SheetInfoSnapshot;
    range: RangeSnapshot;
}

export function resolveLocation(
    doc: SheetDocumentApi,
    args: Record<string, unknown>,
    options: { mode?: 'read' | 'write'; defaultToUsed?: boolean } = {}
): ResolvedLocation {
    const mode = options.mode ?? 'read';
    const rawRange = argString(args, 'range');
    const parsed = rawRange ? splitSheetPrefix(rawRange) : { range: '' };
    const sheetName = argString(args, 'sheet') ?? parsed.sheet;

    const sheets = doc.getSheetInfo();
    const activeId = safeActiveSheetId(doc);
    const sheet = sheetName
        ? sheets.find((item) => item.name === sheetName || item.id === sheetName)
        : (sheets.find((item) => item.id === activeId) ?? sheets[0]);

    if (!sheet) {
        throw new ToolError(
            'SHEET_NOT_FOUND',
            sheetName ? `找不到工作表：${sheetName}` : '当前没有可用的工作表'
        );
    }

    if (!parsed.range) {
        if (!options.defaultToUsed) {
            throw new ToolError('INVALID_ARGS', '缺少参数 range（示例：A1:C10）');
        }
        if (!sheet.usedRange) {
            throw new ToolError('EMPTY_SHEET', `工作表 ${sheet.name} 没有数据`);
        }
        return { sheet, range: sheet.usedRange };
    }

    let range: RangeSnapshot;
    try {
        range = parseA1Range(parsed.range);
    } catch (err) {
        throw new ToolError('INVALID_RANGE', err instanceof Error ? err.message : '区域不合法');
    }

    if (mode === 'write') {
        if (range.endRow >= sheet.rowCount || range.endColumn >= sheet.columnCount) {
            throw new ToolError(
                'RANGE_OUT_OF_BOUNDS',
                `区域超出工作表 ${sheet.name} 的范围（${sheet.rowCount} 行 × ${sheet.columnCount} 列）`
            );
        }
    } else {
        try {
            range = clampRangeToSheet(range, sheet.rowCount, sheet.columnCount);
        } catch (err) {
            throw new ToolError(
                'INVALID_RANGE',
                err instanceof Error ? err.message : '区域超出工作表范围'
            );
        }
    }

    assertCellBudget(range);
    return { sheet, range };
}

export function assertCellBudget(range: RangeSnapshot): void {
    if (cellCount(range) > MAX_CELLS) {
        throw new ToolError(
            'RANGE_TOO_LARGE',
            `区域包含 ${cellCount(range)} 个单元格，超过单次上限 ${MAX_CELLS}；请缩小范围或分批读取`
        );
    }
}

export function safeActiveSheetId(doc: SheetDocumentApi): string {
    try {
        return doc.getActiveSheetId();
    } catch {
        return '';
    }
}

// ─────────────────────────── 读取 ───────────────────────────

export type MatrixValue = string | number | boolean | null;

export function readMatrix(
    doc: SheetDocumentApi,
    sheetId: string,
    range: RangeSnapshot
): Promise<MatrixValue[][]> {
    return doc.getRangeValuesInSheet(sheetId, range).then((cells) =>
        cells.map((row) => row.map((cell) => cell.formula ?? cell.value))
    );
}

export function displayMatrix(cells: CellSnapshot[][]): string[][] {
    return cells.map((row) => row.map((cell) => cell.displayText));
}

export function valueToText(value: MatrixValue): string {
    return value === null ? '' : String(value);
}

// ─────────────────────────── diff ───────────────────────────

export function diffMatrices(
    range: RangeSnapshot,
    before: string[][],
    after: string[][]
): { diff: DiffCell[]; totalChanges: number } {
    const diff: DiffCell[] = [];
    let totalChanges = 0;

    for (let row = range.startRow; row <= range.endRow; row++) {
        for (let column = range.startColumn; column <= range.endColumn; column++) {
            const r = row - range.startRow;
            const c = column - range.startColumn;
            const previous = before[r]?.[c] ?? '';
            const next = after[r]?.[c] ?? '';
            if (previous === next) continue;

            totalChanges++;
            if (diff.length < MAX_DIFF_ITEMS) {
                diff.push({
                    address: toA1Cell(row, column),
                    before: previous,
                    after: next,
                });
            }
        }
    }

    return { diff, totalChanges };
}

/**
 * 应用前重新读取目标区域，与 prepare 时的基线比较。
 * 不一致说明用户在确认期间（或协作者）改了这块区域，必须重新规划。
 */
export function guardedApply(
    doc: SheetDocumentApi,
    sheetId: string,
    range: RangeSnapshot,
    baseline: CellSnapshot[][],
    apply: () => Promise<unknown>
): () => Promise<unknown> {
    return async () => {
        const current = await doc.getRangeValuesInSheet(sheetId, range);
        if (JSON.stringify(current) !== JSON.stringify(baseline)) {
            throw new ToolError(
                'CONFLICT',
                '目标区域在你确认之前已被修改，请重新读取后再试'
            );
        }
        return apply();
    };
}

export function summarizeRange(sheet: SheetInfoSnapshot, range: RangeSnapshot): string {
    return `${sheet.name}!${toA1(range)}`;
}
