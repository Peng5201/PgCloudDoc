/**
 * 写值 / 清空的命令。
 *
 * 对照 Univer: packages/sheets/src/commands/commands/set-range-values.command.ts
 *              （最值得精读的文件）
 *
 * Univer 里这条命令的完整流程：
 *   1. 算出 redo 参数（要写什么）
 *   2. SetRangeValuesUndoMutationFactory() 生成 undo 参数（改之前长什么样）
 *   3. 执行 SetRangeValuesMutation 改数据
 *   4. sheetInterceptorService 让其他插件追加联动 mutation（公式、自动行高…）
 *   5. undoRedoService.pushUndoRedo({ undoMutations, redoMutations })
 *
 * 这里是它的精简版，但**保留了核心骨架**：先捕获旧值，再改，正反都靠同一份 apply。
 */

import type { Worksheet } from '../model/worksheet';
import type { ICellData, IRange } from '../model/types';
import { CellValueType } from '../model/types';
import type { IEdit } from './history';

/**
 * 从原始输入推断单元格类型。
 * 这是「在格子里敲 123 就变成数字、敲 =SUM() 就变成公式」的那一步。
 */
export function inferCellData(input: string): ICellData {
    const trimmed = input.trim();

    if (trimmed === '') {
        return { v: '', t: CellValueType.STRING };
    }

    // 公式：本引擎只存不下发计算结果（见计划的「不做」清单）
    if (trimmed.startsWith('=')) {
        return { f: trimmed, v: '', t: CellValueType.STRING };
    }

    if (trimmed === 'true' || trimmed === 'false') {
        return { v: trimmed === 'true', t: CellValueType.BOOLEAN };
    }

    // 数字：`1,234.5` 这种千分位也算，但 `-` `12abc` 不算
    const normalized = trimmed.replace(/,/g, '');
    if (/^-?\d+(\.\d+)?$/.test(normalized)) {
        const num = Number(normalized);
        if (Number.isFinite(num)) return { v: num, t: CellValueType.NUMBER };
    }

    return { v: input, t: CellValueType.STRING };
}

/**
 * 设置一片区域的值。
 *
 * `value` 可以是固定值，也可以是按格子算的函数（填充柄/公式下拉要用）。
 * 返回**单个** IEdit —— 撤销时整块一起回退，用户看到的是「一次撤销」。
 */
export function createSetRangeValuesEdit(
    worksheet: Worksheet,
    range: IRange,
    value: ICellData | ((row: number, column: number) => ICellData),
    label = '输入内容'
): IEdit {
    const cells = captureRange(worksheet, range);

    const apply = () => {
        for (let row = range.startRow; row <= range.endRow; row++) {
            for (let column = range.startColumn; column <= range.endColumn; column++) {
                const next = typeof value === 'function' ? value(row, column) : value;
                worksheet.cellData.setValue(row, column, structuredClone(next));
            }
        }
    };

    return {
        label,
        redo: apply,
        undo: () => restoreRange(worksheet, cells),
    };
}

/**
 * 清空一片选区的内容（Delete / Backspace / 清除内容）。
 *
 * 注意是**真删除**格子，而不是写入空串 —— 稀疏矩阵里「不存在」才是省内存的常态。
 */
export function createClearRangeEdit(worksheet: Worksheet, range: IRange, label = '清除内容'): IEdit {
    const cells: Array<{ row: number; column: number; before: ICellData }> = [];
    for (let row = range.startRow; row <= range.endRow; row++) {
        for (let column = range.startColumn; column <= range.endColumn; column++) {
            const before = worksheet.cellData.getValue(row, column);
            if (before !== undefined) cells.push({ row, column, before });
        }
    }

    return {
        label,
        redo() {
            for (const { row, column } of cells) {
                worksheet.cellData.realDeleteValue(row, column);
            }
        },
        undo: () => restoreRange(worksheet, cells),
    };
}

// ─────────────────────────── 快照工具 ───────────────────────────

interface ICellSnapshot {
    row: number;
    column: number;
    before: ICellData | undefined;
}

/** 把一片区域的旧值全部抓下来 —— 所有 undo 都靠它 */
function captureRange(worksheet: Worksheet, range: IRange): ICellSnapshot[] {
    const out: ICellSnapshot[] = [];
    for (let row = range.startRow; row <= range.endRow; row++) {
        for (let column = range.startColumn; column <= range.endColumn; column++) {
            out.push({ row, column, before: worksheet.cellData.getValue(row, column) });
        }
    }
    return out;
}

function restoreRange(worksheet: Worksheet, cells: ICellSnapshot[]): void {
    const matrix = worksheet.cellData;
    for (const { row, column, before } of cells) {
        if (before === undefined) {
            matrix.realDeleteValue(row, column);
        } else {
            // 深拷贝：undo 拿到的引用不能被后续修改污染
            matrix.setValue(row, column, structuredClone(before));
        }
    }
}

export { captureRange, restoreRange };
export type { ICellSnapshot };
