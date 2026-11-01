/**
 * A1 记法工具。
 *
 * 工具层对外统一使用 A1（模型对人话地址的准确率远高于 0-based 坐标），
 * 进入文档 API 前再转成 RangeSnapshot。
 */

import type { RangeSnapshot } from '@pgclouddoc/plugin-api';

export class RangeParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RangeParseError';
    }
}

export function columnLabel(index: number): string {
    let value = Math.max(0, Math.floor(index)) + 1;
    let label = '';
    while (value > 0) {
        const remainder = (value - 1) % 26;
        label = String.fromCharCode(65 + remainder) + label;
        value = Math.floor((value - 1) / 26);
    }
    return label;
}

export function parseColumn(label: string): number {
    const normalized = label.toUpperCase();
    let value = 0;
    for (const char of normalized) {
        const code = char.charCodeAt(0);
        if (code < 65 || code > 90) {
            throw new RangeParseError(`列名不合法：${label}`);
        }
        value = value * 26 + (code - 64);
    }
    return value - 1;
}

export function toA1Cell(row: number, column: number): string {
    return `${columnLabel(column)}${row + 1}`;
}

/** 单格时输出 `A1`，否则 `A1:C10` */
export function toA1(range: RangeSnapshot): string {
    const start = toA1Cell(range.startRow, range.startColumn);
    const end = toA1Cell(range.endRow, range.endColumn);
    return start === end ? start : `${start}:${end}`;
}

/** 拆出 `Sheet1!A1:C10` / `'Sheet 1'!A1` 的表名前缀 */
export function splitSheetPrefix(input: string): { sheet?: string; range: string } {
    const index = input.lastIndexOf('!');
    if (index <= 0) return { range: input.trim() };
    const rawSheet = input.slice(0, index).trim();
    const sheet = rawSheet.replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
    return { sheet: sheet || undefined, range: input.slice(index + 1).trim() };
}

const RANGE_PATTERN = /^([A-Za-z]+)([1-9]\d*)(?::([A-Za-z]+)([1-9]\d*))?$/;

export function parseA1Range(input: string): RangeSnapshot {
    const normalized = input.replace(/\$/g, '').replace(/\s+/g, '').trim();
    const match = RANGE_PATTERN.exec(normalized);
    if (!match) {
        throw new RangeParseError(`区域格式不合法：${input}（示例：A1:C10）`);
    }

    const startColumn = parseColumn(match[1]);
    const startRow = Number(match[2]) - 1;
    const endColumn = match[3] ? parseColumn(match[3]) : startColumn;
    const endRow = match[4] ? Number(match[4]) - 1 : startRow;

    return {
        startRow: Math.min(startRow, endRow),
        startColumn: Math.min(startColumn, endColumn),
        endRow: Math.max(startRow, endRow),
        endColumn: Math.max(startColumn, endColumn),
    };
}

/** 把区域裁剪到工作表边界；完全越界抛错 */
export function clampRangeToSheet(
    range: RangeSnapshot,
    rowCount: number,
    columnCount: number
): RangeSnapshot {
    if (rowCount <= 0 || columnCount <= 0) {
        throw new RangeParseError('工作表没有可用的行列');
    }
    const clamped: RangeSnapshot = {
        startRow: Math.max(0, Math.min(range.startRow, rowCount - 1)),
        startColumn: Math.max(0, Math.min(range.startColumn, columnCount - 1)),
        endRow: Math.max(0, Math.min(range.endRow, rowCount - 1)),
        endColumn: Math.max(0, Math.min(range.endColumn, columnCount - 1)),
    };
    if (clamped.endRow < clamped.startRow || clamped.endColumn < clamped.startColumn) {
        throw new RangeParseError('区域完全超出工作表范围');
    }
    return clamped;
}

export function cellCount(range: RangeSnapshot): number {
    return (
        (range.endRow - range.startRow + 1) *
        (range.endColumn - range.startColumn + 1)
    );
}

/** 按单元格上限裁剪区域，返回裁剪后的区域与是否截断 */
export function limitRange(
    range: RangeSnapshot,
    maxCells: number
): { range: RangeSnapshot; truncated: boolean } {
    const columns = range.endColumn - range.startColumn + 1;
    const maxRows = Math.max(1, Math.floor(maxCells / Math.max(1, columns)));
    const endRow = Math.min(range.endRow, range.startRow + maxRows - 1);
    return {
        range: { ...range, endRow },
        truncated: endRow < range.endRow,
    };
}
