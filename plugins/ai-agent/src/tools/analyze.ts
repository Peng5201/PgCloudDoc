/**
 * 分析工具：统计。
 *
 * 注意：引擎不计算公式，所以统计只基于**已存储的数值**；
 * 公式单元格会计入 formulaCount，但不参与求和。
 */

import type { CellSnapshot } from '@pgclouddoc/plugin-api';
import { columnLabel, toA1 } from '../agent/a1';
import type { ToolHandler } from '../agent/types';
import { argBoolean, resolveLocation } from './common';

interface ColumnStats {
    column: string;
    nonEmpty: number;
    numericCount: number;
    textCount: number;
    booleanCount: number;
    formulaCount: number;
    sum: number | null;
    avg: number | null;
    min: number | null;
    max: number | null;
}

export const computeStatsTool: ToolHandler = {
    kind: 'read',
    definition: {
        name: 'compute_stats',
        description:
            '统计区域：非空/数值/文本/布尔/公式单元格数量，以及数值列的求和、平均、最小、最大。公式不会被计算，只计入 formulaCount。',
        parameters: {
            type: 'object',
            properties: {
                sheet: { type: 'string', description: '工作表名；省略则当前表' },
                range: { type: 'string', description: 'A1 区域，例如 A1:C100' },
                perColumn: {
                    type: 'boolean',
                    description: '是否返回每一列的统计，默认 true',
                },
            },
            required: ['range'],
            additionalProperties: false,
        },
    },
    async run(args, { doc }) {
        const { sheet, range } = resolveLocation(doc, args);
        const perColumn = argBoolean(args, 'perColumn', true);
        const cells = await doc.getRangeValuesInSheet(sheet.id, range);

        const columns = range.endColumn - range.startColumn + 1;
        const byColumn: MutableStats[] = Array.from({ length: columns }, (_, index) =>
            createStats(columnLabel(range.startColumn + index))
        );
        const overall = createStats('全部');

        for (const row of cells) {
            row.forEach((cell, index) => {
                addCell(byColumn[index], cell);
                addCell(overall, cell);
            });
        }

        return {
            sheet: sheet.name,
            range: toA1(range),
            rows: cells.length,
            columns,
            overall: finalize(overall),
            byColumn: perColumn ? byColumn.map(finalize) : undefined,
            note: '公式单元格只保存公式原文，本引擎不计算公式，因此不参与数值统计。',
        };
    },
};

interface MutableStats {
    column: string;
    nonEmpty: number;
    numericCount: number;
    textCount: number;
    booleanCount: number;
    formulaCount: number;
    sum: number;
    min: number;
    max: number;
}

function createStats(column: string): MutableStats {
    return {
        column,
        nonEmpty: 0,
        numericCount: 0,
        textCount: 0,
        booleanCount: 0,
        formulaCount: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
    };
}

function addCell(stats: MutableStats | undefined, cell: CellSnapshot): void {
    if (!stats) return;
    if (cell.formula !== null) stats.formulaCount++;
    if (cell.value === null) return;

    stats.nonEmpty++;
    if (typeof cell.value === 'number') {
        stats.numericCount++;
        stats.sum += cell.value;
        stats.min = Math.min(stats.min, cell.value);
        stats.max = Math.max(stats.max, cell.value);
    } else if (typeof cell.value === 'boolean') {
        stats.booleanCount++;
    } else {
        stats.textCount++;
    }
}

function finalize(stats: MutableStats): ColumnStats {
    const hasNumeric = stats.numericCount > 0;
    return {
        column: stats.column,
        nonEmpty: stats.nonEmpty,
        numericCount: stats.numericCount,
        textCount: stats.textCount,
        booleanCount: stats.booleanCount,
        formulaCount: stats.formulaCount,
        sum: hasNumeric ? round(stats.sum) : null,
        avg: hasNumeric ? round(stats.sum / stats.numericCount) : null,
        min: hasNumeric ? round(stats.min) : null,
        max: hasNumeric ? round(stats.max) : null,
    };
}

function round(value: number): number {
    return Math.round(value * 1e6) / 1e6;
}
