/**
 * xlsx 格式实现（`.xlsx / .xlsm`）。
 *
 * 具体读写逻辑在 `xlsx.ts`；这里只是把它包成统一的 `WorkbookFormat`，
 * 供注册表按扩展名分发。
 */

import type { SnapshotWorkbook } from '../../../../infrastructure/yjs/ydoc.types';
import type { WorkbookFormat, WorkbookReadOptions, WorkbookReadResult } from '../types';
import { readXlsx, writeXlsx } from './xlsx';

export const xlsxFormat: WorkbookFormat = {
    id: 'xlsx',
    extensions: ['.xlsx', '.xlsm'],
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    read(input: Buffer, options?: WorkbookReadOptions): Promise<WorkbookReadResult> {
        return readXlsx(input, options);
    },
    write(workbook: SnapshotWorkbook): Promise<Buffer> {
        return writeXlsx(workbook);
    },
};

// 直接调用（需要绕过注册表时用）
export { readXlsx, writeXlsx, cellAddress } from './xlsx';
export type { IXlsxReadOptions, IXlsxReadResult } from './xlsx';
