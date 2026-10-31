/**
 * 工作簿对象 —— 顶层容器。
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

    /**
     * 新样式注册回调。协同层用它把新样式写进 Y.Doc 的共享样式表。
     *
     * 没有这个钩子，本地改样式只会同步 `cell.s`（一个 id），
     * 其他协作者拿到 id 却找不到样式 —— 表现就是「工具栏操作别人看不到」。
     */
    onStyleRegister: ((id: string, style: IStyleData) => void) | null = null;

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
        return canonicalStringify(style);
    }

    /**
     * 把一段样式塞进共享样式表，返回可以写进 ICellData.s 的 id。
     * 相同内容复用已有的 id。
     */
    registerStyle(style: IStyleData): string {
        const key = this._styleKey(style);
        const existing = this._styleIndex.get(key);
        if (existing !== undefined) return existing;

        // 内容寻址：id 由内容哈希决定，两端算出的同一份样式必然同 id，
        // 不同样式不会撞号。用自增计数会在协同里互相覆盖别人的样式。
        const id = `sh${hashStyleKey(key)}`;
        this.styles[id] = { ...style };
        this._styleIndex.set(key, id);
        this.onStyleRegister?.(id, this.styles[id]);
        return id;
    }

    /**
     * 接收远端样式：按 id 写入，不触发注册回调（避免回声）。
     * 同时补进查重索引，之后本地产生同样式时能复用这个 id。
     */
    addStyle(id: string, style: IStyleData): void {
        this.styles[id] = style;
        const key = this._styleKey(style);
        if (!this._styleIndex.has(key)) this._styleIndex.set(key, id);
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

// ─────────────────────────── 样式指纹 ───────────────────────────

/**
 * 递归排序对象键后的 JSON 串，用作样式指纹。
 *
 * 必须递归：样式里有 `cl:{rgb}`、`bd:{t:{s,cl}}` 这类嵌套对象。
 * `JSON.stringify(style, keys)` 的 replacer 数组会连嵌套键一起过滤，
 * 导致「只差颜色」的两份样式被判成同一份。
 */
function canonicalStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
}

/** FNV-1a 64 位 → base36。样式数量少，碰撞概率可忽略 */
function hashStyleKey(key: string): string {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let i = 0; i < key.length; i += 1) {
        hash ^= BigInt(key.charCodeAt(i));
        hash = (hash * prime) & 0xffffffffffffffffn;
    }
    return hash.toString(36);
}
