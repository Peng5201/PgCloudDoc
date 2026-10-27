/**
 * 边框层 —— 画 bd.t / bd.r / bd.b / bd.l 四边。
 *
 * 对照 Univer: engine-render/src/components/sheets/extensions/border.ts
 *
 * 边框是**单元格自己声明**的（不像网格线是全局的），所以是稀疏的：
 * 只有显式设过边框的格子才会进这一层。
 *
 * 相邻格子共享的那条线会被画两次（各自画自己那一边），
 * Univer 里是先收集再统一 stroke 优化的；这里量小，先保持直观。
 */

import type { IBorderData, IBorderStyleData, BorderStyleTypes } from '../../model/types';
import { BorderStyleTypes as BS } from '../../model/types';
import type { IDrawContext, ISheetExtension } from './extension';
import { ONE_PIXEL_FIX, forEachVisibleCell } from './extension';
import { EXTENSION_ORDER } from './extension';

/** 线型 → 画布参数 */
function borderStroke(style: BorderStyleTypes): { width: number; dash: number[] } {
    switch (style) {
        case BS.HAIR:
            return { width: 1, dash: [] };
        case BS.DOTTED:
            return { width: 1, dash: [1, 2] };
        case BS.DASHED:
            return { width: 1, dash: [4, 2] };
        case BS.DASH_DOT:
            return { width: 1, dash: [6, 2, 1, 2] };
        case BS.DASH_DOT_DOT:
            return { width: 1, dash: [6, 2, 1, 2, 1, 2] };
        case BS.MEDIUM:
        case BS.MEDIUM_DASHED:
        case BS.MEDIUM_DASH_DOT:
        case BS.MEDIUM_DASH_DOT_DOT:
            return { width: 2, dash: [] };
        case BS.THICK:
            return { width: 3, dash: [] };
        case BS.DOUBLE:
            return { width: 3, dash: [] };
        case BS.THIN:
        default:
            return { width: 1, dash: [] };
    }
}

export const borderExtension: ISheetExtension = {
    order: EXTENSION_ORDER.BORDER,
    name: 'border',
    draw({ ctx, skeleton, worksheet, styles, view }: IDrawContext) {
        forEachVisibleCell(worksheet.cellData.matrix, view, (row, column) => {
            const style = worksheet.resolveCell(row, column, styles);
            const bd: IBorderData | null | undefined = style?.bd;
            if (!bd) return;

            const rect = skeleton.cellRect(row, column);
            if (rect.width <= 0 || rect.height <= 0) return;

            drawBorders(ctx, skeleton, bd, rect);
        });
    },
};

function drawBorders(
    ctx: CanvasRenderingContext2D,
    skeleton: IDrawContext['skeleton'],
    bd: IBorderData,
    rect: { x: number; y: number; width: number; height: number }
): void {
    const left = Math.round(rect.x) + ONE_PIXEL_FIX;
    const top = Math.round(rect.y) + ONE_PIXEL_FIX;
    const right = Math.round(rect.x + rect.width) - ONE_PIXEL_FIX;
    const bottom = Math.round(rect.y + rect.height) - ONE_PIXEL_FIX;

    // 四条边按 上→右→下→左 画，与 Excel 的视觉一致
    const edges: Array<[IBorderStyleData | null | undefined, number, number, number, number]> = [
        [bd.t, left, top, right, top],
        [bd.r, right, top, right, bottom],
        [bd.b, left, bottom, right, bottom],
        [bd.l, left, top, left, bottom],
    ];

    for (const [border, x1, y1, x2, y2] of edges) {
        if (!border || border.s === BS.NONE) continue;

        const { width, dash } = borderStroke(border.s);
        ctx.save();
        ctx.strokeStyle = skeleton.resolveColor(border.cl, '#1f2329');
        ctx.lineWidth = width;
        ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);

        if (border.s === BS.DOUBLE) {
            // 双线：主线两侧各退 1px 画两条细线
            ctx.stroke();
            ctx.lineWidth = 1;
            ctx.beginPath();
            const isHorizontal = y1 === y2;
            if (isHorizontal) {
                ctx.moveTo(x1, y1 - 2);
                ctx.lineTo(x2, y2 - 2);
            } else {
                ctx.moveTo(x1 - 2, y1);
                ctx.lineTo(x2 - 2, y2);
            }
        }

        ctx.stroke();
        ctx.restore();
    }
}
