/**
 * 工作簿文件格式的公共契约。
 *
 * 目前实现：xlsx（`.xlsx / .xlsm`）。后续加 csv / ods 时，
 * 只要实现 `WorkbookFormat` 并在 `formats/index.ts` 的注册表里登记即可，
 * 调用方（documents 的导入/导出）不用改。
 */

import type { SnapshotWorkbook } from '../../../infra/yjs/ydoc.types';

export interface WorkbookReadOptions {
    /** 解析后工作簿的显示名（一般取文件名） */
    name?: string;
    /** 单元格总数上限，超限抛 `CellLimitExceededError` */
    maxCells?: number;
}

export interface WorkbookReadResult {
    workbook: SnapshotWorkbook;
    /** 导入过程中的降级提示（富文本压平、未知值类型等） */
    warnings: string[];
    /** 实际读取到的非空单元格数 */
    cellCount: number;
}

/** 一种工作簿文件格式的读写能力 */
export interface WorkbookFormat {
    /** 格式标识，如 `xlsx` */
    readonly id: string;
    /** 支持的扩展名（小写、带点） */
    readonly extensions: readonly string[];
    /** 导出时响应的 MIME type */
    readonly contentType: string;
    read(input: Buffer, options?: WorkbookReadOptions): Promise<WorkbookReadResult>;
    write(workbook: SnapshotWorkbook): Promise<Buffer>;
}

/** 不支持的扩展名 */
export class UnsupportedFormatError extends Error {
    constructor(readonly filename: string) {
        super(`不支持的文件格式：${filename}`);
        this.name = 'UnsupportedFormatError';
    }
}

/** 单元格数超过上限（所有格式共用） */
export class CellLimitExceededError extends Error {
    constructor(
        readonly cellCount: number,
        readonly limit: number
    ) {
        super(`工作表单元格过多（${cellCount} > ${limit}），请拆分后再导入`);
        this.name = 'CellLimitExceededError';
    }
}
