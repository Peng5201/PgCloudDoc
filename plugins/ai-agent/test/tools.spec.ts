/**
 * 工具层行为测试。
 *
 * 重点验证：写入 diff、基线冲突、表头不被重写、查找替换只写命中格。
 */

import { describe, expect, it } from 'vitest';
import type { PluginContext } from '@pgclouddoc/plugin-api';
import { computeStatsTool } from '../src/tools/analyze';
import { outlineTool, readRangeTool } from '../src/tools/read';
import {
    findReplaceTool,
    formatRangeTool,
    removeDuplicatesTool,
    sortRangeTool,
    writeRangeTool,
} from '../src/tools/write';
import { FakeDoc } from './fake-doc';

const pluginContext = {} as PluginContext;

function context(doc: FakeDoc) {
    return {
        doc,
        ctx: pluginContext,
        signal: new AbortController().signal,
    };
}

describe('只读工具', () => {
    it('返回工作表结构', async () => {
        const doc = new FakeDoc();
        doc.setCell('sheet1', 0, 0, 'A1');
        doc.setCell('sheet1', 2, 2, 'C3');

        const result = (await outlineTool.run!({}, context(doc))) as {
            activeSheetId: string;
            sheets: Array<{ name: string; usedRange: string | null }>;
        };

        expect(result.activeSheetId).toBe('sheet1');
        expect(result.sheets[0]).toMatchObject({ name: 'Sheet1', usedRange: 'A1:C3' });
    });

    it('读取区域并支持 maxRows 截断', async () => {
        const doc = new FakeDoc();
        doc.setCell('sheet1', 0, 0, 1);
        doc.setCell('sheet1', 0, 1, 'x');
        doc.setCell('sheet1', 1, 0, 2);

        const result = (await readRangeTool.run!(
            { range: 'A1:B2', maxRows: 1 },
            context(doc)
        )) as {
            values: unknown[][];
            truncated: boolean;
            nextRange: string | null;
        };

        expect(result.values).toEqual([[1, 'x']]);
        expect(result.truncated).toBe(true);
        expect(result.nextRange).toBe('A2');
    });

    it('统计只计算已存储的数值', async () => {
        const doc = new FakeDoc();
        doc.setCell('sheet1', 0, 0, 1);
        doc.setCell('sheet1', 1, 0, 2);
        doc.setCell('sheet1', 0, 1, 'x');

        const result = (await computeStatsTool.run!(
            { range: 'A1:B2' },
            context(doc)
        )) as {
            overall: { nonEmpty: number; numericCount: number; textCount: number; sum: number; avg: number };
            byColumn: Array<{ column: string; numericCount: number }>;
        };

        expect(result.overall).toMatchObject({
            nonEmpty: 3,
            numericCount: 2,
            textCount: 1,
            sum: 3,
            avg: 1.5,
        });
        expect(result.byColumn[0]?.numericCount).toBe(2);
        expect(result.byColumn[1]?.numericCount).toBe(0);
    });
});

describe('写入工具', () => {
    it('生成 diff、应用后写入，并在基线变化时拒绝覆盖', async () => {
        const doc = new FakeDoc();
        doc.setCell('sheet1', 0, 0, 'old');
        doc.setCell('sheet1', 0, 1, 'x');

        const plan = await writeRangeTool.prepare!(
            { range: 'A1:B1', values: [['new', 'x']] },
            context(doc)
        );

        expect(plan.totalChanges).toBe(1);
        expect(plan.diff).toEqual([{ address: 'A1', before: 'old', after: 'new' }]);

        await plan.apply();

        expect(doc.cells.get('sheet1:0:0')?.value).toBe('new');
        expect(doc.transactions).toEqual(['AI：写入区域']);

        // 确认期间被别人改过：再次应用必须失败
        const stale = await writeRangeTool.prepare!(
            { range: 'A1:B1', values: [['third', 'x']] },
            context(doc)
        );
        doc.setCell('sheet1', 0, 0, 'changed-by-user');
        await expect(stale.apply()).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('排序只重写数据行，表头保持不变', async () => {
        const doc = new FakeDoc();
        doc.setCell('sheet1', 0, 0, 'name');
        doc.setCell('sheet1', 0, 1, 'score');
        doc.setCell('sheet1', 1, 0, 'b');
        doc.setCell('sheet1', 1, 1, 2);
        doc.setCell('sheet1', 2, 0, 'a');
        doc.setCell('sheet1', 2, 1, 1);

        const plan = await sortRangeTool.prepare!(
            { range: 'A1:B3', keys: [{ column: 1, direction: 'asc' }], hasHeader: true },
            context(doc)
        );

        expect(plan.totalChanges).toBe(2);
        await plan.apply();

        expect(doc.cells.get('sheet1:0:0')?.value).toBe('name');
        expect(doc.cells.get('sheet1:0:1')?.value).toBe('score');
        expect(doc.cells.get('sheet1:1:0')?.value).toBe('a');
        expect(doc.cells.get('sheet1:1:1')?.value).toBe(1);
        expect(doc.cells.get('sheet1:2:0')?.value).toBe('b');
        expect(doc.cells.get('sheet1:2:1')?.value).toBe(2);
        expect(doc.transactions).toEqual(['AI：排序']);
    });

    it('去重保留首次出现的行，并清空剩余行', async () => {
        const doc = new FakeDoc();
        doc.setCell('sheet1', 0, 0, 'name');
        doc.setCell('sheet1', 0, 1, 'id');
        doc.setCell('sheet1', 1, 0, 'a');
        doc.setCell('sheet1', 1, 1, 1);
        doc.setCell('sheet1', 2, 0, 'a');
        doc.setCell('sheet1', 2, 1, 1);
        doc.setCell('sheet1', 3, 0, 'b');
        doc.setCell('sheet1', 3, 1, 2);

        const plan = await removeDuplicatesTool.prepare!(
            { range: 'A1:B4', keyColumns: [0, 1], hasHeader: true },
            context(doc)
        );

        expect(plan.totalChanges).toBe(1);
        await plan.apply();

        expect(doc.cells.get('sheet1:1:0')?.value).toBe('a');
        expect(doc.cells.get('sheet1:2:0')?.value).toBe('b');
        expect(doc.cells.get('sheet1:3:0')).toBeUndefined();
        expect(doc.cells.get('sheet1:3:1')).toBeUndefined();
    });

    it('查找替换只写命中的单元格', async () => {
        const doc = new FakeDoc();
        doc.setCell('sheet1', 0, 0, 'foo');
        doc.setCell('sheet1', 0, 1, 'foo bar');
        doc.setCell('sheet1', 1, 0, 'untouched');

        const plan = await findReplaceTool.prepare!(
            { range: 'A1:B2', find: 'foo', replace: 'X', all: true },
            context(doc)
        );

        expect(plan.totalChanges).toBe(2);
        await plan.apply();

        expect(doc.cells.get('sheet1:0:0')?.value).toBe('X');
        expect(doc.cells.get('sheet1:0:1')?.value).toBe('X bar');
        expect(doc.cells.get('sheet1:1:0')?.value).toBe('untouched');
        // 只有 A1 / B1 被写，A2 / B2 完全不碰
        expect(doc.writtenCells.sort()).toEqual(['sheet1!0:0', 'sheet1!0:1']);
    });

    it('样式 patch 只包含提供的字段', async () => {
        const doc = new FakeDoc();

        const plan = await formatRangeTool.prepare!(
            {
                range: 'A1:B1',
                bold: true,
                backgroundColor: '#ff0000',
                horizontalAlign: 'center',
            },
            context(doc)
        );

        await plan.apply();
        expect(doc.styleCalls[0]?.patch).toEqual({
            bl: 1,
            bg: { rgb: '#FF0000' },
            ht: 2,
        });
    });
});

describe('工具注册', () => {
    it('只读文档不暴露写工具', async () => {
        const { toolDefinitions } = await import('../src/tools/registry');
        const writable = toolDefinitions(true).map((tool) => tool.name);
        const readonly = toolDefinitions(false).map((tool) => tool.name);

        expect(writable).toContain('write_range');
        expect(readonly).not.toContain('write_range');
        expect(readonly).toContain('read_range');
    });

    it('未知工具返回 undefined', async () => {
        const { getTool } = await import('../src/tools/registry');
        expect(getTool('nope')).toBeUndefined();
    });
});
