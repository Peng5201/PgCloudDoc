/**
 * 网格线层。
 *
 * 对照 Univer: engine-render/src/components/sheets/extensions/ 中 grid 相关绘制
 *              （Univer 里网格线画在 sheet-component 的 drawWith渲染上下文里）
 *
 * 只画可见区的那几十条，不是全部 10 万条。
 * 受 worksheet.showGridlines 控制 —— Excel 的「隐藏网格线」就是关掉这一层。
 */

import type { IDrawContext, ISheetExtension } from './extension';
import { ONE_PIXEL_FIX } from './extension';
import { EXTENSION_ORDER } from './extension';

export const gridExtension: ISheetExtension = {
    order: EXTENSION_ORDER.GRID,
    name: 'grid',
    draw({ ctx, skeleton, worksheet, view }: IDrawContext) {
        if (worksheet.showGridlines === 0) return;

        const { startRow, endRow, startColumn, endColumn } = view;

        const left = skeleton.cellRect(startRow, startColumn).x;
        const rightEdge = skeleton.cellRect(startRow, endColumn).x + skeleton.getColumnWidth(endColumn);
        const top = skeleton.cellRect(startRow, startColumn).y;
        const bottomEdge = skeleton.cellRect(endRow, startColumn).y + skeleton.getRowHeight(endRow);

        ctx.strokeStyle = skeleton.resolveColor(
            worksheet.gridlinesColor ? { rgb: worksheet.gridlinesColor } : null,
            '#e1e3e8'
        );
        ctx.lineWidth = 1;
        ctx.beginPath();

        for (let row = startRow; row <= endRow + 1; row++) {
            const y = Math.round(skeleton.cellRect(row, 0).y) + ONE_PIXEL_FIX;
            ctx.moveTo(left, y);
            ctx.lineTo(rightEdge, y);
        }
        for (let column = startColumn; column <= endColumn + 1; column++) {
            const x = Math.round(skeleton.cellRect(0, column).x) + ONE_PIXEL_FIX;
            ctx.moveTo(x, top);
            ctx.lineTo(x, bottomEdge);
        }

        ctx.stroke();
    },
};
