/**
 * 绘制扩展的基础定义 —— 类型、排序常量、共用工具。
 *
 * 对照 Univer: engine-render/src/components/sheets/extensions/sheet-extension.ts
 *
 * **必须单独一个文件**，不能和 index.ts 混在一起：
 * 各个图层要 import EXTENSION_ORDER，而 index.ts 又要 re-export 各个图层，
 * 写在一起就成了循环引用 —— 图层模块求值时 EXTENSION_ORDER 还在 TDZ 里，
 * 直接 `ReferenceError: Cannot access 'EXTENSION_ORDER' before initialization`。
 */

import type { ISelection } from '../../interact/selection';
import type { ICellData, IRange, IStyleData, ObjectMatrixPrimitive } from '../../model/types';
import type { Worksheet } from '../../model/worksheet';
import type { IViewRect, SheetSkeleton } from '../skeleton';

/** 其他协作者的选区（渲染层只读消费，由协同层灌进来） */
export interface IRemoteSelection {
    /** 协作者标识（awareness clientId），只用于 React 侧去重 */
    key: string | number;
    /** 显示名，画成小标签 */
    name: string;
    /** 该协作者的固定颜色（与顶栏头像一致） */
    color: string;
    ranges: IRange[];
    /** 当前活动单元格 */
    active?: { row: number; column: number };
}

/** 绘制上下文 —— 传给每个 extension 的全部信息 */
export interface IDrawContext {
    ctx: CanvasRenderingContext2D;
    skeleton: SheetSkeleton;
    worksheet: Worksheet;
    styles: Record<string, IStyleData>;
    /** 当前可见范围（已含 overscan） */
    view: IViewRect;
    /** 选择状态（selection 层会用到） */
    selection: ISelection;
    /** 其他协作者的选区（remote-selection 层用） */
    remoteSelections: IRemoteSelection[];
    /** 缩放比。文字换行宽度要按它算，否则缩放后断行位置错乱 */
    zoom: number;
}

export interface ISheetExtension {
    /** 排序号，越小越先画（越靠近底图） */
    readonly order: number;
    readonly name: string;
    draw(dc: IDrawContext): void;
}

export const EXTENSION_ORDER = {
    BACKGROUND: 0,
    GRID: 10,
    BORDER: 20,
    FONT: 30,
    /** 别人的选区画在自己下面：自己的高亮永远是最后、最显眼的 */
    REMOTE_SELECTION: 90,
    SELECTION: 100,
} as const;

/** 单元格水平内边距 */
export const CELL_PADDING_X = 6;

/** 对抗 1px 线的半像素模糊（对应 Univer 的 FIX_ONE_PIXEL_BLUR_OFFSET） */
export const ONE_PIXEL_FIX = 0.5;

export function inView(row: number, column: number, view: IViewRect): boolean {
    return (
        row >= view.startRow &&
        row <= view.endRow &&
        column >= view.startColumn &&
        column <= view.endColumn
    );
}

/** 只遍历可见区里的有内容格子 —— 稀疏渲染的关键 */
export function forEachVisibleCell(
    cellData: ObjectMatrixPrimitive<ICellData>,
    view: IViewRect,
    callback: (row: number, column: number, cell: ICellData) => void
): void {
    for (let row = view.startRow; row <= view.endRow; row++) {
        const rowMap = cellData[row];
        if (!rowMap) continue;
        for (const colKey of Object.keys(rowMap)) {
            const column = Number(colKey);
            if (column < view.startColumn || column > view.endColumn) continue;
            const cell = rowMap[column];
            if (cell) callback(row, column, cell);
        }
    }
}
