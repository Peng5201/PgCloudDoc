/**
 * 写工具。
 *
 * 统一走两阶段：prepare 读取基线并生成 diff → 用户确认 → apply 走 transact。
 * 一次 apply = 一个撤销单元，且 apply 前会再次校验基线，避免覆盖别人的修改。
 */

import type { CellInput, StylePatch } from '@pgclouddoc/plugin-api';
import { cellCount, columnLabel, parseColumn, toA1Cell } from '../agent/a1';
import { ToolError, type DiffCell, type ToolHandler, type WritePlan } from '../agent/types';
import {
    argArray,
    argBoolean,
    argNumber,
    argString,
    assertCellBudget,
    diffMatrices,
    displayMatrix,
    guardedApply,
    readMatrix,
    resolveLocation,
    summarizeRange,
    valueToText,
    type MatrixValue,
} from './common';

const MAX_DIFF_ITEMS = 50;

// ─────────────────────────── write_range ───────────────────────────

export const writeRangeTool: ToolHandler = {
    kind: 'write',
    definition: {
        name: 'write_range',
        description:
            '向区域写入二维值矩阵。values 的行列数必须与 range 完全一致。字符串以 = 开头会被当作公式保存（不会自动计算）。null 表示删除该单元格。',
        parameters: {
            type: 'object',
            properties: {
                sheet: { type: 'string', description: '工作表名；省略则当前表' },
                range: { type: 'string', description: 'A1 区域，例如 A1:C3' },
                values: {
                    type: 'array',
                    description: '二维数组，每个元素是 string | number | boolean | null',
                    items: {
                        type: 'array',
                        items: { type: ['string', 'number', 'boolean', 'null'] },
                    },
                },
            },
            required: ['range', 'values'],
            additionalProperties: false,
        },
    },
    async prepare(args, { doc }): Promise<WritePlan> {
        const { sheet, range } = resolveLocation(doc, args, { mode: 'write' });
        const values = parseCellValues(argArray(args, 'values', { required: true })!);
        const rows = range.endRow - range.startRow + 1;
        const columns = range.endColumn - range.startColumn + 1;

        if (values.length !== rows || values.some((row) => row.length !== columns)) {
            throw new ToolError(
                'INVALID_ARGS',
                `values 必须是 ${rows} 行 × ${columns} 列，实际 ${values.length} 行`
            );
        }

        const beforeCells = await doc.getRangeValuesInSheet(sheet.id, range);
        const before = displayMatrix(beforeCells);
        const after = values.map((row) => row.map(valueToText));
        const { diff, totalChanges } = diffMatrices(range, before, after);

        return {
            toolName: 'write_range',
            title: `写入 ${summarizeRange(sheet, range)}`,
            summary: totalChanges
                ? `${totalChanges} 个单元格将被${after.flat().every((value) => value === '') ? '清空' : '修改'}`
                : '内容没有变化',
            diff,
            totalChanges,
            apply: guardedApply(doc, sheet.id, range, beforeCells, async () => {
                await doc.transactInSheet(sheet.id, 'AI：写入区域', (tx) => {
                    tx.setRangeValues(range, values);
                });
                return { sheet: sheet.name, range: summarizeRange(sheet, range), cells: rows * columns };
            }),
        };
    },
};

// ─────────────────────────── clear_range ───────────────────────────

export const clearRangeTool: ToolHandler = {
    kind: 'write',
    definition: {
        name: 'clear_range',
        description:
            '清空区域内容（连同值、公式和样式一起删除）。不可恢复，除非用户撤销。',
        parameters: {
            type: 'object',
            properties: {
                sheet: { type: 'string', description: '工作表名；省略则当前表' },
                range: { type: 'string', description: 'A1 区域，例如 A1:C10' },
            },
            required: ['range'],
            additionalProperties: false,
        },
    },
    async prepare(args, { doc }): Promise<WritePlan> {
        const { sheet, range } = resolveLocation(doc, args, { mode: 'write' });
        const beforeCells = await doc.getRangeValuesInSheet(sheet.id, range);
        const before = displayMatrix(beforeCells);
        const after = before.map((row) => row.map(() => ''));
        const { diff, totalChanges } = diffMatrices(range, before, after);

        return {
            toolName: 'clear_range',
            title: `清空 ${summarizeRange(sheet, range)}`,
            summary: totalChanges
                ? `${totalChanges} 个非空单元格将被清空`
                : '区域本来就是空的',
            diff,
            totalChanges,
            apply: guardedApply(doc, sheet.id, range, beforeCells, async () => {
                await doc.transactInSheet(sheet.id, 'AI：清空区域', (tx) => {
                    tx.clearRange(range);
                });
                return { sheet: sheet.name, range: summarizeRange(sheet, range) };
            }),
        };
    },
};

// ─────────────────────────── format_range ───────────────────────────

export const formatRangeTool: ToolHandler = {
    kind: 'write',
    definition: {
        name: 'format_range',
        description:
            '设置区域样式：加粗、斜体、下划线、删除线、字号、字体颜色、背景色、水平/垂直对齐、自动换行。只修改提供的字段。',
        parameters: {
            type: 'object',
            properties: {
                sheet: { type: 'string', description: '工作表名；省略则当前表' },
                range: { type: 'string', description: 'A1 区域，例如 A1:C1' },
                bold: { type: 'boolean', description: '加粗' },
                italic: { type: 'boolean', description: '斜体' },
                underline: { type: 'boolean', description: '下划线' },
                strike: { type: 'boolean', description: '删除线' },
                fontSize: { type: 'number', description: '字号（pt）' },
                fontColor: { type: 'string', description: '字体颜色，#RRGGBB' },
                backgroundColor: { type: 'string', description: '背景色，#RRGGBB' },
                horizontalAlign: {
                    type: 'string',
                    enum: ['left', 'center', 'right'],
                    description: '水平对齐',
                },
                verticalAlign: {
                    type: 'string',
                    enum: ['top', 'middle', 'bottom'],
                    description: '垂直对齐',
                },
                wrap: { type: 'boolean', description: '是否自动换行' },
            },
            required: ['range'],
            additionalProperties: false,
        },
    },
    async prepare(args, { doc }): Promise<WritePlan> {
        const { sheet, range } = resolveLocation(doc, args, { mode: 'write' });
        const { patch, labels } = buildStylePatch(args);
        const beforeCells = await doc.getRangeValuesInSheet(sheet.id, range);

        return {
            toolName: 'format_range',
            title: `设置样式 ${summarizeRange(sheet, range)}`,
            summary: labels.join('、'),
            diff: [],
            totalChanges: cellCount(range),
            apply: guardedApply(doc, sheet.id, range, beforeCells, async () => {
                await doc.transactInSheet(sheet.id, 'AI：设置样式', (tx) => {
                    tx.setRangeStyle(range, patch);
                });
                return {
                    sheet: sheet.name,
                    range: summarizeRange(sheet, range),
                    styles: labels,
                };
            }),
        };
    },
};

// ─────────────────────────── sort_range ───────────────────────────

export const sortRangeTool: ToolHandler = {
    kind: 'write',
    definition: {
        name: 'sort_range',
        description:
            '按一列或多列排序区域。默认第一行是表头，不参与排序。公式会作为文本一起移动。',
        parameters: {
            type: 'object',
            properties: {
                sheet: { type: 'string', description: '工作表名；省略则当前表' },
                range: { type: 'string', description: '要排序的 A1 区域（含表头）' },
                keys: {
                    type: 'array',
                    description: '排序键，按顺序比较',
                    items: {
                        type: 'object',
                        properties: {
                            column: {
                                type: ['number', 'string'],
                                description:
                                    '0-based 列序号（相对区域第一列），或工作表列字母（如 B）',
                            },
                            direction: {
                                type: 'string',
                                enum: ['asc', 'desc'],
                                description: '默认 asc',
                            },
                        },
                        required: ['column'],
                        additionalProperties: false,
                    },
                },
                hasHeader: {
                    type: 'boolean',
                    description: '第一行是否为表头，默认 true',
                },
            },
            required: ['range', 'keys'],
            additionalProperties: false,
        },
    },
    async prepare(args, { doc }): Promise<WritePlan> {
        const { sheet, range } = resolveLocation(doc, args, { mode: 'write' });
        assertCellBudget(range);

        const columns = range.endColumn - range.startColumn + 1;
        const keys = parseSortKeys(argArray(args, 'keys', { required: true })!, range, columns);
        const hasHeader = argBoolean(args, 'hasHeader', true);

        // 只重写数据行：表头不参与排序，也就不该被覆盖（否则表头样式会丢）
        const dataRange = { ...range, startRow: range.startRow + (hasHeader ? 1 : 0) };
        if (dataRange.startRow > dataRange.endRow) {
            throw new ToolError('INVALID_ARGS', '区域只有表头，没有可排序的数据行');
        }

        const beforeCells = await doc.getRangeValuesInSheet(sheet.id, dataRange);
        const matrix = await readMatrix(doc, sheet.id, dataRange);
        const data = matrix.slice();

        data.sort((left, right) => {
            for (const key of keys) {
                const result = compareValues(
                    left[key.column] ?? null,
                    right[key.column] ?? null
                );
                if (result !== 0) return key.direction === 'desc' ? -result : result;
            }
            return 0;
        });

        const next: MatrixValue[][] = data;
        const afterRows = next.map((row) => row.map(valueToText).join(' | '));
        const beforeRows = displayMatrix(beforeCells).map((row) => row.join(' | '));

        const diff: DiffCell[] = [];
        let totalChanges = 0;
        for (let index = 0; index < Math.max(beforeRows.length, afterRows.length); index++) {
            if (beforeRows[index] === afterRows[index]) continue;
            totalChanges++;
            if (diff.length < MAX_DIFF_ITEMS) {
                diff.push({
                    address: toA1Cell(dataRange.startRow + index, dataRange.startColumn),
                    before: beforeRows[index] ?? '',
                    after: afterRows[index] ?? '',
                });
            }
        }

        return {
            toolName: 'sort_range',
            title: `排序 ${summarizeRange(sheet, range)}`,
            summary: totalChanges ? `${totalChanges} 行顺序将改变` : '顺序没有变化',
            diff,
            totalChanges,
            apply: guardedApply(doc, sheet.id, dataRange, beforeCells, async () => {
                await doc.transactInSheet(sheet.id, 'AI：排序', (tx) => {
                    tx.setRangeValues(dataRange, next as CellInput[][]);
                });
                return { sheet: sheet.name, range: summarizeRange(sheet, range), rows: data.length };
            }),
        };
    },
};

// ─────────────────────────── remove_duplicates ───────────────────────────

export const removeDuplicatesTool: ToolHandler = {
    kind: 'write',
    definition: {
        name: 'remove_duplicates',
        description:
            '按指定列去重：保留每个键第一次出现的行，其余行的内容被清空。默认第一行是表头。',
        parameters: {
            type: 'object',
            properties: {
                sheet: { type: 'string', description: '工作表名；省略则当前表' },
                range: { type: 'string', description: 'A1 区域（含表头）' },
                keyColumns: {
                    type: 'array',
                    description: '用于判重的列（0-based 相对序号或列字母）；省略表示所有列',
                    items: { type: ['number', 'string'] },
                },
                hasHeader: { type: 'boolean', description: '第一行是否为表头，默认 true' },
            },
            required: ['range'],
            additionalProperties: false,
        },
    },
    async prepare(args, { doc }): Promise<WritePlan> {
        const { sheet, range } = resolveLocation(doc, args, { mode: 'write' });
        assertCellBudget(range);

        const columns = range.endColumn - range.startColumn + 1;
        const keyColumns = parseKeyColumns(
            argArray(args, 'keyColumns'),
            range,
            columns,
            'keyColumns'
        );

        const beforeCells = await doc.getRangeValuesInSheet(sheet.id, range);
        const display = displayMatrix(beforeCells);
        const hasHeader = argBoolean(args, 'hasHeader', true);

        // 只重写数据行，保留表头及其样式
        const dataRange = { ...range, startRow: range.startRow + (hasHeader ? 1 : 0) };
        if (dataRange.startRow > dataRange.endRow) {
            throw new ToolError('INVALID_ARGS', '区域只有表头，没有可去重的数据行');
        }

        const matrix = await readMatrix(doc, sheet.id, dataRange);
        const seen = new Set<string>();
        const kept: MatrixValue[][] = [];
        const removedRows: number[] = [];

        for (let index = 0; index < matrix.length; index++) {
            const row = matrix[index];
            const key = keyColumns.map((column) => valueToText(row[column] ?? null)).join('\u0001');
            if (seen.has(key)) {
                removedRows.push(dataRange.startRow + index);
                continue;
            }
            seen.add(key);
            kept.push(row);
        }

        const next: MatrixValue[][] = Array.from({ length: matrix.length }, () =>
            new Array(columns).fill(null)
        );
        kept.forEach((row, index) => {
            next[index] = row;
        });

        const diff: DiffCell[] = removedRows.slice(0, MAX_DIFF_ITEMS).map((row) => {
            const index = row - range.startRow;
            return {
                address: `${columnLabel(range.startColumn)}${row + 1}:${columnLabel(range.endColumn)}${row + 1}`,
                before: display[index]?.join(' | ') ?? '',
                after: '',
            };
        });

        return {
            toolName: 'remove_duplicates',
            title: `去重 ${summarizeRange(sheet, range)}`,
            summary: removedRows.length
                ? `${removedRows.length} 行重复数据将被清空`
                : '没有发现重复行',
            diff,
            totalChanges: removedRows.length,
            apply: guardedApply(doc, sheet.id, dataRange, beforeCells.slice(hasHeader ? 1 : 0), async () => {
                await doc.transactInSheet(sheet.id, 'AI：删除重复行', (tx) => {
                    tx.setRangeValues(dataRange, next as CellInput[][]);
                });
                return {
                    sheet: sheet.name,
                    range: summarizeRange(sheet, range),
                    removed: removedRows.length,
                    kept: kept.length,
                };
            }),
        };
    },
};

// ─────────────────────────── find_replace ───────────────────────────

export const findReplaceTool: ToolHandler = {
    kind: 'write',
    definition: {
        name: 'find_replace',
        description:
            '在区域内查找并替换文本。默认替换全部匹配、不区分大小写。公式只替换公式原文中的文本。',
        parameters: {
            type: 'object',
            properties: {
                sheet: { type: 'string', description: '工作表名；省略则当前表' },
                range: { type: 'string', description: 'A1 区域；省略则有效数据区域' },
                find: { type: 'string', description: '要查找的文本' },
                replace: { type: 'string', description: '替换为的文本，可为空' },
                matchCase: { type: 'boolean', description: '是否区分大小写，默认 false' },
                all: { type: 'boolean', description: '是否替换全部匹配，默认 true' },
            },
            required: ['find', 'replace'],
            additionalProperties: false,
        },
    },
    async prepare(args, { doc }): Promise<WritePlan> {
        const { sheet, range } = resolveLocation(doc, args, {
            mode: 'write',
            defaultToUsed: !argString(args, 'range'),
        });

        const find = argString(args, 'find', { required: true, maxLength: 1_000 })!;
        const replace = typeof args['replace'] === 'string' ? (args['replace'] as string) : '';
        const matchCase = argBoolean(args, 'matchCase', false);
        const replaceAll = argBoolean(args, 'all', true);

        const beforeCells = await doc.getRangeValuesInSheet(sheet.id, range);
        const before = displayMatrix(beforeCells);
        const changes: Array<{ row: number; column: number; value: CellInput }> = [];
        const diff: DiffCell[] = [];
        let totalChanges = 0;
        let replacements = 0;

        for (let r = 0; r < beforeCells.length; r++) {
            for (let c = 0; c < beforeCells[r].length; c++) {
                const cell = beforeCells[r][c];
                const source =
                    cell.formula ?? (typeof cell.value === 'string' ? cell.value : null);
                if (source === null) continue;

                const { text, count } = replaceText(source, find, replace, matchCase, replaceAll);
                if (count === 0) continue;

                replacements += count;
                totalChanges++;
                changes.push({
                    row: range.startRow + r,
                    column: range.startColumn + c,
                    value: text,
                });

                if (diff.length < MAX_DIFF_ITEMS) {
                    diff.push({
                        address: toA1Cell(range.startRow + r, range.startColumn + c),
                        before: before[r][c] ?? '',
                        after: text,
                    });
                }
            }
        }

        return {
            toolName: 'find_replace',
            title: `查找替换 ${summarizeRange(sheet, range)}`,
            summary: replacements
                ? `${replacements} 处匹配，${totalChanges} 个单元格将被修改`
                : '没有找到匹配内容',
            diff,
            totalChanges,
            apply: guardedApply(doc, sheet.id, range, beforeCells, async () => {
                await doc.transactInSheet(sheet.id, 'AI：查找替换', (tx) => {
                    // 只写真正变化的单元格：未命中的格子和它们上面的样式完全不动
                    for (const change of changes) {
                        tx.setRangeValues(
                            {
                                startRow: change.row,
                                startColumn: change.column,
                                endRow: change.row,
                                endColumn: change.column,
                            },
                            [[change.value]]
                        );
                    }
                });
                return {
                    sheet: sheet.name,
                    range: summarizeRange(sheet, range),
                    replacements,
                    cellsChanged: totalChanges,
                };
            }),
        };
    },
};

export const writeTools: ToolHandler[] = [
    writeRangeTool,
    clearRangeTool,
    formatRangeTool,
    sortRangeTool,
    removeDuplicatesTool,
    findReplaceTool,
];

// ─────────────────────────── 辅助 ───────────────────────────

function parseCellValues(raw: unknown[]): CellInput[][] {
    return raw.map((row, rowIndex) => {
        if (!Array.isArray(row)) {
            throw new ToolError('INVALID_ARGS', `values 第 ${rowIndex + 1} 行必须是数组`);
        }
        return row.map((value, columnIndex) => {
            if (
                value === null ||
                typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean'
            ) {
                return value;
            }
            throw new ToolError(
                'INVALID_ARGS',
                `values 第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列的值类型不支持`
            );
        });
    });
}

function buildStylePatch(args: Record<string, unknown>): {
    patch: StylePatch;
    labels: string[];
} {
    const patch: StylePatch = {};
    const labels: string[] = [];

    const bold = optionalBoolean(args, 'bold');
    if (bold !== undefined) {
        patch.bl = bold ? 1 : 0;
        labels.push(bold ? '加粗' : '取消加粗');
    }
    const italic = optionalBoolean(args, 'italic');
    if (italic !== undefined) {
        patch.it = italic ? 1 : 0;
        labels.push(italic ? '斜体' : '取消斜体');
    }
    const underline = optionalBoolean(args, 'underline');
    if (underline !== undefined) {
        patch.ul = underline ? 1 : 0;
        labels.push(underline ? '下划线' : '取消下划线');
    }
    const strike = optionalBoolean(args, 'strike');
    if (strike !== undefined) {
        patch.st = strike ? 1 : 0;
        labels.push(strike ? '删除线' : '取消删除线');
    }

    const fontSize = argNumber(args, 'fontSize', { min: 1, max: 200 });
    if (fontSize !== undefined) {
        patch.fs = fontSize;
        labels.push(`字号 ${fontSize}pt`);
    }

    const fontColor = argString(args, 'fontColor');
    if (fontColor) {
        patch.cl = { rgb: normalizeColor(fontColor) };
        labels.push(`字体颜色 ${fontColor}`);
    }
    const backgroundColor = argString(args, 'backgroundColor');
    if (backgroundColor) {
        patch.bg = { rgb: normalizeColor(backgroundColor) };
        labels.push(`背景色 ${backgroundColor}`);
    }

    const horizontal = argString(args, 'horizontalAlign');
    if (horizontal) {
        const map: Record<string, number> = { left: 1, center: 2, right: 3 };
        if (!(horizontal in map)) {
            throw new ToolError('INVALID_ARGS', `horizontalAlign 只能是 left/center/right`);
        }
        patch.ht = map[horizontal];
        labels.push(`水平对齐 ${horizontal}`);
    }

    const vertical = argString(args, 'verticalAlign');
    if (vertical) {
        const map: Record<string, number> = { top: 1, middle: 2, bottom: 3 };
        if (!(vertical in map)) {
            throw new ToolError('INVALID_ARGS', `verticalAlign 只能是 top/middle/bottom`);
        }
        patch.vt = map[vertical];
        labels.push(`垂直对齐 ${vertical}`);
    }

    const wrap = optionalBoolean(args, 'wrap');
    if (wrap !== undefined) {
        patch.tb = wrap ? 3 : 2;
        labels.push(wrap ? '自动换行' : '取消自动换行');
    }

    if (labels.length === 0) {
        throw new ToolError('INVALID_ARGS', '至少提供一个样式字段');
    }
    return { patch, labels };
}

function optionalBoolean(
    args: Record<string, unknown>,
    name: string
): boolean | undefined {
    const value = args[name];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new ToolError('INVALID_ARGS', `${name} 必须是布尔值`);
}

function normalizeColor(input: string): string {
    const value = input.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toUpperCase();
    if (/^#[0-9a-fA-F]{3}$/.test(value)) {
        const [, r, g, b] = value;
        return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
    }
    throw new ToolError('INVALID_ARGS', `颜色必须是 #RRGGBB：${input}`);
}

function parseSortKeys(
    raw: unknown[],
    range: { startColumn: number; endColumn: number },
    columns: number
): Array<{ column: number; direction: 'asc' | 'desc' }> {
    if (raw.length === 0) throw new ToolError('INVALID_ARGS', 'keys 不能为空');

    return raw.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new ToolError('INVALID_ARGS', `keys 第 ${index + 1} 项格式不正确`);
        }
        const record = item as Record<string, unknown>;
        const column = resolveRelativeColumn(record['column'], range, columns, `keys[${index}].column`);
        const direction = record['direction'] === 'desc' ? 'desc' : 'asc';
        return { column, direction };
    });
}

function parseKeyColumns(
    raw: unknown[] | undefined,
    range: { startColumn: number; endColumn: number },
    columns: number,
    field: string
): number[] {
    if (!raw || raw.length === 0) {
        return Array.from({ length: columns }, (_, index) => index);
    }
    return raw.map((item, index) =>
        resolveRelativeColumn(item, range, columns, `${field}[${index}]`)
    );
}

/** 数字按「相对区域第一列」解释；字母按工作表绝对列解释 */
function resolveRelativeColumn(
    raw: unknown,
    range: { startColumn: number; endColumn: number },
    columns: number,
    field: string
): number {
    let relative: number;

    if (typeof raw === 'number' && Number.isFinite(raw)) {
        relative = Math.floor(raw);
    } else if (typeof raw === 'string' && /^[A-Za-z]+$/.test(raw.trim())) {
        relative = parseColumn(raw.trim()) - range.startColumn;
    } else {
        throw new ToolError(
            'INVALID_ARGS',
            `${field} 必须是 0-based 列序号或列字母`
        );
    }

    if (relative < 0 || relative >= columns) {
        throw new ToolError(
            'INVALID_ARGS',
            `${field} 超出区域列范围（0..${columns - 1}）`
        );
    }
    return relative;
}

function compareValues(left: MatrixValue, right: MatrixValue): number {
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    if (typeof left === 'boolean' && typeof right === 'boolean') {
        return Number(left) - Number(right);
    }
    return String(left).localeCompare(String(right), 'zh-Hans-CN', { numeric: true });
}

function replaceText(
    source: string,
    find: string,
    replace: string,
    matchCase: boolean,
    replaceAll: boolean
): { text: string; count: number } {
    if (find === '') return { text: source, count: 0 };

    if (matchCase) {
        const parts = source.split(find);
        const count = parts.length - 1;
        if (count === 0) return { text: source, count: 0 };
        const text = replaceAll
            ? parts.join(replace)
            : source.replace(find, replace);
        return { text, count: replaceAll ? count : 1 };
    }

    const pattern = new RegExp(escapeRegExp(find), replaceAll ? 'gi' : 'i');
    const matches = source.match(pattern);
    if (!matches) return { text: source, count: 0 };
    return { text: source.replace(pattern, replace), count: matches.length };
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
