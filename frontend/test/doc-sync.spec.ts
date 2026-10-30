/**
 * DocSync 双向桥的单元测试。
 *
 * 这是前端最核心也最容易改坏的一块，值得单独钉住：
 *   1. 本地改动 → 写进 Y.Doc 的**扁平 key**（不是嵌套 map）
 *   2. 字段级删除要跟着删（否则清空一个格子会把旧值永远留在 Y.Doc 里）
 *   3. 远端改动 → 落到引擎矩阵 + 通知刷新
 *   4. **不回声**：远端改动写进引擎后不能再产生新的本地 update
 *
 * 不需要连服务端：DocSync 的 connect() 是显式调用的，不调就只跑桥接逻辑。
 */

import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { DocSync } from '../src/app/collab/doc-sync';
import { encodeCellKey, ROOT_SHEETS } from '../src/app/collab/doc-shape';
import {
    Workbook,
    Worksheet,
    type ICellData,
    type IColumnData,
    type IRowData,
    type IWorkbookData,
    type IEngineChangeHooks,
} from '../src/app/spreadsheet/engine';

// ─────────────────────────── 测试替身 ───────────────────────────

/**
 * 只实现 DocSync 用到的那部分引擎接口。
 * 用真的 Workbook / Worksheet（模型层不碰 canvas，可以脱离 DOM 跑）。
 */
class FakeEngine {
    readonly workbook: Workbook;
    readonly notifyExternalChange = vi.fn();
    private hooks: IEngineChangeHooks | null = null;

    constructor(sheetId: string) {
        const sheet = new Worksheet({ id: sheetId, name: 'Sheet1', rowCount: 100, columnCount: 20 });
        this.workbook = new Workbook({
            id: 'wb',
            name: '测试簿',
            appVersion: '1.0.0',
            sheetOrder: [sheetId],
            sheets: [sheet],
        });
    }

    /** 和 SheetEngine.attachChangeHooks 一样：给三个矩阵挂回调 */
    attachChangeHooks(hooks: IEngineChangeHooks | null): void {
        this.hooks = hooks;
        for (const sheet of this.workbook.getSheets()) {
            const sheetId = sheet.id;
            sheet.cellData.onChange = hooks
                ? (row, column, next, before) =>
                      hooks.onCellChange(sheetId, row, column, next, before)
                : null;
            sheet.rowData.onChange = hooks
                ? (index, next, before) => hooks.onRowChange(sheetId, index, next, before)
                : null;
            sheet.columnData.onChange = hooks
                ? (index, next, before) => hooks.onColumnChange(sheetId, index, next, before)
                : null;
        }
    }

    get hasHooks(): boolean {
        return this.hooks !== null;
    }

    cell(sheetId: string, row: number, column: number): ICellData | undefined {
        return this.workbook.getSheet(sheetId)?.cellData.getValue(row, column);
    }

    writeCell(sheetId: string, row: number, column: number, value: ICellData): void {
        this.workbook.getSheet(sheetId)?.cellData.setValue(row, column, value);
    }

    deleteCell(sheetId: string, row: number, column: number): void {
        this.workbook.getSheet(sheetId)?.cellData.realDeleteValue(row, column);
    }

    writeRow(sheetId: string, index: number, value: IRowData): void {
        this.workbook.getSheet(sheetId)?.rowData.set(index, value);
    }

    writeColumn(sheetId: string, index: number, value: IColumnData): void {
        this.workbook.getSheet(sheetId)?.columnData.set(index, value);
    }
}

/** 造一张和后端结构一致的 sheet（扁平 key 的 cellData / rowData / columnData） */
function makeSheetMap(id: string): Y.Map<unknown> {
    const sheet = new Y.Map<unknown>();
    sheet.set('id', id);
    sheet.set('name', 'Sheet1');
    sheet.set('rowCount', 100);
    sheet.set('columnCount', 20);
    sheet.set('cellData', new Y.Map<unknown>());
    sheet.set('rowData', new Y.Map<unknown>());
    sheet.set('columnData', new Y.Map<unknown>());
    sheet.set('mergeData', new Y.Map<unknown>());
    return sheet;
}

const SHEET_ID = 'sheet1';

function makeSync(): DocSync {
    return new DocSync({
        documentId: 'doc-1',
        token: 'test-token',
        user: { id: 'u1', username: 'alice', displayName: 'Alice' },
    });
}

/**
 * 把一张表塞进 Y.Doc，模拟「服务端 syncStep2 推来的初始状态」。
 * origin 用 'remote' 才会触发 DocSync 的 indexSheets —— 这正是真实路径。
 */
function seedSheet(sync: DocSync): void {
    sync.doc.transact(() => {
        sync.doc.getArray<Y.Map<unknown>>(ROOT_SHEETS).push([makeSheetMap(SHEET_ID)]);
    }, 'remote');
}

/** Y.Doc 里某个格子的扁平 key 现状 */
function cellKeys(doc: Y.Doc): Record<string, unknown> {
    const map = (
        doc.getArray<Y.Map<unknown>>(ROOT_SHEETS).get(0).get('cellData') as Y.Map<unknown>
    );
    const out: Record<string, unknown> = {};
    for (const [key, value] of map.entries()) out[key] = value;
    return out;
}

// ─────────────────────────── 用例 ───────────────────────────

describe('DocSync 本地 → 远端', () => {
    it('把单元格写成扁平 key（row:col:field），不是嵌套 map', () => {
        const sync = makeSync();
        seedSheet(sync);
        const engine = new FakeEngine(SHEET_ID);
        sync.attach(engine);

        engine.writeCell(SHEET_ID, 3, 7, { v: 'hello', t: 1, s: 's1' });

        expect(cellKeys(sync.doc)).toEqual({
            [encodeCellKey(3, 7, 'v')]: 'hello',
            [encodeCellKey(3, 7, 't')]: 1,
            [encodeCellKey(3, 7, 's')]: 's1',
        });
    });

    it('清空格子时把旧字段从 Y.Doc 里删掉', () => {
        const sync = makeSync();
        seedSheet(sync);
        const engine = new FakeEngine(SHEET_ID);
        sync.attach(engine);

        engine.writeCell(SHEET_ID, 0, 0, { v: '旧值', t: 1 });
        expect(Object.keys(cellKeys(sync.doc))).toHaveLength(2);

        // 只留 v、去掉 t —— before 里的 t 必须被删掉
        engine.writeCell(SHEET_ID, 0, 0, { v: '新值' });
        expect(cellKeys(sync.doc)).toEqual({ [encodeCellKey(0, 0, 'v')]: '新值' });

        // 整格删除 → key 全清空
        engine.deleteCell(SHEET_ID, 0, 0);
        expect(cellKeys(sync.doc)).toEqual({});
    });

    it('null 字段也算删除（样式清空是写 null）', () => {
        const sync = makeSync();
        seedSheet(sync);
        const engine = new FakeEngine(SHEET_ID);
        sync.attach(engine);

        engine.writeCell(SHEET_ID, 1, 1, { v: 1, s: 's1' });
        engine.writeCell(SHEET_ID, 1, 1, { v: 1, s: null });

        expect(cellKeys(sync.doc)).toEqual({ [encodeCellKey(1, 1, 'v')]: 1 });
    });

    it('行高/列宽也走扁平 key', () => {
        const sync = makeSync();
        seedSheet(sync);
        const engine = new FakeEngine(SHEET_ID);
        sync.attach(engine);

        engine.writeRow(SHEET_ID, 5, { h: 40 });
        engine.writeColumn(SHEET_ID, 3, { w: 200 });

        const sheet = sync.doc.getArray<Y.Map<unknown>>(ROOT_SHEETS).get(0);
        expect((sheet.get('rowData') as Y.Map<unknown>).get('5:h')).toBe(40);
        expect((sheet.get('columnData') as Y.Map<unknown>).get('3:w')).toBe(200);
    });

    it('没接引擎（attach(null)）时本地改动不再同步出去', () => {
        const sync = makeSync();
        seedSheet(sync);
        const engine = new FakeEngine(SHEET_ID);
        sync.attach(engine);
        sync.detach();

        engine.writeCell(SHEET_ID, 0, 0, { v: 'x' });
        expect(cellKeys(sync.doc)).toEqual({});
    });
});

describe('DocSync 远端 → 本地', () => {
    it('远端改动落到引擎矩阵并触发刷新', () => {
        const sync = makeSync();
        seedSheet(sync);
        const engine = new FakeEngine(SHEET_ID);
        sync.attach(engine);

        // 模拟收到一条远端 update：origin 必须是 'remote'
        sync.doc.transact(() => {
            const map = sync.doc
                .getArray<Y.Map<unknown>>(ROOT_SHEETS)
                .get(0)
                .get('cellData') as Y.Map<unknown>;
            map.set(encodeCellKey(2, 2, 'v'), 'from-peer');
            map.set(encodeCellKey(2, 2, 't'), 1);
        }, 'remote');

        expect(engine.cell(SHEET_ID, 2, 2)).toEqual({ v: 'from-peer', t: 1 });
        expect(engine.notifyExternalChange).toHaveBeenCalled();
    });

    it('不回声：远端改动写进引擎后不产生新的本地 update', () => {
        const sync = makeSync();
        seedSheet(sync);
        const engine = new FakeEngine(SHEET_ID);
        sync.attach(engine);

        // 数 Y.Doc 收到的「本地」写入次数
        const localWrites: number[] = [];
        sync.doc.on('update', (_update: Uint8Array, origin: unknown) => {
            localWrites.push(origin === 'remote' ? 0 : 1);
        });

        sync.doc.transact(() => {
            const map = sync.doc
                .getArray<Y.Map<unknown>>(ROOT_SHEETS)
                .get(0)
                .get('cellData') as Y.Map<unknown>;
            map.set(encodeCellKey(0, 0, 'v'), 'remote-value');
        }, 'remote');

        // 远端那条算 1 次 update，回声会带来额外的本地 update
        expect(localWrites.filter((n) => n === 1)).toHaveLength(0);
    });

    it('远端删除字段时，引擎里的字段也跟着没了', () => {
        const sync = makeSync();
        seedSheet(sync);
        const engine = new FakeEngine(SHEET_ID);
        sync.attach(engine);

        engine.writeCell(SHEET_ID, 4, 4, { v: 'x', t: 1 });

        sync.doc.transact(() => {
            const map = sync.doc
                .getArray<Y.Map<unknown>>(ROOT_SHEETS)
                .get(0)
                .get('cellData') as Y.Map<unknown>;
            map.delete(encodeCellKey(4, 4, 't'));
        }, 'remote');

        expect(engine.cell(SHEET_ID, 4, 4)).toEqual({ v: 'x' });
    });

    it('远端删掉最后一个字段时整格从引擎里消失', () => {
        const sync = makeSync();
        seedSheet(sync);
        const engine = new FakeEngine(SHEET_ID);
        sync.attach(engine);

        sync.doc.transact(() => {
            const map = sync.doc
                .getArray<Y.Map<unknown>>(ROOT_SHEETS)
                .get(0)
                .get('cellData') as Y.Map<unknown>;
            map.set(encodeCellKey(9, 9, 'v'), 'only');
        }, 'remote');
        expect(engine.cell(SHEET_ID, 9, 9)).toEqual({ v: 'only' });

        sync.doc.transact(() => {
            const map = sync.doc
                .getArray<Y.Map<unknown>>(ROOT_SHEETS)
                .get(0)
                .get('cellData') as Y.Map<unknown>;
            map.delete(encodeCellKey(9, 9, 'v'));
        }, 'remote');

        expect(engine.cell(SHEET_ID, 9, 9)).toBeUndefined();
    });
});

describe('CRDT 合并语义', () => {
    it('两个客户端同时新建同一格的不同字段都保留', () => {
        // 这条是「嵌套 Y.Map 会丢数据、扁平 key 不会」的回归用例
        const sync = makeSync();
        seedSheet(sync);
        const engine = new FakeEngine(SHEET_ID);
        sync.attach(engine);

        // 对端从同一份初始状态分叉出去
        const peer = new Y.Doc();
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(sync.doc));

        // 本地写值
        engine.writeCell(SHEET_ID, 0, 0, { v: 'A写的值' });
        // 对端同时写样式（同一个格子，不同字段）
        peer.transact(() => {
            const map = peer.getArray<Y.Map<unknown>>(ROOT_SHEETS).get(0).get('cellData') as Y.Map<
                unknown
            >;
            map.set(encodeCellKey(0, 0, 's'), 'style-from-peer');
        }, 'remote');

        // 合并：两边的改动都要在
        const merged = new Y.Doc();
        Y.applyUpdate(merged, Y.encodeStateAsUpdate(peer));
        Y.applyUpdate(merged, Y.encodeStateAsUpdate(sync.doc));

        const map = merged.getArray<Y.Map<unknown>>(ROOT_SHEETS).get(0).get('cellData') as Y.Map<
            unknown
        >;
        expect(map.get(encodeCellKey(0, 0, 'v'))).toBe('A写的值');
        expect(map.get(encodeCellKey(0, 0, 's'))).toBe('style-from-peer');
    });
});

describe('materialize', () => {
    it('产出引擎能吃的 IWorkbookData，且是纯 JSON', () => {
        const sync = makeSync();
        seedSheet(sync);
        const engine = new FakeEngine(SHEET_ID);
        sync.attach(engine);

        engine.writeCell(SHEET_ID, 0, 0, { v: '商品', t: 1, s: 's1' });
        engine.writeCell(SHEET_ID, 1, 1, { v: 1280.5, t: 2, f: '=SUM(B2:B2)' });

        const snapshot = sync.materialize() as IWorkbookData;

        expect(snapshot.sheetOrder).toEqual([SHEET_ID]);
        const sheet = snapshot.sheets[SHEET_ID];
        expect(sheet.cellData[0][0]).toEqual({ v: '商品', t: 1, s: 's1' });
        // 公式要原样保留
        expect(sheet.cellData[1][1].f).toBe('=SUM(B2:B2)');

        // 不能夹带 Y 类型，否则 JSON.stringify 会吐出 Yjs 内部结构
        const round = JSON.parse(JSON.stringify(snapshot)) as IWorkbookData;
        expect(round).toEqual(snapshot);
    });
});
