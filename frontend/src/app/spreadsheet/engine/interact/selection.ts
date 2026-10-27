/**
 * 选择模型。
 *
 * 对照 Univer: packages/sheets/src/services/selections/
 *
 * 一个选区 = 若干个矩形（支持 Ctrl 多选）+ 一个活动单元格（active）。
 * 活动单元格决定：键盘输入落在哪、边框描在哪个格子、公式栏显示哪一格。
 */

import type { IRange } from '../model/types';
import { normalizeRange, rangeCellCount } from '../model/types';
import { cellReference, columnLabel } from '../render/skeleton';

export interface ISelection {
    /** 活动单元格：编辑/输入落到哪 */
    active: { row: number; column: number };
    /** 一个或多个矩形。最后一个是最新的（主选区） */
    ranges: IRange[];
}

export function singleSelection(row: number, column: number): ISelection {
    return {
        active: { row, column },
        ranges: [{ startRow: row, startColumn: column, endRow: row, endColumn: column }],
    };
}

/** 从两个角拖出来的矩形选区，自动归一化四个角的大小关系 */
export function rangeSelection(
    anchorRow: number,
    anchorColumn: number,
    focusRow: number,
    focusColumn: number
): ISelection {
    return {
        active: { row: anchorRow, column: anchorColumn },
        ranges: [
            normalizeRange({
                startRow: anchorRow,
                startColumn: anchorColumn,
                endRow: focusRow,
                endColumn: focusColumn,
            }),
        ],
    };
}

/** 整行选区（点行表头） */
export function rowSelection(
    anchorRow: number,
    focusRow: number,
    columnCount: number
): ISelection {
    return {
        active: { row: anchorRow, column: 0 },
        ranges: [
            normalizeRange({
                startRow: anchorRow,
                startColumn: 0,
                endRow: focusRow,
                endColumn: columnCount - 1,
            }),
        ],
    };
}

/** 整列选区（点列头） */
export function columnSelection(
    anchorColumn: number,
    focusColumn: number,
    rowCount: number
): ISelection {
    return {
        active: { row: 0, column: anchorColumn },
        ranges: [
            normalizeRange({
                startRow: 0,
                startColumn: anchorColumn,
                endRow: rowCount - 1,
                endColumn: focusColumn,
            }),
        ],
    };
}

export function allSelection(rowCount: number, columnCount: number): ISelection {
    return {
        active: { row: 0, column: 0 },
        ranges: [
            {
                startRow: 0,
                startColumn: 0,
                endRow: Math.max(0, rowCount - 1),
                endColumn: Math.max(0, columnCount - 1),
            },
        ],
    };
}

/** 追加一个矩形到多选里（Ctrl + 点/拖） */
export function appendSelection(current: ISelection, extra: IRange): ISelection {
    return {
        active: current.active,
        ranges: [...current.ranges, normalizeRange(extra)],
    };
}

/** 主选区 = ranges 的最后一个 */
export function primaryRange(selection: ISelection): IRange {
    return (
        selection.ranges[selection.ranges.length - 1] ?? {
            startRow: selection.active.row,
            startColumn: selection.active.column,
            endRow: selection.active.row,
            endColumn: selection.active.column,
        }
    );
}

/** 选区矩形个数（状态栏显示「已选 N 个单元格」） */
export function selectedCount(selection: ISelection): number {
    return selection.ranges.reduce((sum, r) => sum + rangeCellCount(r), 0);
}

/**
 * 选区标注：单格是 `B3`，多格是 `B3:D7`，整列是 `A:A`，整行是 `2:2`。
 * 多块选区用逗号分隔。
 *
 * 判断「整列」要拿工作表的总行数来比 —— 选区在模型里一律是具体矩形，
 * 没有「整列」这种特殊形态，只能看它是不是上下顶到头。
 */
export function rangeLabel(selection: ISelection, rowCount = 0, columnCount = 0): string {
    if (selection.ranges.length === 0) {
        return cellReference(selection.active.row, selection.active.column);
    }

    return selection.ranges
        .map((r) => {
            const isSingle = r.startRow === r.endRow && r.startColumn === r.endColumn;
            if (isSingle) return cellReference(r.startRow, r.startColumn);

            const wholeColumn =
                r.startRow === 0 && r.endRow >= rowCount - 1 && r.startColumn === r.endColumn;
            if (wholeColumn) return `${columnLabel(r.startColumn)}:${columnLabel(r.endColumn)}`;

            const wholeRow =
                r.startColumn === 0 && r.endColumn >= columnCount - 1 && r.startRow === r.endRow;
            if (wholeRow) return `${r.startRow + 1}:${r.endRow + 1}`;

            return `${cellReference(r.startRow, r.startColumn)}:${cellReference(r.endRow, r.endColumn)}`;
        })
        .join(', ');
}

/** 两个选区是否完全一样 —— 用于避免无意义的 selection-change 事件 */
export function selectionEquals(a: ISelection, b: ISelection): boolean {
    if (a.active.row !== b.active.row || a.active.column !== b.active.column) return false;
    if (a.ranges.length !== b.ranges.length) return false;
    return a.ranges.every((r, i) => {
        const other = b.ranges[i] as IRange;
        return (
            r.startRow === other.startRow &&
            r.startColumn === other.startColumn &&
            r.endRow === other.endRow &&
            r.endColumn === other.endColumn
        );
    });
}
