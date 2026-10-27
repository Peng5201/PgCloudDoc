/**
 * 改样式的命令 —— 工具栏所有按钮都走这里。
 *
 * 对照 Univer: packages/sheets/src/commands/commands/set-range-styles.command.ts
 *              + packages/sheets/src/commands/mutations/set-range-styles.mutation.ts
 *
 * 关键点有两个：
 *
 * 1. **样式走共享表**：改样式不是把样式对象塞进格子，而是算出新样式、
 *    归并进 workbook.styles、把 id 写进 cell.s。一万格同样式在 JSON 里只占一份。
 *
 * 2. **绝不动共享表里的旧样式**：共享样式可能被其他格子引用，
 *    原地改会连带影响一片无辜的单元格。所以永远「算出新样式 → 注册新 id」。
 */

import type { Workbook } from '../model/workbook';
import type { Worksheet } from '../model/worksheet';
import type {
    IBorderData,
    IBorderStyleData,
    ICellData,
    IRange,
    IStyleData,
    IStylePatch,
} from '../model/types';
import { BorderStyleTypes } from '../model/types';
import type { IEdit } from './history';

interface IStyleSnapshot {
    row: number;
    column: number;
    /** 格子原本的 s：id 字符串 / 内联对象 / undefined */
    before: ICellData['s'];
    /** 格子原本是否存在（不存在的话 undo 要把整个格子删掉） */
    existed: boolean;
}

/**
 * 对一片区域套样式增量。
 *
 * `patch` 可以是固定增量，也可以是按格子算的函数 —— 「外框线」这种
 * 只描周长的操作必须逐格算边，固定 patch 表达不了。
 *
 * 每个格子基于**它自己当前的样式**合并，所以同一片区域里加粗/未加粗的格子
 * 应用「斜体」后都只多出斜体，不会被统一成同一份样式。
 */
export function createSetRangeStylesEdit(
    workbook: Workbook,
    worksheet: Worksheet,
    range: IRange,
    patch: IStylePatch | ((row: number, column: number, range: IRange) => IStylePatch),
    label = '设置样式'
): IEdit {
    const snapshots: IStyleSnapshot[] = [];
    const nextIds: Array<string | undefined> = [];

    for (let row = range.startRow; row <= range.endRow; row++) {
        for (let column = range.startColumn; column <= range.endColumn; column++) {
            const cell = worksheet.cellData.getValue(row, column);
            snapshots.push({
                row,
                column,
                before: cell?.s,
                existed: cell !== undefined,
            });

            const current = workbook.resolveStyle(cell?.s);
            const delta = typeof patch === 'function' ? patch(row, column, range) : patch;
            const merged = workbook.patchStyle(current, delta);
            // 空样式（patch 全是 null）就直接摘掉引用，别留个空对象占位置
            nextIds.push(isEmptyStyle(workbook.styles[merged]) ? undefined : merged);
        }
    }

    return {
        label,
        redo() {
            snapshots.forEach((snapshot, index) => {
                const nextId = nextIds[index];
                const cell = worksheet.cellData.getValue(snapshot.row, snapshot.column) ?? {};
                worksheet.cellData.setValue(snapshot.row, snapshot.column, {
                    ...cell,
                    s: nextId ?? null,
                });
            });
        },
        undo() {
            snapshots.forEach((snapshot) => {
                if (!snapshot.existed) {
                    worksheet.cellData.realDeleteValue(snapshot.row, snapshot.column);
                    return;
                }
                const cell = worksheet.cellData.getValue(snapshot.row, snapshot.column);
                if (!cell) return;
                worksheet.cellData.setValue(snapshot.row, snapshot.column, {
                    ...cell,
                    s: snapshot.before ?? null,
                });
            });
        },
    };
}

function isEmptyStyle(style: IStyleData | undefined): boolean {
    return !style || Object.keys(style).length === 0;
}

/**
 * 读出一片区域「当前生效」的样式 —— 工具栏靠它决定按钮的按下态。
 *
 * 多格时以**活动单元格**为准（与 Excel 一致：选中一片混合区域，工具栏显示活动格的状态）。
 */
export function readActiveStyle(
    workbook: Workbook,
    worksheet: Worksheet,
    active: { row: number; column: number }
): IStyleData {
    const cell = worksheet.getCell(active.row, active.column);
    return workbook.resolveStyle(cell?.s) ?? {};
}

/**
 * 把「加粗」这类开关态转成 patch。
 *
 * 注意取反是基于**当前值**的：已加粗的选区点加粗是取消，不是再加一次。
 */
export function togglePatch(
    current: IStyleData,
    key: keyof IStyleData
): IStylePatch {
    const value = current[key];
    const next = value === 1 ? 0 : 1;
    return { [key]: next } as IStylePatch;
}

// ─────────────────────────── 边框 ───────────────────────────

export type BorderMode = 'none' | 'outer' | 'all';

function thinBorder(rgb: string): IBorderStyleData {
    return { s: BorderStyleTypes.THIN, cl: { rgb } };
}

/**
 * 边框 patch。
 *
 * 边框不是「给整片区域一个 bd」，而是**每个格子只描它该描的那几条边**：
 * 「外框线」= 只有周长上的边，中间格子不动。
 * 所以返回的是按格子算的函数，配 createSetRangeStylesEdit 的函数式 patch。
 */
export function createBorderPatch(
    mode: BorderMode,
    color = '#1f2329'
): (row: number, column: number, range: IRange) => IStylePatch {
    const border = thinBorder(color);

    return (row, column, range) => {
        if (mode === 'none') return { bd: null };

        if (mode === 'all') {
            return { bd: { t: border, r: border, b: border, l: border } };
        }

        // 外框：只描落在 range 周长上的边
        const bd: IBorderData = {};
        if (row === range.startRow) bd.t = border;
        if (row === range.endRow) bd.b = border;
        if (column === range.startColumn) bd.l = border;
        if (column === range.endColumn) bd.r = border;
        return { bd: Object.keys(bd).length > 0 ? bd : null };
    };
}
