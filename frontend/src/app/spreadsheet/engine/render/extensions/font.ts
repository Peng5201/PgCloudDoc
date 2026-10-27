/**
 * 文本层 —— 最讲究的一层。
 *
 * 对照 Univer: engine-render/src/components/sheets/extensions/font.ts
 *
 * 三件事决定它像不像 Excel：
 *   1. **视口裁剪**：只测并画可见格子的文字，一帧几十次测量而不是几十万次
 *   2. **溢出语义**：右边格子是空的就让文字流过去（OVERFLOW），
 *      否则裁剪到自己边界（CLIP）或换行（WRAP）
 *   3. **+0.5px 偏移**对抗 1px 线的半像素模糊
 */

import type { HorizontalAlign, VerticalAlign } from '../../model/types';
import { HorizontalAlign as HA, VerticalAlign as VA, WrapStrategy as WS } from '../../model/types';
import type { IDrawContext, ISheetExtension } from './extension';
import { CELL_PADDING_X, ONE_PIXEL_FIX, forEachVisibleCell } from './extension';
import { EXTENSION_ORDER } from './extension';
import type { IRect, SheetSkeleton } from '../skeleton';
import type { IStyleData } from '../../model/types';

/** 文本行高系数。按字号乘，比写死 px 更耐字号变化 */
const LINE_HEIGHT_RATIO = 1.3;

export const fontExtension: ISheetExtension = {
    order: EXTENSION_ORDER.FONT,
    name: 'font',
    draw(dc: IDrawContext) {
        const { ctx, skeleton, worksheet, styles, view } = dc;

        forEachVisibleCell(worksheet.cellData.matrix, view, (row, column, cell) => {
            const text = worksheet.cellText(cell);
            if (text === '') return;

            const style = worksheet.resolveCell(row, column, styles);
            const rect = skeleton.cellRect(row, column);
            if (rect.width <= 0 || rect.height <= 0) return;

            const strategy = skeleton.wrapStrategy(style);
            const paddingX = style?.pd?.l ?? CELL_PADDING_X;
            const paddingR = style?.pd?.r ?? CELL_PADDING_X;

            // —— 溢出：右边连续的空格子都算可用宽度 ——
            let clipRect = rect;
            const innerWidth = rect.width - paddingX - paddingR;

            if (strategy === WS.OVERFLOW) {
                const spillRight = measureSpillRight(dc, row, column, rect, paddingX, paddingR);
                if (spillRight > rect.x + rect.width - paddingR) {
                    clipRect = {
                        x: rect.x,
                        y: rect.y,
                        width: spillRight + paddingR - rect.x,
                        height: rect.height,
                    };
                }
            }

            const available = Math.max(0, clipRect.width - paddingX - paddingR);
            if (strategy !== WS.OVERFLOW && innerWidth <= 0) return;
            if (available <= 0) return;

            const font = skeleton.fontOf(style);
            const fontSize = skeleton.fontSize(style);
            const lineHeight = fontSize * LINE_HEIGHT_RATIO;

            const lines =
                strategy === WS.WRAP
                    ? skeleton.wrapLines(text, style, available)
                    : text.split('\n');

            ctx.save();
            ctx.beginPath();
            ctx.rect(clipRect.x, clipRect.y, clipRect.width, clipRect.height);
            ctx.clip();

            ctx.font = font;
            ctx.fillStyle = skeleton.resolveColor(style?.cl, '#1f2329');

            const vAlign = skeleton.verticalAlign(style);
            const hAlign = skeleton.horizontalAlign(cell, style);

            const totalHeight = lines.length * lineHeight;
            const blockTop = verticalOffset(rect, totalHeight, vAlign, style);

            lines.forEach((line, index) => {
                const width = skeleton.measureText(line, style);
                const textY = blockTop + index * lineHeight + (lineHeight + fontSize * 0.72) / 2;
                const textX = horizontalOffset(rect, width, hAlign, paddingX, paddingR);

                // 半像素偏移：1px 线在整数坐标上会被抗锯齿糊成 2px 灰线
                ctx.fillText(line, textX + ONE_PIXEL_FIX, textY + ONE_PIXEL_FIX, available);

                drawTextDecoration(ctx, skeleton, style, line, textX, textY, fontSize);
            });

            ctx.restore();
        });
    },
};

/**
 * 从当前格子往右看，累加连续「空且无背景色」的格子，返回文本可以画到的最右 x。
 * 这就是 Excel 里文字流到右边空格子的实现。
 */
function measureSpillRight(
    dc: IDrawContext,
    row: number,
    column: number,
    rect: IRect,
    paddingX: number,
    paddingR: number
): number {
    const { skeleton, worksheet, styles } = dc;
    // 不溢出时文本最多画到自己右内边距处
    let rightEdge = rect.x + rect.width - paddingR;

    for (let c = column + 1; c < worksheet.columnCount; c++) {
        const neighbor = worksheet.getCell(row, c);
        if (neighbor && worksheet.cellText(neighbor) !== '') break;

        const neighborStyle = worksheet.resolveCell(row, c, styles);
        if (skeleton.resolveColor(neighborStyle?.bg)) break;

        rightEdge = skeleton.cellRect(row, c).x + skeleton.getColumnWidth(c) - paddingR;
    }

    // 起点是 rect.x + paddingX，返回的可用宽度至少要装下一个字符
    return Math.max(rightEdge, rect.x + paddingX + 1);
}

function verticalOffset(
    rect: IRect,
    totalHeight: number,
    align: VerticalAlign,
    style?: IStyleData
): number {
    const padTop = style?.pd?.t ?? 0;
    const padBottom = style?.pd?.b ?? 0;
    const inner = rect.height - padTop - padBottom;

    switch (align) {
        case VA.TOP:
            return rect.y + padTop;
        case VA.BOTTOM:
            return rect.y + rect.height - padBottom - totalHeight;
        case VA.MIDDLE:
        default:
            return rect.y + padTop + (inner - totalHeight) / 2;
    }
}

function horizontalOffset(
    rect: IRect,
    textWidth: number,
    align: HorizontalAlign,
    padLeft: number,
    padRight: number
): number {
    switch (align) {
        case HA.CENTER:
            return rect.x + (rect.width - textWidth) / 2;
        case HA.RIGHT:
        case HA.DISTRIBUTED:
            return rect.x + rect.width - padRight - textWidth;
        case HA.LEFT:
        case HA.JUSTIFIED:
        case HA.BOTH:
        case HA.UNSPECIFIED:
        default:
            return rect.x + padLeft;
    }
}

/** 下划线 / 删除线 */
function drawTextDecoration(
    ctx: CanvasRenderingContext2D,
    skeleton: SheetSkeleton,
    style: IStyleData | undefined,
    line: string,
    textX: number,
    textY: number,
    fontSize: number
): void {
    if (line === '') return;
    const width = skeleton.measureText(line, style);
    if (width <= 0) return;

    const color = skeleton.resolveColor(style?.cl, '#1f2329');

    if (style?.ul && style.ul.s) {
        const underlineColor = style.ul.c === 0 ? skeleton.resolveColor(style.ul.cl, color) : color;
        const y = textY + fontSize * 0.22;
        ctx.save();
        ctx.strokeStyle = underlineColor;
        ctx.lineWidth = Math.max(1, fontSize / 14);
        ctx.beginPath();
        ctx.moveTo(textX, y);
        ctx.lineTo(textX + width, y);
        ctx.stroke();
        ctx.restore();
    }

    if (style?.st && style.st.s) {
        const strikeColor = style.st.c === 0 ? skeleton.resolveColor(style.st.cl, color) : color;
        const y = textY - fontSize * 0.12;
        ctx.save();
        ctx.strokeStyle = strikeColor;
        ctx.lineWidth = Math.max(1, fontSize / 14);
        ctx.beginPath();
        ctx.moveTo(textX, y);
        ctx.lineTo(textX + width, y);
        ctx.stroke();
        ctx.restore();
    }
}
