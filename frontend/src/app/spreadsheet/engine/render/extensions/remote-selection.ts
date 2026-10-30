/**
 * 其他协作者的选区层。
 *
 * 画两样东西：
 *   1. 半透明的选区底色 + 描边，颜色来自该协作者（和顶栏头像一致）
 *   2. 左上角一个小的名字标签，不然光看颜色分不清是谁
 *
 * 画在自己选区（SELECTION=100）下面：别人的高亮永远不该盖住自己的。
 */

import type { IRemoteSelection, IDrawContext, ISheetExtension } from './extension';
import { EXTENSION_ORDER, ONE_PIXEL_FIX } from './extension';
import { normalizeRange } from '../../model/types';

/** 底色要"亮但不刺眼"：低透明度 + 中饱和度的线 */
const FILL_ALPHA = 0.12;
const BORDER_ALPHA = 0.55;
const ACTIVE_ALPHA = 0.85;

const LABEL_FONT = '11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
const LABEL_HEIGHT = 17;
const LABEL_PAD_X = 6;
const LABEL_GAP = 2;

export const remoteSelectionExtension: ISheetExtension = {
    order: EXTENSION_ORDER.REMOTE_SELECTION,
    name: 'remote-selection',
    draw(dc: IDrawContext) {
        if (dc.remoteSelections.length === 0) return;
        const { ctx, skeleton } = dc;

        for (const peer of dc.remoteSelections) {
            const ranges = sanitize(peer);
            if (ranges.length === 0) continue;

            const fill = withAlpha(peer.color, FILL_ALPHA);
            const stroke = withAlpha(peer.color, BORDER_ALPHA);

            ctx.save();

            for (const range of ranges) {
                const rect = skeleton.rangeRect(range);
                if (rect.width <= 0 || rect.height <= 0) continue;

                ctx.fillStyle = fill;
                ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

                ctx.strokeStyle = stroke;
                ctx.lineWidth = 1;
                ctx.strokeRect(
                    Math.round(rect.x) + ONE_PIXEL_FIX,
                    Math.round(rect.y) + ONE_PIXEL_FIX,
                    rect.width - 1,
                    rect.height - 1
                );
            }

            // 活动格单独描一圈，方便看清对方光标停在哪
            if (peer.active) {
                const cell = skeleton.cellRect(peer.active.row, peer.active.column);
                if (cell.width > 0 && cell.height > 0) {
                    ctx.strokeStyle = withAlpha(peer.color, ACTIVE_ALPHA);
                    ctx.lineWidth = 1.5;
                    ctx.strokeRect(
                        Math.round(cell.x) + ONE_PIXEL_FIX,
                        Math.round(cell.y) + ONE_PIXEL_FIX,
                        cell.width - 1,
                        cell.height - 1
                    );
                }
            }

            // 名字标签挂在主选区（最后一个矩形）左上角
            const primary = ranges[ranges.length - 1]!;
            drawLabel(ctx, skeleton.rangeRect(primary), peer.name, peer.color);

            ctx.restore();
        }
    },
};

/** 防御性归一化：远端数据可能是任意形状，先统一四个角再画 */
function sanitize(peer: IRemoteSelection) {
    const out = [];
    for (const range of peer.ranges) {
        if (
            !range ||
            !Number.isFinite(range.startRow) ||
            !Number.isFinite(range.startColumn) ||
            !Number.isFinite(range.endRow) ||
            !Number.isFinite(range.endColumn)
        ) {
            continue;
        }
        out.push(normalizeRange(range));
    }
    return out;
}

function drawLabel(
    ctx: CanvasRenderingContext2D,
    rect: { x: number; y: number; width: number; height: number },
    name: string,
    color: string
): void {
    if (!name) return;

    ctx.font = LABEL_FONT;
    const textWidth = ctx.measureText(name).width;
    const width = Math.ceil(textWidth) + LABEL_PAD_X * 2;

    // 优先画在选区上方；顶到内容顶部就画在框内
    let y = rect.y - LABEL_HEIGHT - LABEL_GAP;
    if (y < 0) y = rect.y;

    ctx.fillStyle = color;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(rect.x, y, width, LABEL_HEIGHT, 3);
    } else {
        ctx.rect(rect.x, y, width, LABEL_HEIGHT);
    }
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, rect.x + LABEL_PAD_X, y + LABEL_HEIGHT / 2 + 0.5, width - LABEL_PAD_X * 2);
}

/** #RRGGBB / #RGB → rgba()。颜色值非法时原样返回，至少不会画出错误色 */
export function withAlpha(hex: string, alpha: number): string {
    const raw = hex.replace('#', '');
    const full =
        raw.length === 3
            ? raw
                  .split('')
                  .map((c) => c + c)
                  .join('')
            : raw;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return hex;

    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
