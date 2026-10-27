/**
 * 工作簿模型 —— 顶层容器。
 *
 * 对照 Univer: packages/core/src/sheets/workbook.ts (511 行)
 *
 * 职责：
 *   1. 持有多张 Worksheet + sheetOrder
 *   2. 持有共享样式表 styles（单元格按 id 引用，避免重复）
 *   3. 提供 toJSON() 作为与服务端的契约（就是 IWorkbookData）
 */

import { ObjectMatrix } from './object-matrix';
import { Worksheet } from './worksheet';
import type { ICellData, IStyleData, IStylePatch, ObjectMatrixPrimitive } from './types';

export class Workbook {
    readonly id: string;
    name: string;
    appVersion: string;
    /** 文档语言，本引擎不解析但要原样带回服务端 */
    readonly locale: string;
    /** 插件数据（筛选/批注/条件格式），本引擎不解析但要原样带回 */
    readonly resources: unknown[];

    /**
     * 共享样式表。单元格里只存样式 id。
     *
     * 这就是样式归并：xlsx 里每个格子都自带完整样式，直接内联会让 JSON 爆炸。
     * 归并后一万格相同样式在 JSON 里只占一份。
     */
    readonly styles: Record<string, IStyleData> = {};

    private readonly _sheets = new Map<string, Worksheet>();
    private _sheetOrder: string[] = [];
    private _activeSheetId = '';

    /** 同一份 JSON 只占一个 id，反过来靠这个 map 做 O(1) 查重 */
    private readonly _styleIndex = new Map<string, string>();

    constructor(init: {
        id: string;
        name: string;
        appVersion: string;
        locale?: string;
        styles?: Record<string, IStyleData>;
        sheetOrder: string[];
        sheets: Worksheet[];
        resources?: unknown[];
    }) {
        this.id = init.id;
        this.name = init.name;
        this.appVersion = init.appVersion;
        this.locale = init.locale ?? '';
        this.resources = init.resources ? [...init.resources] : [];

        for (const [id, style] of Object.entries(init.styles ?? {})) {
            this.styles[id] = style;
            this._styleIndex.set(this._styleKey(style), id);
        }

        for (const sheet of init.sheets) {
            this._sheets.set(sheet.id, sheet);
        }
        this._sheetOrder = [...init.sheetOrder];
        this._activeSheetId = this._sheetOrder[0] ?? '';
    }

    // ─────────────────────────── sheet ───────────────────────────

    get sheetOrder(): readonly string[] {
        return this._sheetOrder;
    }

    get activeSheetId(): string {
        return this._activeSheetId;
    }

    getActiveSheet(): Worksheet | undefined {
        return this._sheets.get(this._activeSheetId);
    }

    getSheet(id: string): Worksheet | undefined {
        return this._sheets.get(id);
    }

    /** 有序的全部工作表 */
    getSheets(): Worksheet[] {
        return this._sheetOrder
            .map((id) => this._sheets.get(id))
            .filter((s): s is Worksheet => s !== undefined);
    }

    setActiveSheet(id: string): boolean {
        if (!this._sheets.has(id)) return false;
        this._activeSheetId = id;
        return true;
    }

    addSheet(sheet: Worksheet, index = -1): void {
        this._sheets.set(sheet.id, sheet);
        if (index < 0 || index >= this._sheetOrder.length) {
            this._sheetOrder.push(sheet.id);
        } else {
            this._sheetOrder.splice(index, 0, sheet.id);
        }
    }

    /** 至少要留一张表 */
    removeSheet(id: string): boolean {
        if (this._sheetOrder.length <= 1) return false;
        const index = this._sheetOrder.indexOf(id);
        if (index < 0) return false;

        this._sheetOrder.splice(index, 1);
        this._sheets.delete(id);

        if (this._activeSheetId === id) {
            this._activeSheetId =
                this._sheetOrder[Math.min(index, this._sheetOrder.length - 1)] ?? '';
        }
        return true;
    }

    renameSheet(id: string, name: string): boolean {
        const sheet = this._sheets.get(id);
        if (!sheet) return false;
        sheet.name = name;
        return true;
    }

    // ─────────────────────────── 样式 ───────────────────────────

    private _styleKey(style: IStyleData): string {
        // 用排序后的 key 保证 {a:1,b:2} 与 {b:2,a:1} 判为同一份
        return JSON.stringify(style, Object.keys(style).sort());
    }

    /**
     * 把一段样式塞进共享样式表，返回可以写进 ICellData.s 的 id。
     * 相同内容复用已有的 id。
     */
    registerStyle(style: IStyleData): string {
        const key = this._styleKey(style);
        const existing = this._styleIndex.get(key);
        if (existing !== undefined) return existing;

        const id = `s${Object.keys(this.styles).length + 1}`;
        this.styles[id] = { ...style };
        this._styleIndex.set(key, id);
        return id;
    }

    /**
     * 读出某个样式 id 的完整样式。
     * 单元格的 s 可能是内联对象，所以入参是 `IStyleData | string | null`。
     */
    resolveStyle(ref: IStyleData | string | null | undefined): IStyleData | undefined {
        if (ref == null) return undefined;
        return typeof ref === 'string' ? this.styles[ref] : ref;
    }

    /**
     * 在原样式基础上套一层增量，返回**新的**样式 id。
     *
     * 传 null 表示清除该字段。注意返回新 id 而不是原地改：
     * 共享样式可能被其他格子引用，原地改会连带影响一片无辜的单元格。
     */
    patchStyle(base: IStyleData | undefined, patch: IStylePatch): string {
        const merged: IStyleData = { ...(base ?? {}) };
        for (const key of Object.keys(patch) as Array<keyof IStyleData>) {
            const value = patch[key];
            if (value === null) {
                delete merged[key];
            } else if (value !== undefined) {
                // 断言：每个 key 的 value 类型在 IStylePatch 里已约束
                (merged as Record<string, unknown>)[key] = value;
            }
        }
        return this.registerStyle(merged);
    }

    /** 整张工作簿的样式 id 引用计数 —— 用来观测归并效果 */
    styleCount(): number {
        return Object.keys(this.styles).length;
    }

    // ─────────────────────────── 序列化 ───────────────────────────

    /** 某个区域的单元格内容，用于剪贴板 */
    extractMatrix(
        matrix: ObjectMatrix<ICellData>,
        range: { startRow: number; startColumn: number; endRow: number; endColumn: number }
    ): (ICellData | undefined)[][] {
        const out: (ICellData | undefined)[][] = [];
        for (let row = range.startRow; row <= range.endRow; row++) {
            const line: (ICellData | undefined)[] = [];
            for (let column = range.startColumn; column <= range.endColumn; column++) {
                line.push(matrix.getValue(row, column));
            }
            out.push(line);
        }
        return out;
    }

    toJSON(): Record<string, unknown> {
        const sheets: Record<string, unknown> = {};
        for (const id of this._sheetOrder) {
            const sheet = this._sheets.get(id);
            if (sheet) sheets[id] = sheet.toJSON();
        }

        const json: Record<string, unknown> = {
            id: this.id,
            name: this.name,
            appVersion: this.appVersion,
            styles: structuredClone(this.styles),
            sheetOrder: [...this._sheetOrder],
            sheets,
            // resources 是「其他插件的私有数据」，本引擎不理解也不能弄丢
            // —— 哪怕是空数组也要原样带回，否则保存一次就清掉了别人的配置
            resources: structuredClone(this.resources),
        };
        if (this.locale) json.locale = this.locale;
        return json;
    }
}

export type { Worksheet, ObjectMatrixPrimitive };
