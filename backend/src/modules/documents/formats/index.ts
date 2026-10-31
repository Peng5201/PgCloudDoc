/**
 * 工作簿文件格式注册表。
 *
 * 目前只有 xlsx。加新格式时的步骤：
 *   1. 新建 `formats/<id>/`，实现 `WorkbookFormat`
 *   2. 加入下面的 `FORMATS`
 * 调用方（documents 的导入/导出）按扩展名自动分发，不需要改。
 */

import type { SnapshotWorkbook } from '../../../infra/yjs/ydoc.types';
import { xlsxFormat } from './xlsx';
import {
    UnsupportedFormatError,
    type WorkbookFormat,
    type WorkbookReadOptions,
    type WorkbookReadResult,
} from './types';

const FORMATS: readonly WorkbookFormat[] = [xlsxFormat];

/** 默认导出格式（导出接口目前固定产出 xlsx） */
export const defaultFormat: WorkbookFormat = xlsxFormat;

/** 取小写扩展名（含点），如 `/a/b/报表.XLSX` → `.xlsx` */
export function extensionOf(filename: string): string {
    const base = filename.split(/[\\/]/).pop() ?? filename;
    const dot = base.lastIndexOf('.');
    return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

/** 按文件名找格式；找不到返回 undefined */
export function findFormat(filename: string): WorkbookFormat | undefined {
    const ext = extensionOf(filename);
    return FORMATS.find((format) => format.extensions.includes(ext));
}

/** 所有支持的扩展名，用于错误提示 */
export function supportedExtensions(): string[] {
    return FORMATS.flatMap((format) => [...format.extensions]);
}

/** 按文件名分发解析 */
export async function readWorkbook(
    input: Buffer,
    filename: string,
    options?: WorkbookReadOptions
): Promise<WorkbookReadResult> {
    const format = findFormat(filename);
    if (!format) throw new UnsupportedFormatError(filename);
    return format.read(input, options);
}

/** 按指定格式（默认 xlsx）生成文件 */
export async function writeWorkbook(
    workbook: SnapshotWorkbook,
    format: WorkbookFormat = defaultFormat
): Promise<Buffer> {
    return format.write(workbook);
}

export { UnsupportedFormatError, CellLimitExceededError } from './types';
export type {
    WorkbookFormat,
    WorkbookReadOptions,
    WorkbookReadResult,
} from './types';
