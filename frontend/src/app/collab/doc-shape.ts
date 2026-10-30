/**
 * Y.Doc 的数据结构 —— 与后端 `backend/src/infra/yjs/ydoc.ts` **逐字段对齐**。
 *
 * 两边不共享代码（服务端不能依赖前端包），靠「字段名一致」达成契约。
 * 任何一边改动结构，另一边必须同步改，否则协同出来的快照会缺字段。
 *
 * ## 结构
 *
 * Y.Doc
 *   ├─ meta:      Y.Map          id / name / appVersion / locale
 *   ├─ styles:    Y.Map<object>  共享样式表，单元格按 id 引用
 *   └─ sheets:    Y.Array<Y.Map> 有序工作表
 *         每个 sheet:
 *           ├─ 标量配置（rowCount / columnCount / zoomRatio…）
 *           ├─ cellData:   Y.Map  key = "row:col:field"  field ∈ v,t,f,s,p
 *           ├─ rowData:    Y.Map  key = "index:field"    field ∈ h,hd,s
 *           ├─ columnData: Y.Map  key = "index:field"    field ∈ w,hd,s
 *           └─ mergeData:  Y.Map  key = "sr:sc:er:ec"
 *
 * ## 为什么 key 里要带字段名
 *
 * 嵌套 Y.Map（`row:col` → Y.Map{v,t,f,s}）在「格子已存在」时能按字段合并，
 * 但两个客户端**同时新建同一个格子**时，各自创建的内层 Y.Map 会在外层 key 上
 * 冲突，Yjs 取 LWW —— 输掉那方整个内层 map 连同所有字段一起消失。
 *
 * 字段名编进 key 后，`0:0:v` 和 `0:0:s` 是两个不同条目，必然共存；
 * 只有同一字段的并发编辑才走 LWW。代价是 key 变多，换的是可预期的合并语义。
 */

import type * as Y from 'yjs';
import type {
    ICellData,
    IColumnData,
    IRowData,
    IWorkbookData,
    IWorksheetData,
} from '../spreadsheet/engine';

/** 单元格的字段 */
export const CELL_FIELDS = ['v', 't', 'f', 's', 'p'] as const;
export const ROW_FIELDS = ['h', 'hd', 's'] as const;
export const COLUMN_FIELDS = ['w', 'hd', 's'] as const;

export const ROOT_META = 'meta';
export const ROOT_STYLES = 'styles';
export const ROOT_SHEETS = 'sheets';

/** `"row:col:field"` */
export function encodeCellKey(row: number, column: number, field: string): string {
    return `${row}:${column}:${field}`;
}

/** `"row:col:field"` → [row, col, field] */
export function decodeCellKey(key: string): [number, number, string] {
    const first = key.indexOf(':');
    const second = key.indexOf(':', first + 1);
    return [
        Number(key.slice(0, first)),
        Number(key.slice(first + 1, second)),
        key.slice(second + 1),
    ];
}

export function encodeIndexKey(index: number, field: string): string {
    return `${index}:${field}`;
}

/** `"index:field"` → [index, field] */
export function decodeIndexKey(key: string): [number, string] {
    const sep = key.indexOf(':');
    return [Number(key.slice(0, sep)), key.slice(sep + 1)];
}

/**
 * 把 Y.Doc 物化成 IWorkbookData —— 引擎 `loadWorkbook()` 吃的就是它。
 *
 * 返回值必须是**纯 JSON**，不能夹带任何 Y 类型：
 * 夹带活的 Y.Map 会让 JSON.stringify 吐出 Yjs 内部结构，
 * 而且把它再 set 进另一个 Y.Doc 会因为「已归属别的 doc」直接抛异常。
 */
export function materialize(doc: Y.Doc, fallbackId: string): IWorkbookData {
    const meta = doc.getMap(ROOT_META);
    const styles = doc.getMap<unknown>(ROOT_STYLES);
    const sheets = doc.getArray<Y.Map<unknown>>(ROOT_SHEETS);

    const sheetOrder: string[] = [];
    const sheetMap: Record<string, Partial<IWorksheetData>> = {};

    for (const sheet of sheets.toArray()) {
        const id = asString(sheet.get('id'), `sheet${sheetOrder.length + 1}`);
        sheetOrder.push(id);
        sheetMap[id] = materializeSheet(id, sheet);
    }

    const stylesOut: Record<string, unknown> = {};
    for (const [styleId, value] of styles.entries()) {
        stylesOut[styleId] = value ? toPlain(value) : null;
    }

    return {
        id: asString(meta.get('id'), fallbackId),
        name: asString(meta.get('name'), '工作簿'),
        appVersion: asString(meta.get('appVersion'), '1.0.0'),
        locale: asString(meta.get('locale'), 'zhCN'),
        styles: stylesOut as IWorkbookData['styles'],
        sheetOrder,
        sheets: sheetMap,
        resources: [],
    };
}

function materializeSheet(id: string, sheet: Y.Map<unknown>): Partial<IWorksheetData> {
    const cellData = sheet.get('cellData') as Y.Map<unknown> | undefined;
    const rowData = sheet.get('rowData') as Y.Map<unknown> | undefined;
    const columnData = sheet.get('columnData') as Y.Map<unknown> | undefined;
    const mergeData = sheet.get('mergeData') as Y.Map<unknown> | undefined;
    const freeze = sheet.get('freeze') as Y.Map<unknown> | undefined;
    const rowHeader = sheet.get('rowHeader') as Y.Map<unknown> | undefined;
    const columnHeader = sheet.get('columnHeader') as Y.Map<unknown> | undefined;

    const cells: Record<number, Record<number, ICellData>> = {};
    for (const [key, value] of cellData?.entries() ?? []) {
        const [row, col, field] = decodeCellKey(key);
        if (!Number.isFinite(row) || !Number.isFinite(col)) continue;
        const cell = ((cells[row] ??= {})[col] ??= {});
        (cell as Record<string, unknown>)[field] = toPlain(value);
    }

    const rows: Record<number, IRowData> = {};
    for (const [key, value] of rowData?.entries() ?? []) {
        const [index, field] = decodeIndexKey(key);
        const row = (rows[index] ??= {});
        (row as Record<string, unknown>)[field] = toPlain(value);
    }

    const columns: Record<number, IColumnData> = {};
    for (const [key, value] of columnData?.entries() ?? []) {
        const [index, field] = decodeIndexKey(key);
        const column = (columns[index] ??= {});
        (column as Record<string, unknown>)[field] = toPlain(value);
    }

    const merges = [...(mergeData?.values() ?? [])].map((v) => toPlain(v));
    merges.sort(
        (a, b) =>
            (a as { startRow: number }).startRow - (b as { startRow: number }).startRow ||
            (a as { startColumn: number }).startColumn - (b as { startColumn: number }).startColumn
    );

    return {
        id,
        name: asString(sheet.get('name'), id),
        tabColor: asString(sheet.get('tabColor'), ''),
        hidden: toNumber(sheet.get('hidden'), 0) as 0 | 1,
        rowCount: toNumber(sheet.get('rowCount'), 200),
        columnCount: toNumber(sheet.get('columnCount'), 26),
        zoomRatio: toNumber(sheet.get('zoomRatio'), 1),
        scrollTop: toNumber(sheet.get('scrollTop'), 0),
        scrollLeft: toNumber(sheet.get('scrollLeft'), 0),
        defaultRowHeight: toNumber(sheet.get('defaultRowHeight'), 24),
        defaultColumnWidth: toNumber(sheet.get('defaultColumnWidth'), 88),
        showGridlines: toNumber(sheet.get('showGridlines'), 1) as 0 | 1,
        gridlinesColor: (sheet.get('gridlinesColor') as string | null | undefined) ?? null,
        freeze: {
            xSplit: toNumber(freeze?.get('xSplit'), 0),
            ySplit: toNumber(freeze?.get('ySplit'), 0),
            startRow: toNumber(freeze?.get('startRow'), 0),
            startColumn: toNumber(freeze?.get('startColumn'), 0),
        },
        rowHeader: {
            width: toNumber(rowHeader?.get('width'), 46),
            hidden: toNumber(rowHeader?.get('hidden'), 0) as 0 | 1,
        },
        columnHeader: {
            height: toNumber(columnHeader?.get('height'), 24),
            hidden: toNumber(columnHeader?.get('hidden'), 0) as 0 | 1,
        },
        cellData: cells,
        rowData: rows,
        columnData: columns,
        mergeData: merges as unknown as IWorksheetData['mergeData'],
    };
}

/** 深度转纯 JSON（Y.Map / Y.Array 递归摊平） */
function toPlain(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    const proto = Object.getPrototypeOf(value);
    // Yjs 的 Y.Map 实例有 entries() 且不是普通对象
    if (typeof (value as { entries?: unknown }).entries === 'function' && proto !== Object.prototype) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of (value as Map<string, unknown>).entries()) out[k] = toPlain(v);
        return out;
    }
    if (Array.isArray(value)) return value.map(toPlain);
    return value;
}

function asString(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
}

function toNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
