/**
 * Yjs 文档结构 —— 协同编辑的数据模型。
 *
 * ## 为什么用 CRDT 而不是 OT
 *
 * OT 需要一个中心服务器做变换，客户端离线改完再同步要走复杂的 rebase；
 * CRDT 的合并满足交换律/结合律，任意顺序合并结果一致，天然支持离线。
 * 云文档场景「断网继续编辑」几乎是刚需，所以选 CRDT。
 * 实现用 Yjs：生态最成熟（y-protocols 的 sync/awareness 协议是事实标准）。
 *
 * ## 结构设计：扁平 key，不是嵌套 Y.Map
 *
 * Y.Doc
 *   ├─ meta:      Y.Map          文档级配置（name/appVersion/locale）
 *   ├─ styles:    Y.Map<object>  共享样式表，单元格按 id 引用（整份样式 LWW）
 *   └─ sheets:    Y.Array<Y.Map> 有序工作表
 *         每个 sheet:
 *           ├─ 标量配置（rowCount / columnCount / zoomRatio…）
 *           ├─ cellData:   Y.Map  key = "row:col:field"  field ∈ v,t,f,s,p
 *           ├─ rowData:    Y.Map  key = "row:field"      field ∈ h,hd,s
 *           ├─ columnData: Y.Map  key = "col:field"      field ∈ w,hd,s
 *           └─ mergeData:  Y.Map  key = "sr:sc:er:ec"    值是整块范围
 *
 * ### 为什么 key 里要带上字段名（而不是 `row:col` → Y.Map{v,t,f,s}）
 *
 * 这是踩过坑之后的结论。嵌套 Y.Map 在「格子已经存在」时确实能按字段合并，
 * 但**两个客户端同时新建同一个格子**时，各自创建的那个内层 Y.Map 会在
 * 外层 key 上冲突，Yjs 取 LWW —— 输掉的那一方，整个内层 map 连同里面所有
 * 字段一起消失。表现为「A 改内容、B 改样式，最后样式没了」。
 *
 * 把字段名编进 key 之后，A 写 `0:0:v`、B 写 `0:0:s` 是两个不同的 map 条目，
 * 不存在冲突，两者必然共存。同一字段的并发编辑才走 LWW —— 这正是想要的粒度。
 *
 * 代价是 key 数量变成每个格子 5 个，换来的是可预期的合并语义。
 */

import * as Y from 'yjs';
import type {
    SnapshotCellData,
    SnapshotRange,
    SnapshotWorkbook,
    SnapshotWorksheet,
} from './ydoc.types';

export const SNAPSHOT_APP_VERSION = '1.0.0';

const ROOT_META = 'meta';
const ROOT_STYLES = 'styles';
const ROOT_SHEETS = 'sheets';

/** 单元格的字段。新增字段要同时改这里的列表和 cellMapToObject */
const CELL_FIELDS = ['v', 't', 'f', 's', 'p'] as const;
const ROW_FIELDS = ['h', 'hd', 's'] as const;
const COLUMN_FIELDS = ['w', 'hd', 's'] as const;


// ─────────────────────────── key 编解码 ───────────────────────────

/** `"row:col:field"` */
export function encodeCellKey(row: number, column: number, field: string): string {
    return `${row}:${column}:${field}`;
}

/** `"row:col:field"` → [row, col, field] */
export function decodeCellKey(key: string): [number, number, string] {
    const first = key.indexOf(':');
    const second = key.indexOf(':', first + 1);
    return [Number(key.slice(0, first)), Number(key.slice(first + 1, second)), key.slice(second + 1)];
}

function encodeIndexKey(index: number, field: string): string {
    return `${index}:${field}`;
}

// ─────────────────────────── 创建 ───────────────────────────

export interface CreateDocOptions {
    id: string;
    name: string;
    sheetName?: string;
    rowCount?: number;
    columnCount?: number;
    locale?: string;
}

/** 造一份空白工作簿的 Y.Doc */
export function createEmptyDoc(options: CreateDocOptions): Y.Doc {
    const doc = new Y.Doc();

    doc.transact(() => {
        const meta = doc.getMap(ROOT_META);
        meta.set('id', options.id);
        meta.set('name', options.name);
        meta.set('appVersion', SNAPSHOT_APP_VERSION);
        meta.set('locale', options.locale ?? 'zhCN');

        const sheets = doc.getArray<Y.Map<unknown>>(ROOT_SHEETS);
        sheets.push([createSheet(options).sheet]);
    });

    return doc;
}

/**
 * 建一张空表。
 *
 * 注意返回的是 **parts 而不是单个 Y.Map**：未集成（还没挂进 doc）的 YMap
 * 读自己的 `_prelimContent` 会拿到 undefined（Yjs 会 warn "Add Yjs type to a
 * document before reading data"），所以子 map 必须在这里就建好交出去，
 * 不能让调用方回头去 `sheet.get('cellData')`。
 */
interface SheetParts {
    sheet: Y.Map<unknown>;
    cellData: Y.Map<unknown>;
    rowData: Y.Map<unknown>;
    columnData: Y.Map<unknown>;
    mergeData: Y.Map<SnapshotRange>;
}

function createSheet(options: CreateDocOptions, sheetId = 'sheet1'): SheetParts {
    const sheet = new Y.Map<unknown>();
    sheet.set('id', sheetId);
    sheet.set('name', options.sheetName ?? 'Sheet1');
    sheet.set('tabColor', '');
    sheet.set('hidden', 0);
    sheet.set('rowCount', options.rowCount ?? 200);
    sheet.set('columnCount', options.columnCount ?? 26);
    sheet.set('zoomRatio', 1);
    sheet.set('scrollTop', 0);
    sheet.set('scrollLeft', 0);
    sheet.set('defaultRowHeight', 24);
    sheet.set('defaultColumnWidth', 88);
    sheet.set('showGridlines', 1);
    sheet.set('gridlinesColor', null);

    const freeze = new Y.Map<unknown>();
    freeze.set('xSplit', 0);
    freeze.set('ySplit', 0);
    freeze.set('startRow', 0);
    freeze.set('startColumn', 0);
    sheet.set('freeze', freeze);

    const rowHeader = new Y.Map<unknown>();
    rowHeader.set('width', 46);
    rowHeader.set('hidden', 0);
    sheet.set('rowHeader', rowHeader);

    const columnHeader = new Y.Map<unknown>();
    columnHeader.set('height', 24);
    columnHeader.set('hidden', 0);
    sheet.set('columnHeader', columnHeader);

    // 三张扁平表 + 一张合并区表，全部用「下标:字段」做 key（见文件头注释）
    const cellData = new Y.Map<unknown>();
    const rowData = new Y.Map<unknown>();
    const columnData = new Y.Map<unknown>();
    const mergeData = new Y.Map<SnapshotRange>();
    sheet.set('cellData', cellData);
    sheet.set('rowData', rowData);
    sheet.set('columnData', columnData);
    sheet.set('mergeData', mergeData);

    return { sheet, cellData, rowData, columnData, mergeData };
}

// ─────────────────────────── 导出快照 ───────────────────────────

/**
 * 把 Y.Doc 物化成快照（就是前端吃的 IWorkbookData）。
 *
 * **返回值必须是纯 JSON**：不能夹带任何 Y 类型。
 * 夹带活的 Y.Map 有两个后果 —— 拿它去 JSON.stringify 会得到 Yjs 内部结构；
 * 把它再 set 进另一个 Y.Doc 会因为「已归属别的 doc」直接抛异常。
 */
export function materialize(doc: Y.Doc, fallbackId: string): SnapshotWorkbook {
    const meta = doc.getMap(ROOT_META);
    const styles = doc.getMap<unknown>(ROOT_STYLES);
    const sheets = doc.getArray<Y.Map<unknown>>(ROOT_SHEETS);

    const sheetOrder: string[] = [];
    const sheetMap: Record<string, SnapshotWorksheet> = {};

    for (const sheet of sheets.toArray()) {
        const id = asString(sheet.get('id'), `sheet${sheetOrder.length + 1}`);
        sheetOrder.push(id);
        sheetMap[id] = materializeSheet(id, sheet);
    }

    const stylesOut: Record<string, Record<string, unknown> | null> = {};
    for (const [styleId, value] of styles.entries()) {
        stylesOut[styleId] = (value ? toPlain(value) : null) as Record<string, unknown> | null;
    }

    return {
        id: asString(meta.get('id'), fallbackId),
        name: asString(meta.get('name'), '工作簿'),
        appVersion: asString(meta.get('appVersion'), SNAPSHOT_APP_VERSION),
        locale: (meta.get('locale') as string | undefined) ?? null,
        styles: stylesOut,
        sheetOrder,
        sheets: sheetMap,
        resources: [],
    };
}

function materializeSheet(id: string, sheet: Y.Map<unknown>): SnapshotWorksheet {
    const cellData = sheet.get('cellData') as Y.Map<unknown> | undefined;
    const rowData = sheet.get('rowData') as Y.Map<unknown> | undefined;
    const columnData = sheet.get('columnData') as Y.Map<unknown> | undefined;
    const mergeData = sheet.get('mergeData') as Y.Map<unknown> | undefined;
    const freeze = sheet.get('freeze') as Y.Map<unknown> | undefined;
    const rowHeader = sheet.get('rowHeader') as Y.Map<unknown> | undefined;
    const columnHeader = sheet.get('columnHeader') as Y.Map<unknown> | undefined;

    // 扁平 key → 二维稀疏矩阵
    const cells: Record<number, Record<number, SnapshotCellData>> = {};
    for (const [key, value] of cellData?.entries() ?? []) {
        const [row, col, field] = decodeCellKey(key);
        if (!Number.isFinite(row) || !Number.isFinite(col)) continue;
        const cell = ((cells[row] ??= {})[col] ??= {});
        setField(cell, field, value);
    }

    const rows: SnapshotWorksheet['rowData'] = {};
    for (const [key, value] of rowData?.entries() ?? []) {
        const sep = key.indexOf(':');
        const index = Number(key.slice(0, sep));
        const field = key.slice(sep + 1);
        const row = (rows[index] ??= {});
        setField(row, field, value);
    }

    const columns: SnapshotWorksheet['columnData'] = {};
    for (const [key, value] of columnData?.entries() ?? []) {
        const sep = key.indexOf(':');
        const index = Number(key.slice(0, sep));
        const field = key.slice(sep + 1);
        const col = (columns[index] ??= {});
        setField(col, field, value);
    }

    const merges: SnapshotRange[] = [];
    for (const value of mergeData?.values() ?? []) {
        const range = toPlain(value) as unknown as SnapshotRange;
        if (range && typeof range === 'object') merges.push(range);
    }
    // 稳定排序，保证同样的内容物化出同样的快照（否则 ETag 会一直变）
    merges.sort(
        (a, b) =>
            a.startRow - b.startRow ||
            a.startColumn - b.startColumn ||
            a.endRow - b.endRow ||
            a.endColumn - b.endColumn
    );

    return {
        id,
        name: asString(sheet.get('name'), id),
        tabColor: asString(sheet.get('tabColor'), ''),
        hidden: Number(sheet.get('hidden') ?? 0),
        rowCount: Number(sheet.get('rowCount') ?? 200),
        columnCount: Number(sheet.get('columnCount') ?? 26),
        zoomRatio: Number(sheet.get('zoomRatio') ?? 1),
        scrollTop: Number(sheet.get('scrollTop') ?? 0),
        scrollLeft: Number(sheet.get('scrollLeft') ?? 0),
        defaultRowHeight: Number(sheet.get('defaultRowHeight') ?? 24),
        defaultColumnWidth: Number(sheet.get('defaultColumnWidth') ?? 88),
        showGridlines: Number(sheet.get('showGridlines') ?? 1),
        gridlinesColor: (sheet.get('gridlinesColor') as string | null | undefined) ?? null,
        freeze: {
            xSplit: Number(freeze?.get('xSplit') ?? 0),
            ySplit: Number(freeze?.get('ySplit') ?? 0),
            startRow: Number(freeze?.get('startRow') ?? 0),
            startColumn: Number(freeze?.get('startColumn') ?? 0),
        },
        rowHeader: {
            width: Number(rowHeader?.get('width') ?? 46),
            hidden: Number(rowHeader?.get('hidden') ?? 0),
        },
        columnHeader: {
            height: Number(columnHeader?.get('height') ?? 24),
            hidden: Number(columnHeader?.get('hidden') ?? 0),
        },
        cellData: cells,
        rowData: rows,
        columnData: columns,
        mergeData: merges,
    };
}

/**
 * 取字符串配置项。
 *
 * Y.Map.get() 返回 unknown，直接 `String(x ?? fallback)` 在 x 是对象时
 * 会得到 "[object Object]"。这里显式只认 string。
 */
function asString(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
}

/** 把字段写进目标对象；未知字段原样带上（前端以后加字段，服务端不至于弄丢） */
function setField(target: object, field: string, value: unknown): void {
    (target as Record<string, unknown>)[field] = toPlain(value);
}

/**
 * 深度转纯 JSON。
 *
 * Y.Map / Y.Array 要递归摊平；普通值原样返回。
 * 这是「materialize 必须返回纯数据」那条规则的执行者。
 */
function toPlain(value: unknown): unknown {
    if (value instanceof Y.Map) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of value.entries()) out[k] = toPlain(v);
        return out;
    }
    if (value instanceof Y.Array) {
        return value.toArray().map(toPlain);
    }
    return value;
}

/**
 * 深拷贝 JSON 值。
 *
 * **不用 `structuredClone`**：Yjs 的 `typeMapSet` 靠 `value.constructor` 分发
 * （`case Object: ...`），而 `structuredClone` 在 jest 沙箱这类多 realm 环境里
 * 返回的是另一个 realm 的对象，`constructor` 对不上，Yjs 会抛
 * "Unexpected content type"。数据本身是 JSON，JSON 往返就够了。
 */
function cloneJson<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value)) as T;
}

// ─────────────────────────── 应用快照（回滚用） ───────────────────────────

/**
 * 用快照覆盖整个 Y.Doc —— 「回滚到某版本」走这里。
 *
 * 注意：这是**破坏性覆盖**，不是合并。回滚的语义就是「回到当时的样子」，
 * 之后再做的编辑不应该被合并回来（真要合并就不是回滚了）。
 */
export function applySnapshot(doc: Y.Doc, snapshot: SnapshotWorkbook): void {
    doc.transact(() => {
        const meta = doc.getMap(ROOT_META);
        meta.set('id', snapshot.id);
        meta.set('name', snapshot.name);
        meta.set('appVersion', snapshot.appVersion);
        if (snapshot.locale) meta.set('locale', snapshot.locale);

        // 清空重建 styles
        const styles = doc.getMap<unknown>(ROOT_STYLES);
        for (const key of styles.keys()) styles.delete(key);
        for (const [id, value] of Object.entries(snapshot.styles ?? {})) {
            if (value) styles.set(id, cloneJson(value));
        }

        // 清空重建 sheets
        const sheets = doc.getArray<Y.Map<unknown>>(ROOT_SHEETS);
        sheets.delete(0, sheets.length);
        const created: Y.Map<unknown>[] = [];

        for (const sheetId of snapshot.sheetOrder ?? []) {
            const raw = snapshot.sheets?.[sheetId];
            if (!raw) continue;
            created.push(buildSheet(sheetId, raw));
        }
        if (created.length > 0) sheets.push(created);
    });
}

function buildSheet(id: string, raw: SnapshotWorksheet): Y.Map<unknown> {
    const { sheet, cellData, rowData, columnData, mergeData } = createSheet(
        { id, name: raw.name ?? id },
        id
    );

    for (const field of [
        'name',
        'tabColor',
        'hidden',
        'rowCount',
        'columnCount',
        'zoomRatio',
        'scrollTop',
        'scrollLeft',
        'defaultRowHeight',
        'defaultColumnWidth',
        'showGridlines',
        'gridlinesColor',
    ] as const) {
        const value = raw[field];
        if (value !== undefined) sheet.set(field, value);
    }
    sheet.set('id', id);

    // 扁平回写：和 materialize 的摊平严格互逆
    for (const [rowKey, columns] of Object.entries(raw.cellData ?? {})) {
        for (const [colKey, cell] of Object.entries(columns ?? {})) {
            for (const field of Object.keys(cell ?? {})) {
                const value = (cell as Record<string, unknown>)[field];
                if (value === undefined || value === null) continue;
                cellData.set(
                    encodeCellKey(Number(rowKey), Number(colKey), field),
                    cloneJson(value)
                );
            }
        }
    }

    for (const [key, value] of Object.entries(raw.rowData ?? {})) {
        for (const [field, fieldValue] of Object.entries(value ?? {})) {
            if (fieldValue === undefined || fieldValue === null) continue;
            rowData.set(encodeIndexKey(Number(key), field), cloneJson(fieldValue));
        }
    }

    for (const [key, value] of Object.entries(raw.columnData ?? {})) {
        for (const [field, fieldValue] of Object.entries(value ?? {})) {
            if (fieldValue === undefined || fieldValue === null) continue;
            columnData.set(encodeIndexKey(Number(key), field), cloneJson(fieldValue));
        }
    }

    for (const range of raw.mergeData ?? []) {
        mergeData.set(
            `${range.startRow}:${range.startColumn}:${range.endRow}:${range.endColumn}`,
            { ...range }
        );
    }

    return sheet;
}

// ─────────────────────────── 统计 ───────────────────────────

/**
 * 快照里有多少个非空单元格 —— 存进 documents.cell_count，列表页展示用。
 *
 * 扁平 key 下不能直接数 key 个数（一个格子 5 个 key），必须去重。
 */
export function countCells(snapshot: SnapshotWorkbook): number {
    let total = 0;
    for (const sheet of Object.values(snapshot.sheets ?? {})) {
        for (const columns of Object.values(sheet.cellData ?? {})) {
            total += Object.keys(columns ?? {}).length;
        }
    }
    return total;
}

/** 供上层写入单元格字段时用，保证 key 格式一致 */
export function setCellField(
    doc: Y.Doc,
    sheetIndex: number,
    row: number,
    column: number,
    field: string,
    value: unknown
): void {
    const sheet = doc.getArray<Y.Map<unknown>>(ROOT_SHEETS).get(sheetIndex);
    const cellData = sheet?.get('cellData') as Y.Map<unknown> | undefined;
    cellData?.set(encodeCellKey(row, column, field), value);
}

export { CELL_FIELDS, ROW_FIELDS, COLUMN_FIELDS };
