/**
 * 渲染器 —— 一帧是怎么画出来的。
 *
 * 对照 Univer:
 *   packages/engine-render/src/components/sheets/spreadsheet.ts 的 draw()
 *   packages/engine-render/src/engine.ts 的脏标记 + 帧队列
 *
 * 四个关键点：
 *   1. **视口裁剪**：只算/只画可见的行列。滚到第 5000 行和第 5 行代价一样
 *   2. **脏标记 + rAF**：连续输入 20 个字符只重绘 1 次，不每字一帧
 *   3. **DPR 缩放**：高分屏上 1 CSS 像素 = N 设备像素，不处理会糊
 *   4. **表头是固定层**：画在屏幕坐标系里，不参与滚动/缩放
 */

import type { ISelection } from '../interact/selection';
import type { IStyleData } from '../model/types';
import type { Worksheet } from '../model/worksheet';
import type { SheetSkeleton } from './skeleton';
import { columnLabel } from './skeleton';
import type { IDrawContext, ISheetExtension } from './extensions';
import {
    backgroundExtension,
    borderExtension,
    fontExtension,
    gridExtension,
    selectionExtension,
} from './extensions';

export const COLORS = {
    headerBg: '#f7f8fa',
    headerText: '#5f6368',
    headerBorder: '#d9dce1',
    headerActive: '#e8f0fe',
    headerActiveStrong: '#d6e4fd',
    headerActiveText: '#1a56c4',
    bodyBg: '#ffffff',
};

export interface IRendererHost {
    scrollX: number;
    scrollY: number;
    zoom: number;
}

export class Renderer {
    readonly canvas: HTMLCanvasElement;
    readonly ctx: CanvasRenderingContext2D;

    private _extensions: ISheetExtension[];
    private _dirty = false;
    private _rafId = -1;
    private _disposed = false;

    /** 视口在内容坐标系里的偏移 */
    scrollX = 0;
    scrollY = 0;
    /** 缩放，1 = 100% */
    zoom = 1;

    // 由 SheetEngine 注入 —— 渲染层不持有模型所有权，只借引用
    skeleton!: SheetSkeleton;
    worksheet!: Worksheet;
    styles: Record<string, IStyleData> = {};
    /** selection 用 getter：交互层会整体替换 selection 对象，存快照会过期 */
    getSelection: () => ISelection = () => ({
        active: { row: 0, column: 0 },
        ranges: [],
    });

    constructor(private readonly _host: HTMLElement) {
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;';
        this._host.appendChild(this.canvas);

        const ctx = this.canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D context unavailable');
        this.ctx = ctx;

        this._extensions = [
            backgroundExtension,
            gridExtension,
            borderExtension,
            fontExtension,
            selectionExtension,
        ];
    }

    /** 表头尺寸跟随工作表配置 */
    get headerWidth(): number {
        return this.worksheet.rowHeaderWidth;
    }

    get headerHeight(): number {
        return this.worksheet.columnHeaderHeight;
    }

    /** 覆盖/追加绘制层。返回撤销函数 */
    setExtensions(extensions: ISheetExtension[]): () => void {
        const previous = this._extensions;
        this._extensions = [...extensions];
        return () => {
            this._extensions = previous;
        };
    }

    /**
     * 标脏。调用方（模型变更 / 滚动 / 选择变化）只管喊一声，
     * 不需要知道画什么、怎么画。同一帧内的多次调用会被 rAF 合并。
     */
    invalidate(): void {
        if (this._dirty || this._disposed) return;
        this._dirty = true;

        this._rafId = requestAnimationFrame(() => {
            this._dirty = false;
            if (this._disposed) return;
            this.draw();
        });
    }

    dispose(): void {
        this._disposed = true;
        if (this._rafId !== -1) cancelAnimationFrame(this._rafId);
        this._rafId = -1;
        this.canvas.remove();
    }

    // ─────────────────────────── 坐标换算 ───────────────────────────

    /** 视口在内容坐标系下的可视矩形 */
    viewport(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
        const width = Math.max(0, this.canvas.clientWidth - this.headerWidth);
        const height = Math.max(0, this.canvas.clientHeight - this.headerHeight);
        return {
            left: this.scrollX,
            top: this.scrollY,
            right: this.scrollX + width / this.zoom,
            bottom: this.scrollY + height / this.zoom,
            width,
            height,
        };
    }

    /** 内容坐标 → 容器内屏幕坐标（不含表头偏移，给编辑浮层用） */
    contentToScreen(x: number, y: number): { x: number; y: number } {
        return {
            x: this.headerWidth + (x - this.scrollX) * this.zoom,
            y: this.headerHeight + (y - this.scrollY) * this.zoom,
        };
    }

    /** 容器内屏幕坐标 → 内容坐标 */
    screenToContent(x: number, y: number): { x: number; y: number } {
        return {
            x: (x - this.headerWidth) / this.zoom + this.scrollX,
            y: (y - this.headerHeight) / this.zoom + this.scrollY,
        };
    }

    // ─────────────────────────── 绘制 ───────────────────────────

    private draw(): void {
        const { ctx, canvas } = this;
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.clientWidth;
        const cssH = canvas.clientHeight;

        if (cssW <= 0 || cssH <= 0) return;

        // 尺寸变了要同步底层位图，否则高分屏会糊
        const bitmapW = Math.round(cssW * dpr);
        const bitmapH = Math.round(cssH * dpr);
        if (canvas.width !== bitmapW || canvas.height !== bitmapH) {
            canvas.width = bitmapW;
            canvas.height = bitmapH;
        }

        // 从这里开始所有坐标都是 CSS 像素（dpr 已并入 transform）
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = COLORS.bodyBg;
        ctx.fillRect(0, 0, cssW, cssH);

        this.drawContent(ctx);
        this.drawHeaders(ctx);
    }

    /** 内容区：先裁剪到内容矩形，再进内容坐标系 */
    private drawContent(ctx: CanvasRenderingContext2D): void {
        const skeleton = this.skeleton;
        if (!skeleton) return;

        skeleton.ensure();
        const vp = this.viewport();
        if (vp.width <= 0 || vp.height <= 0) return;

        const view = skeleton.visibleRange(vp);
        if (view.endRow < view.startRow || view.endColumn < view.startColumn) return;

        ctx.save();
        ctx.beginPath();
        ctx.rect(this.headerWidth, this.headerHeight, vp.width, vp.height);
        ctx.clip();

        // 表头偏移 → 缩放 → 减去滚动量
        ctx.translate(this.headerWidth, this.headerHeight);
        ctx.scale(this.zoom, this.zoom);
        ctx.translate(-this.scrollX, -this.scrollY);

        const dc: IDrawContext = {
            ctx,
            skeleton,
            worksheet: this.worksheet,
            styles: this.styles,
            view,
            selection: this.getSelection(),
            zoom: this.zoom,
        };

        // order 决定图层顺序：background → grid → border → font → selection
        for (const extension of this._extensions) {
            extension.draw(dc);
        }

        ctx.restore();
    }

    /**
     * 表头。画在屏幕坐标系 —— 所以滚动和缩放都不影响它。
     * 只画可见的行列号，跟内容区是同一套视口裁剪逻辑。
     *
     * **关键约束：表头的高亮只能画在表头带里。**
     * 早先的写法是整列/整行一把 fillRect 铺下去，结果高亮盖在了正文上
     * （选中 A1 时 A 列的单元格内容全被刷掉）。这里用 clip 把绘制限制在
     * 「顶部带 + 左侧带」的并集内，越界一笔都画不出来。
     */
    private drawHeaders(ctx: CanvasRenderingContext2D): void {
        const skeleton = this.skeleton;
        if (!skeleton) return;

        const cssW = this.canvas.clientWidth;
        const cssH = this.canvas.clientHeight;
        const hw = this.headerWidth;
        const hh = this.headerHeight;
        const vp = this.viewport();
        const view = skeleton.visibleRange(vp);
        const selection = this.getSelection();
        const active = selection.active;

        // 命中的行列要高亮 —— 选中格子时它的行号/列名变色，是 Excel 的视觉反馈
        const hitRows = new Set<number>();
        const hitColumns = new Set<number>();
        for (const r of selection.ranges) {
            for (let row = r.startRow; row <= r.endRow; row++) hitRows.add(row);
            for (let column = r.startColumn; column <= r.endColumn; column++) {
                hitColumns.add(column);
            }
        }

        ctx.save();

        // 只允许画在表头带内：顶部一条 + 左侧一条
        ctx.beginPath();
        ctx.rect(0, 0, cssW, hh);
        ctx.rect(0, 0, hw, cssH);
        ctx.clip();

        ctx.fillStyle = COLORS.headerBg;
        ctx.fillRect(0, 0, cssW, hh);
        ctx.fillRect(0, 0, hw, cssH);

        ctx.font = '12px Arial, "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // —— 列头（A B C …）——
        for (let column = view.startColumn; column <= view.endColumn; column++) {
            const width = skeleton.getColumnWidth(column) * this.zoom;
            const screenX = hw + (skeleton.cellRect(0, column).x - this.scrollX) * this.zoom;
            if (screenX + width < hw || screenX > cssW) continue;

            const isActive = column === active.column;
            if (isActive) {
                ctx.fillStyle = COLORS.headerActiveStrong;
            } else if (hitColumns.has(column)) {
                ctx.fillStyle = COLORS.headerActive;
            } else {
                ctx.fillStyle = COLORS.headerBg;
            }
            ctx.fillRect(screenX, 0, width, hh);

            ctx.fillStyle = isActive || hitColumns.has(column)
                ? COLORS.headerActiveText
                : COLORS.headerText;
            ctx.fillText(columnLabel(column), screenX + width / 2, hh / 2 + 0.5, width - 4);
        }

        // —— 行头（1 2 3 …）——
        for (let row = view.startRow; row <= view.endRow; row++) {
            const height = skeleton.getRowHeight(row) * this.zoom;
            const screenY = hh + (skeleton.cellRect(row, 0).y - this.scrollY) * this.zoom;
            if (screenY + height < hh || screenY > cssH) continue;

            const isActive = row === active.row;
            if (isActive) {
                ctx.fillStyle = COLORS.headerActiveStrong;
            } else if (hitRows.has(row)) {
                ctx.fillStyle = COLORS.headerActive;
            } else {
                ctx.fillStyle = COLORS.headerBg;
            }
            ctx.fillRect(0, screenY, hw, height);

            ctx.fillStyle = isActive || hitRows.has(row)
                ? COLORS.headerActiveText
                : COLORS.headerText;
            ctx.fillText(String(row + 1), hw / 2, screenY + height / 2 + 0.5, hw - 6);
        }

        // —— 分隔线 + 左上角全选块 ——
        ctx.fillStyle = COLORS.headerBg;
        ctx.fillRect(0, 0, hw, hh);

        ctx.strokeStyle = COLORS.headerBorder;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, hh - 0.5);
        ctx.lineTo(cssW, hh - 0.5);
        ctx.moveTo(hw - 0.5, 0);
        ctx.lineTo(hw - 0.5, cssH);
        ctx.stroke();

        // 全选块上的小三角，提示可以点
        ctx.fillStyle = COLORS.headerText;
        ctx.beginPath();
        ctx.moveTo(hw - 8, hh - 6);
        ctx.lineTo(hw - 3, hh - 6);
        ctx.lineTo(hw - 3, hh - 3);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
    }
}
