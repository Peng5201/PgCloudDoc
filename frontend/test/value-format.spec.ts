/**
 * 数字格式渲染（前端显示层）。纯函数，node 环境可直接测。
 *
 * 服务端导入时把日期存成「序列号 + n.pattern」，这里负责把它渲染成人能读的形式。
 */

import { describe, expect, it } from 'vitest';
import {
    excelSerialToDate,
    formatCellValue,
    isDateFormat,
} from '../src/app/spreadsheet/engine/model/value-format';

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
    });

    it('无格式时退化为原始字符串', () => {
        expect(formatCellValue({ value: 42 })).toBe('42');
        expect(formatCellValue({ value: 'abc' })).toBe('abc');
    });
});
