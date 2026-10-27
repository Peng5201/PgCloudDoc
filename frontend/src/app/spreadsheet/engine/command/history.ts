/**
 * 撤销/重做栈。
 *
 * 对照 Univer: packages/core/src/services/undoredo/undoredo.service.ts
 *
 * 核心思想：**撤销不是「反向操作」，而是「把之前捕获的旧状态再写回去」**。
 *
 * 为什么？
 *   正向是 A、反向是 B，那就是两份代码。两份代码就有两个 bug 面，
 *   而且很容易不一致：插入行正向处理了合并单元格，反向忘了 —— 数据就错了。
 *
 *   而「捕获旧态 + 重放」只有一份代码（就是 apply 本身），
 *   正反方向都跑同一个函数，不可能不一致。
 *
 * Univer 里形态稍有不同：存的是可序列化的 mutation 列表，
 * undo = 执行 undoMutations。本质一样，**可序列化**是为了协同编辑服务的。
 */

export interface IEdit {
    /** 执行（redo 时也用它） */
    redo(): void;
    /** 撤销：把旧状态写回去 */
    undo(): void;
    /** 人类可读的描述，UI 上「撤销 xxx」用 */
    label: string;
}

export class History {
    private readonly _undoStack: IEdit[] = [];
    private readonly _redoStack: IEdit[] = [];

    constructor(
        private readonly _limit = 200,
        private readonly _onChange?: () => void
    ) {}

    get canUndo(): boolean {
        return this._undoStack.length > 0;
    }

    get canRedo(): boolean {
        return this._redoStack.length > 0;
    }

    get depth(): number {
        return this._undoStack.length;
    }

    get undoLabel(): string | undefined {
        return this._undoStack[this._undoStack.length - 1]?.label;
    }

    get redoLabel(): string | undefined {
        return this._redoStack[this._redoStack.length - 1]?.label;
    }

    /** 执行一次编辑并入栈。这是唯一写数据的入口 */
    push(edit: IEdit): void {
        edit.redo();

        this._undoStack.push(edit);
        // 有新操作就清空 redo 栈 —— 所有编辑器都这样
        this._redoStack.length = 0;

        if (this._undoStack.length > this._limit) {
            this._undoStack.shift();
        }
        this._onChange?.();
    }

    /** 不入栈地执行（例如滚动这类不该被撤销的动作） */
    runTransient(edit: Pick<IEdit, 'redo'>): void {
        edit.redo();
        this._onChange?.();
    }

    undo(): IEdit | undefined {
        const edit = this._undoStack.pop();
        if (!edit) return undefined;
        edit.undo();
        this._redoStack.push(edit);
        this._onChange?.();
        return edit;
    }

    redo(): IEdit | undefined {
        const edit = this._redoStack.pop();
        if (!edit) return undefined;
        edit.redo();
        this._undoStack.push(edit);
        this._onChange?.();
        return edit;
    }

    clear(): void {
        this._undoStack.length = 0;
        this._redoStack.length = 0;
        this._onChange?.();
    }
}
