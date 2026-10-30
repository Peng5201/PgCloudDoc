/**
 * 单元格编辑器 —— 浮动输入框覆盖层。
 *
 * 对照 Univer: packages/sheets-ui/src/controllers/editor/
 *              + packages/sheets-ui/src/views/editor-container/
 *              （Univer 里复杂得多：RichText 编辑器 + 同步控制器 + 公式栏联动）
 *
 * 关键设计洞察：**单元格编辑时显示的不是单元格本身，而是浮在上面的一个输入框。**
 *
 * 为什么不能「就地改 canvas 上的文字」？
 *   1. canvas 是位图，每帧重绘，光标位置、选中文本、滚动条都得自己实现
 *   2. 输入法（IME）组合态只有原生 input/textarea 才能正确处理
 *   3. 复制粘贴、系统撤销等行为要自己接管，很容易漏
 *
 * 所有表格引擎都选了同一个方案：编辑态切到 DOM 输入框，确认后写回工作表。
 * Univer 在此基础上把编辑框做成了另一个文档编辑器（RichText）来支持富文本。
 */

import type { IStyleData } from '../model/types';
import { HorizontalAlign as HA, WrapStrategy as WS } from '../model/types';
import type { Worksheet } from '../model/worksheet';
import type { Workbook } from '../model/workbook';
import type { SheetSkeleton } from '../render/skeleton';
import type { Renderer } from '../render/renderer';

export interface IEditorHandlers {
    /** Enter/Tab 确认。move 是相对偏移，null 表示留在原地 */
    commit(text: string, move: { row: number; column: number } | null): void;
    /** Esc 取消 */
    cancel(): void;
    /** 内容变化（公式栏联动用） */
    input?(text: string): void;
}

/**
 * 编辑器要读的东西。worksheet / skeleton 是**只读 getter**：
 * 切换工作表时 SheetEngine 会换掉底层引用，编辑器每次现取才不会拿到旧的。
 */
export interface IEditorContext {
    readonly workbook: Workbook;
    readonly worksheet: Worksheet;
    readonly skeleton: SheetSkeleton;
    readonly renderer: Renderer;
}

export class CellEditor {
    readonly element: HTMLTextAreaElement;

    private _isOpen = false;
    private _anchor: { row: number; column: number } | null = null;

    constructor(
        private readonly _host: HTMLElement,
        private readonly _ctx: IEditorContext,
        private readonly _handlers: IEditorHandlers
    ) {
        this.element = document.createElement('textarea');
        this.element.spellcheck = false;
        this.element.setAttribute('data-sheet-editor', '1');
        this.element.style.cssText = [
            'position:absolute',
            'display:none',
            'box-sizing:border-box',
            'margin:0',
            'padding:3px 6px',
            'border:2px solid #2b5be0',
            'outline:none',
            'resize:none',
            'overflow:hidden',
            'background:#fff',
            'color:#1f2329',
            'z-index:10',
            'line-height:1.3',
            'white-space:pre-wrap',
        ].join(';');
        this._host.appendChild(this.element);

        this._bind();
    }

    get isOpen(): boolean {
        return this._isOpen;
    }

    get anchor(): { row: number; column: number } | null {
        return this._anchor;
    }

    get value(): string {
        return this.element.value;
    }

    set value(text: string) {
        this.element.value = text;
    }

    /**
     * 打开编辑器。
     * @param selectAll  true = 全选内容（直接键入会覆盖旧值）；
     *                   false = 光标移到末尾（双击/F2 后继续编辑）
     */
    open(row: number, column: number, initialValue?: string, selectAll = true): void {
        const { worksheet, workbook, skeleton } = this._ctx;

        this._anchor = { row, column };
        this._isOpen = true;

        const cell = worksheet.getCell(row, column);
        const style = worksheet.resolveCell(row, column, workbook.styles);
        const text = initialValue ?? worksheet.cellText(cell);

        this.element.value = text;
        this.element.style.display = 'block';
        this.element.style.font = skeleton.fontOf(style);
        this.element.style.color = skeleton.resolveColor(style?.cl, '#1f2329');
        this.element.style.textAlign = this._textAlign(style);
        this.element.style.whiteSpace =
            skeleton.wrapStrategy(style) === WS.WRAP ? 'pre-wrap' : 'pre';

        this.layout();

        this.element.focus();
        if (selectAll) {
            this.element.select();
        } else {
            const end = this.element.value.length;
            this.element.setSelectionRange(end, end);
        }
    }

    /** 输入框要跟着单元格走 —— 滚动 / 缩放 / 改行高时都要重新定位 */
    layout(): void {
        if (!this._isOpen || !this._anchor) return;

        const { row, column } = this._anchor;
        const { skeleton, renderer } = this._ctx;
        const rect = skeleton.cellRect(row, column);
        const screen = renderer.contentToScreen(rect.x, rect.y);

        this.element.style.left = `${screen.x - 1}px`;
        this.element.style.top = `${screen.y - 1}px`;
        this.element.style.width = `${Math.max(rect.width * renderer.zoom + 2, 80)}px`;
        this.element.style.height = `${rect.height * renderer.zoom + 2}px`;
        this.element.style.lineHeight = `${skeleton.fontSize() * 1.3}px`;
    }

    /** 从外部（公式栏）同步内容进来 */
    syncText(text: string): void {
        if (!this._isOpen) return;
        if (this.element.value === text) return;
        this.element.value = text;
        this._autoGrow();
    }

    close(): void {
        if (!this._isOpen) return;
        this._isOpen = false;
        this._anchor = null;
        this.element.style.display = 'none';
        this.element.blur();
    }

    focus(): void {
        if (this._isOpen) this.element.focus();
    }

    dispose(): void {
        this.close();
        this.element.remove();
    }

    private _textAlign(style?: IStyleData): string {
        switch (style?.ht) {
            case HA.CENTER:
                return 'center';
            case HA.RIGHT:
                return 'right';
            default:
                return 'left';
        }
    }

    private _autoGrow(): void {
        if (!this._anchor) return;
        const rect = this._ctx.skeleton.cellRect(this._anchor.row, this._anchor.column);
        const minHeight = rect.height * this._ctx.renderer.zoom + 2;
        this.element.style.height = 'auto';
        this.element.style.height = `${Math.max(minHeight, this.element.scrollHeight)}px`;
    }

    private _bind(): void {
        this.element.addEventListener('keydown', (event) => {
            if (!this._anchor) return;

            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                const anchor = this._anchor;
                this.close();
                this._handlers.cancel();
                void anchor;
                return;
            }

            // Alt+Enter = 单元格内换行（Excel 的行为）
            if (event.key === 'Enter' && event.altKey) {
                event.preventDefault();
                const start = this.element.selectionStart;
                const end = this.element.selectionEnd;
                const value = this.element.value;
                this.element.value = `${value.slice(0, start)}\n${value.slice(end)}`;
                this.element.setSelectionRange(start + 1, start + 1);
                this._autoGrow();
                this._handlers.input?.(this.element.value);
                return;
            }

            if (event.key === 'Enter') {
                event.preventDefault();
                this._commit({ row: event.shiftKey ? -1 : 1, column: 0 });
                return;
            }

            if (event.key === 'Tab') {
                event.preventDefault();
                this._commit({ row: 0, column: event.shiftKey ? -1 : 1 });
                return;
            }

            // 其余快捷键交给输入框自己处理（光标移动、Ctrl+C/V、IME…）
            event.stopPropagation();
        });

        this.element.addEventListener('input', () => {
            this._autoGrow();
            this._handlers.input?.(this.element.value);
        });

        // 点输入框外部不该把事件冒泡到表格容器，否则会触发选区变化
        this.element.addEventListener('mousedown', (event) => event.stopPropagation());
        this.element.addEventListener('dblclick', (event) => event.stopPropagation());
        this.element.addEventListener('wheel', (event) => event.stopPropagation());
    }

    private _commit(move: { row: number; column: number }): void {
        if (!this._anchor) return;
        const { row, column } = this._anchor;
        const text = this.element.value;

        this.close();
        this._handlers.commit(text, { row: row + move.row, column: column + move.column });
    }
}
