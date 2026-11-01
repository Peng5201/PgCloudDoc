/**
 * 只读工具：文档结构、选区、区域读取、搜索。
 */

import type { ToolHandler } from '../agent/types';
import { ToolError } from '../agent/types';
import { limitRange, toA1, toA1Cell } from '../agent/a1';
import {
    argBoolean,
    argNumber,
    argString,
    readMatrix,
    resolveLocation,
    safeActiveSheetId,
    valueToText,
    MAX_CELLS,
} from './common';

const MAX_PREVIEW_CELLS = 200;

export const outlineTool: ToolHandler = {
    kind: 'read',
    definition: {
        name: 'get_document_outline',
        description:
            '获取当前文档的工作表列表、行列数和有效数据区域。开始任何任务前先调用它了解结构。',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    async run(_args, { doc }) {
        const activeId = safeActiveSheetId(doc);
        return {
            document: doc.title,
            activeSheetId: activeId,
            canWrite: doc.canWrite,
            sheets: doc.getSheetInfo().map((sheet) => ({
                id: sheet.id,
                name: sheet.name,
                hidden: sheet.hidden,
                rowCount: sheet.rowCount,
                columnCount: sheet.columnCount,
                usedRange: sheet.usedRange ? toA1(sheet.usedRange) : null,
                active: sheet.id === activeId,
            })),
        };
    },
};

export const selectionTool: ToolHandler = {
    kind: 'read',
    definition: {
        name: 'get_selection',
        description:
            '读取用户当前选区：活动单元格、所有选区地址，以及第一块选区的预览内容（最多 200 格）。',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    async run(_args, { doc }) {
        const selection = doc.getSelection();
        const activeId = safeActiveSheetId(doc);
        const sheet = doc.getSheetInfo().find((item) => item.id === activeId);
        const ranges = selection.ranges.map((range) => ({
            address: toA1(range),
            rows: range.endRow - range.startRow + 1,
            columns: range.endColumn - range.startColumn + 1,
        }));

        const first = selection.ranges[0];
        let preview: (string | number | boolean | null)[][] | null = null;
        let previewAddress: string | null = null;
        let truncated = false;

        if (first && sheet) {
            const limited = limitRange(first, MAX_PREVIEW_CELLS);
            truncated = limited.truncated;
            try {
                const matrix = await readMatrix(doc, sheet.id, limited.range);
                preview = matrix;
                previewAddress = toA1(limited.range);
            } catch {
                preview = null;
            }
        }

        return {
            sheet: sheet?.name ?? '',
            active: toA1Cell(selection.active.row, selection.active.column),
            ranges,
            preview,
            previewAddress,
            truncated,
        };
    },
};

export const readRangeTool: ToolHandler = {
    kind: 'read',
    definition: {
        name: 'read_range',
        description:
            '读取指定区域的单元格值。公式返回公式原文（本引擎不计算公式）。大区域请用 maxRows 分页。',
        parameters: {
            type: 'object',
            properties: {
                sheet: { type: 'string', description: '工作表名；省略则读当前活动表' },
                range: { type: 'string', description: 'A1 区域，例如 A1:C10' },
                maxRows: {
                    type: 'number',
                    description: '最多返回多少行，默认 200，最大 1000',
                },
            },
            required: ['range'],
            additionalProperties: false,
        },
    },
    async run(args, { doc }) {
        const { sheet, range } = resolveLocation(doc, args);
        const columns = range.endColumn - range.startColumn + 1;
        const requested = argNumber(args, 'maxRows', { min: 1, max: 1000 }) ?? 200;
        const maxByBudget = Math.max(1, Math.floor(MAX_CELLS / columns));
        const maxRows = Math.max(1, Math.min(requested, maxByBudget));

        const clipped = {
            ...range,
            endRow: Math.min(range.endRow, range.startRow + maxRows - 1),
        };
        const matrix = await readMatrix(doc, sheet.id, clipped);
        const truncated = clipped.endRow < range.endRow;

        return {
            sheet: sheet.name,
            range: toA1(clipped),
            rows: matrix.length,
            columns,
            values: matrix,
            truncated,
            nextRange: truncated
                ? toA1Cell(clipped.endRow + 1, range.startColumn)
                : null,
        };
    },
};

export const searchCellsTool: ToolHandler = {
    kind: 'read',
    definition: {
        name: 'search_cells',
        description:
            '在区域（默认有效数据区域）内查找文本。返回匹配的单元格地址和值。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '要查找的文本' },
                sheet: { type: 'string', description: '工作表名；省略则当前表' },
                range: { type: 'string', description: '搜索范围，例如 A1:C100；省略则有效数据区域' },
                matchCase: { type: 'boolean', description: '是否区分大小写，默认 false' },
                wholeCell: { type: 'boolean', description: '是否只匹配完整单元格，默认 false' },
                limit: { type: 'number', description: '最多返回多少条，默认 50，最大 200' },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
    async run(args, { doc }) {
        const query = argString(args, 'query', { required: true, maxLength: 500 })!.trim();
        if (!query) throw new ToolError('INVALID_ARGS', 'query 不能为空');

        const { sheet, range } = resolveLocation(doc, args, {
            defaultToUsed: !argString(args, 'range'),
        });
        const matchCase = argBoolean(args, 'matchCase', false);
        const wholeCell = argBoolean(args, 'wholeCell', false);
        const limit = Math.floor(argNumber(args, 'limit', { min: 1, max: 200 }) ?? 50);

        const matrix = await readMatrix(doc, sheet.id, range);
        const needle = matchCase ? query : query.toLowerCase();
        const matches: Array<{ address: string; value: string | number | boolean | null }> = [];
        let totalMatches = 0;

        for (let r = 0; r < matrix.length; r++) {
            for (let c = 0; c < matrix[r].length; c++) {
                const value = matrix[r][c];
                if (value === null) continue;
                const text = valueToText(value);
                if (!text) continue;
                const haystack = matchCase ? text : text.toLowerCase();
                const hit = wholeCell ? haystack === needle : haystack.includes(needle);
                if (!hit) continue;

                totalMatches++;
                if (matches.length < limit) {
                    matches.push({
                        address: toA1Cell(range.startRow + r, range.startColumn + c),
                        value,
                    });
                }
            }
        }

        return {
            sheet: sheet.name,
            range: toA1(range),
            query,
            matches,
            totalMatches,
            truncated: totalMatches > matches.length,
        };
    },
};

export const readTools: ToolHandler[] = [
    outlineTool,
    selectionTool,
    readRangeTool,
    searchCellsTool,
];
