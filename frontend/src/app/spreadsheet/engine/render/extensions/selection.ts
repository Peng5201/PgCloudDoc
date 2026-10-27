/**
 * 选区层 —— 最上层。
 *
 * 对照 Univer: engine-render/src/components/sheets/extensions/marker.ts
 *              + sheets-ui 的 selection shape
 *
 * 画三样东西：
 *   1. 选区的淡蓝底（多块都要画）
 *   2. 活动单元格的粗边框 —— 不填色，否则会盖住文字
 *   3. 右下角的填充柄（本次不做拖拽填充交互，先画出来）
 */

import type { IDrawContext, ISheetExtension } from './extension';
import { ONE_PIXEL_FIX } from './extension';
import { EXTENSION_ORDER } from './extension';
import { primaryRange } from '../../interact/selection';

export const SELECTION_FILL = 'rgba(59, 130, 246, 0.10)';
export const SELECTION_BORDER = '#94b8ff';
export const ACTIVE_BORDER = '#2b5be0';
export const HANDLE_SIZE = 6;

export const selectionExtension: ISheetExtension = {
    order: EXTENSION_ORDER.SELECTION,
    name: 'selection',
    draw({ ctx, skeleton, selection }: IDrawContext) {
        if (selection.ranges.length === 0) return;

        const primary = primaryRange(selection);

        for (const r of selection.ranges) {
            const rect = skeleton.rangeRect(r);
            if (rect.width <= 0 || rect.height <= 0) continue;

            ctx.fillStyle = SELECTION_FILL;
            ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

            if (r === primary) continue;

            // 非主选区：细边框，视觉上次要
            ctx.strokeStyle = SELECTION_BORDER;
            ctx.lineWidth = 1;
            ctx.strokeRect(
                Math.round(rect.x) + ONE_PIXEL_FIX,
                Math.round(rect.y) + ONE_PIXEL_FIX,
                rect.width - 1,
                rect.height - 1
            );
        }

        // 主选区外框
        const rect = skeleton.rangeRect(primary);
        if (rect.width > 0 && rect.height > 0) {
            ctx.strokeStyle = ACTIVE_BORDER;
            ctx.lineWidth = 2;
            ctx.strokeRect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2);
        }

        // 活动单元格：单独一圈，多选时也能看出焦点在哪
        const active = skeleton.cellRect(selection.active.row, selection.active.column);
        if (active.width > 0 && active.height > 0) {
            ctx.strokeStyle = ACTIVE_BORDER;
            ctx.lineWidth = 2;
            ctx.strokeRect(active.x + 1, active.y + 1, active.width - 2, active.height - 2);

            // 填充柄
            ctx.fillStyle = ACTIVE_BORDER;
            ctx.fillRect(
                active.x + active.width - HANDLE_SIZE,
                active.y + active.height - HANDLE_SIZE,
                HANDLE_SIZE,
                HANDLE_SIZE
            );
        }
    },
};
