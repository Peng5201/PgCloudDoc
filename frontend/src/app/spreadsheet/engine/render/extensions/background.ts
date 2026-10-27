/**
 * 背景层 —— 只画**有背景色的**格子。
 *
 * 对照 Univer: engine-render/src/components/sheets/extensions/background.ts
 *
 * 空白格子不画，这是稀疏渲染的关键：
 * 10 万格里可能只有 50 个有背景色，画 50 个矩形而不是 10 万个。
 */

import type { IDrawContext, ISheetExtension } from './extension';
import { forEachVisibleCell } from './extension';
import { EXTENSION_ORDER } from './extension';

export const backgroundExtension: ISheetExtension = {
    order: EXTENSION_ORDER.BACKGROUND,
    name: 'background',
    draw({ ctx, skeleton, worksheet, styles, view }: IDrawContext) {
        forEachVisibleCell(worksheet.cellData.matrix, view, (row, column) => {
            const style = worksheet.resolveCell(row, column, styles);
            const color = skeleton.resolveColor(style?.bg);
            if (!color) return;

            const rect = skeleton.cellRect(row, column);
            if (rect.width <= 0 || rect.height <= 0) return;

            ctx.fillStyle = color;
            ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        });
    },
};
