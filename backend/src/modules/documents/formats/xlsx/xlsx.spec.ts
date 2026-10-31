/**
 * xlsx 读写往返测试（服务端）。
 *
 * 这一层最容易静默坏掉：值类型、日期序列号、公式、合并、样式去重任何一项错位，
 * 用户看到的是「导进去看着对，导出就散架」。用「构造 → 写 → 读回 → 断言」钉住契约。
 */

import { readXlsx, writeXlsx } from './xlsx';
import { CellLimitExceededError } from '../types';
import type { SnapshotWorkbook, SnapshotWorksheet } from '../../../../infra/yjs/ydoc.types';
import { excelSerialToDate, formatCellValue, isDateFormat } from './value-format';

function resolveStyle(
    data: SnapshotWorkbook,
    ref: string | Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
    if (ref == null) return undefined;
    if (typeof ref === 'string') return (data.styles[ref] ?? undefined) as Record<string, unknown> | undefined;
    return ref;
}

function sampleWorkbook(): SnapshotWorkbook {
    const sheet: SnapshotWorksheet = {
        id: 'sheet1',
        name: '销售数据',
        rowCount: 20,
        columnCount: 8,
        mergeData: [{ startRow: 6, startColumn: 0, endRow: 7, endColumn: 1 }],
        cellData: {
            0: { 0: { v: '产品', t: 1 } },
            1: {
                1: { v: 0.256, t: 2, s: 'pct' },
                2: { v: 1234.5, t: 2, s: 'money' },
            },
            2: { 2: { v: 45000, t: 2, s: 'date' } },
            3: { 3: { v: 10, t: 2, f: '=SUM(A1:A3)' } },
            4: { 4: { v: '标题', t: 1, s: 'header' } },
            6: { 0: { v: '合并区', t: 1 } },
            5: { 0: { v: '隐藏行', t: 1 } },
        },
        rowData: { 2: { h: 40 }, 5: { hd: 1 } },
        columnData: { 1: { w: 120 }, 6: { hd: 1 } },
        showGridlines: 1,
        freeze: { xSplit: 1, ySplit: 2, startRow: 2, startColumn: 1 },
    };

    return {
        id: 'wb',
        name: '测试工作簿',
        appVersion: '1.0.0',
        locale: '',
        styles: {
            pct: { n: { pattern: '0.00%' } },
            money: { n: { pattern: '#,##0.00' } },
            date: { n: { pattern: 'yyyy-mm-dd' } },
            header: {
                bl: 1,
                fs: 14,
                bg: { rgb: '#ffff00' },
                cl: { rgb: '#ff0000' },
                ht: 2,
            },
        },
        sheetOrder: ['sheet1'],
        sheets: { sheet1: sheet },
        resources: [],
    };
}

describe('xlsx 往返', () => {
    it('值 / 公式 / 合并 / 宽高 / 样式 都能原样读回', async () => {
        const buffer = await writeXlsx(sampleWorkbook());
        expect(buffer.length).toBeGreaterThan(0);

        const { workbook, cellCount } = await readXlsx(buffer);
        expect(workbook.sheetOrder).toHaveLength(1);
        expect(cellCount).toBeGreaterThan(0);

        const sheet = workbook.sheets[workbook.sheetOrder[0]];
        expect(sheet.name).toBe('销售数据');
        expect(sheet.mergeData).toEqual([
            { startRow: 6, startColumn: 0, endRow: 7, endColumn: 1 },
        ]);
        expect(sheet.cellData[6][0].v).toBe('合并区');
        // 合并区从属格不能重复主格的值
        expect(sheet.cellData[6]?.[1]).toBeUndefined();
        expect(sheet.cellData[7]?.[0]).toBeUndefined();

        expect(sheet.cellData[0][0].v).toBe('产品');

        const pct = sheet.cellData[1][1];
        expect(pct.v).toBeCloseTo(0.256, 6);
        expect(resolveStyle(workbook, pct.s)?.n).toEqual({ pattern: '0.00%' });

        const money = sheet.cellData[1][2];
        expect(money.v).toBeCloseTo(1234.5, 6);
        expect(resolveStyle(workbook, money.s)?.n).toEqual({ pattern: '#,##0.00' });

        const date = sheet.cellData[2][2];
        expect(date.v).toBeCloseTo(45000, 6);
        expect(resolveStyle(workbook, date.s)?.n).toEqual({ pattern: 'yyyy-mm-dd' });

        const formula = sheet.cellData[3][3];
        expect(formula.f).toBe('=SUM(A1:A3)');
        expect(formula.v).toBeCloseTo(10, 6);

        const headerStyle = resolveStyle(workbook, sheet.cellData[4][4].s)!;
        expect(headerStyle.bl).toBe(1);
        expect(headerStyle.fs).toBeCloseTo(14, 6);
        expect(headerStyle.bg).toEqual({ rgb: '#ffff00' });
        expect(headerStyle.cl).toEqual({ rgb: '#ff0000' });
        expect(headerStyle.ht).toBe(2);

        expect(sheet.rowData[2].h).toBeCloseTo(40, 0);
        expect(sheet.columnData[1].w).toBeCloseTo(120, 0);
        expect(sheet.rowData[5]?.hd).toBe(1);
        expect(sheet.columnData[6]?.hd).toBe(1);
        expect(sheet.freeze).toMatchObject({ xSplit: 1, ySplit: 2, startRow: 2, startColumn: 1 });
    });

    it('共享样式表按内容去重', async () => {
        const original = sampleWorkbook();
        original.sheets.sheet1.cellData[10] = {
            0: { v: 1, t: 2, s: 'pct' },
            1: { v: 2, t: 2, s: 'pct' },
        };

        const { workbook } = await readXlsx(await writeXlsx(original));
        const sheet = workbook.sheets[workbook.sheetOrder[0]];
        expect(sheet.cellData[10][0].s).toBe(sheet.cellData[10][1].s);
        expect(sheet.cellData[10][0].s).toBe(sheet.cellData[1][1].s);
    });

    it('空表也能读写，不会崩', async () => {
        const empty: SnapshotWorkbook = {
            id: 'empty',
            name: '空',
            appVersion: '1.0.0',
            styles: {},
            sheetOrder: ['s'],
            sheets: {
                s: {
                    id: 's',
                    name: 'Sheet1',
                    rowCount: 5,
                    columnCount: 3,
                    cellData: {},
                    rowData: {},
                    columnData: {},
                    mergeData: [],
                },
            },
        };
        const { workbook } = await readXlsx(await writeXlsx(empty));
        expect(workbook.sheets[workbook.sheetOrder[0]].name).toBe('Sheet1');
    });

    it('超过单元格上限时抛 CellLimitExceededError', async () => {
        const buffer = await writeXlsx(sampleWorkbook());
        await expect(readXlsx(buffer, { maxCells: 1 })).rejects.toBeInstanceOf(CellLimitExceededError);
    });

    it('共享公式会翻译成每一格自己的公式', async () => {
        // 先手工造一个含共享公式的 xlsx（master B1 + 两个从属格）
        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('S');
        ws.getCell('A1').value = 10;
        ws.getCell('A2').value = 20;
        ws.getCell('B1').value = { formula: 'A1*2', result: 20 };
        ws.getCell('B2').value = { sharedFormula: 'B1', result: 40 };
        ws.getCell('B3').value = { sharedFormula: 'B1', result: 0 };
        const src = (await wb.xlsx.writeBuffer()) as unknown as Buffer;

        const { workbook } = await readXlsx(src);
        const sheet = workbook.sheets[workbook.sheetOrder[0]];
        expect(sheet.cellData[0][1].f).toBe('=A1*2');
        // 从属格不能存成 `=B1`（主格地址），必须翻译
        expect(sheet.cellData[1][1].f).toBe('=A2*2');
        expect(sheet.cellData[2][1].f).toBe('=A3*2');
        expect(sheet.cellData[1][1].v).toBe(40);
    });
});

describe('数字格式渲染', () => {
    it('识别日期格式', () => {
        expect(isDateFormat('yyyy-mm-dd')).toBe(true);
        expect(isDateFormat('m/d/yyyy')).toBe(true);
        expect(isDateFormat('hh:mm:ss')).toBe(true);
        expect(isDateFormat('#,##0.00')).toBe(false);
        expect(isDateFormat('0.00%')).toBe(false);
        expect(isDateFormat('"yyyy"0')).toBe(false);
    });

    it('渲染日期 / 时间', () => {
        const iso = excelSerialToDate(45000)!.toISOString().slice(0, 10);
        expect(formatCellValue({ value: 45000, pattern: 'yyyy-mm-dd' })).toBe(iso);
        expect(formatCellValue({ value: 45000.5, pattern: 'hh:mm' })).toBe('12:00');
        expect(formatCellValue({ value: 45000.75, pattern: 'hh:mm:ss' })).toBe('18:00:00');
        expect(formatCellValue({ value: 45000.5, pattern: 'mm:ss' })).toBe('00:00');
        expect(formatCellValue({ value: 45000.75, pattern: 'hh:mm AM/PM' })).toBe('06:00 PM');
    });

    it('渲染数字 / 千分位 / 百分比', () => {
        expect(formatCellValue({ value: 1234567.891, pattern: '#,##0.00' })).toBe('1,234,567.89');
        expect(formatCellValue({ value: 0.256, pattern: '0.00%' })).toBe('25.60%');
        expect(formatCellValue({ value: 7, pattern: '000' })).toBe('007');
        expect(formatCellValue({ value: -12.5, pattern: '0.0' })).toBe('-12.5');
        expect(formatCellValue({ value: 42 })).toBe('42');
    });
});
