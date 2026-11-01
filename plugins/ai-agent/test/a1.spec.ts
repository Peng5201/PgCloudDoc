import { describe, expect, it } from 'vitest';
import {
    cellCount,
    clampRangeToSheet,
    columnLabel,
    limitRange,
    parseA1Range,
    parseColumn,
    splitSheetPrefix,
    toA1,
    toA1Cell,
} from '../src/agent/a1';

describe('A1 记法', () => {
    it('列号与列字母互转', () => {
        expect(columnLabel(0)).toBe('A');
        expect(columnLabel(25)).toBe('Z');
        expect(columnLabel(26)).toBe('AA');
        expect(columnLabel(701)).toBe('ZZ');
        expect(columnLabel(702)).toBe('AAA');
        expect(parseColumn('A')).toBe(0);
        expect(parseColumn('AA')).toBe(26);
        expect(parseColumn('zz')).toBe(701);
    });

    it('单格与区域互转', () => {
        expect(toA1Cell(0, 0)).toBe('A1');
        expect(toA1({ startRow: 0, startColumn: 0, endRow: 2, endColumn: 2 })).toBe('A1:C3');
        expect(toA1({ startRow: 3, startColumn: 1, endRow: 3, endColumn: 1 })).toBe('B4');
    });

    it('解析区域并归一化', () => {
        expect(parseA1Range('A1:C3')).toEqual({
            startRow: 0,
            startColumn: 0,
            endRow: 2,
            endColumn: 2,
        });
        expect(parseA1Range('c3:a1')).toEqual({
            startRow: 0,
            startColumn: 0,
            endRow: 2,
            endColumn: 2,
        });
        expect(parseA1Range('$B$2:$C$4')).toEqual({
            startRow: 1,
            startColumn: 1,
            endRow: 3,
            endColumn: 2,
        });
        expect(parseA1Range('B2')).toEqual({
            startRow: 1,
            startColumn: 1,
            endRow: 1,
            endColumn: 1,
        });
        expect(() => parseA1Range('A1:')).toThrow();
    });

    it('拆工作表前缀', () => {
        expect(splitSheetPrefix("'Sheet 1'!A1:B2")).toEqual({
            sheet: 'Sheet 1',
            range: 'A1:B2',
        });
        expect(splitSheetPrefix('A1:B2')).toEqual({ range: 'A1:B2' });
    });

    it('裁剪与单元格上限', () => {
        expect(
            clampRangeToSheet({ startRow: 0, startColumn: 0, endRow: 199, endColumn: 5 }, 100, 10)
        ).toEqual({ startRow: 0, startColumn: 0, endRow: 99, endColumn: 5 });

        expect(limitRange({ startRow: 0, startColumn: 0, endRow: 99, endColumn: 9 }, 100)).toEqual({
            range: { startRow: 0, startColumn: 0, endRow: 9, endColumn: 9 },
            truncated: true,
        });

        expect(cellCount({ startRow: 0, startColumn: 0, endRow: 1, endColumn: 2 })).toBe(6);
    });
});
