/**
 * 工作表结构（增删 / 重命名）的协同同步。
 *
 * 回归点：`SheetBar` 的新建/删除/重命名只改本地引擎，
 * 如果协同层没有结构性钩子，其他协作者永远看不到这些表。
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/api/client', () => ({
    getAccessToken: () => 'test-token',
    refreshAccessToken: async () => 'test-token',
}));

import * as Y from 'yjs';
import { DocSync } from '../src/app/collab/doc-sync';
import { ROOT_SHEETS } from '../src/app/collab/doc-shape';
import {
    Workbook,
    Worksheet,
    type IEngineChangeHooks,
    type SheetEngine,
} from '../src/app/spreadsheet/engine';

class FakeEngine {
    readonly workbook: Workbook;
    readonly notifyExternalChange = vi.fn();
    readonly notifySheetMetaChange = vi.fn();
    hooks: IEngineChangeHooks | null = null;

    constructor() {
        const sheet = new Worksheet({ id: 'sheet1', name: 'Sheet1', rowCount: 100, columnCount: 20 });
        this.workbook = new Workbook({
            id: 'wb',
            name: '测试簿',
            appVersion: '1.0.0',
            sheetOrder: ['sheet1'],
            sheets: [sheet],
        });
    }

    attachChangeHooks(hooks: IEngineChangeHooks | null): void {
        this.hooks = hooks;
    }
}

function makeSync(): { sync: DocSync; structureChanges: () => number } {
    let calls = 0;
    const sync = new DocSync({
        documentId: 'doc1',
        token: 'token',
        user: { id: 'u1', username: 'u1', displayName: null },
        onStructureChange: () => {
            calls += 1;
        },
    });
    return { sync, structureChanges: () => calls };
}

describe('工作表结构协同', () => {
    it('本地新建 sheet 会写进 Y.Doc（含完整结构）', () => {
        const { sync } = makeSync();
        const engine = new FakeEngine();
        sync.attach(engine as unknown as SheetEngine);

        const sheet = new Worksheet({
            id: 'sheet2',
            name: '新建表',
            rowCount: 30,
            columnCount: 12,
        });
        engine.hooks!.onSheetAdd!(sheet, 1);

        const sheets = sync.doc.getArray<Y.Map<unknown>>(ROOT_SHEETS);
        expect(sheets.length).toBe(1);
        const created = sheets.get(0);
        expect(created.get('id')).toBe('sheet2');
        expect(created.get('name')).toBe('新建表');
        expect(created.get('rowCount')).toBe(30);
        expect(created.get('cellData')).toBeInstanceOf(Y.Map);

        // 物化后能直接喂给引擎
        expect(sync.materialize().sheetOrder).toEqual(['sheet2']);
        sync.destroy();
    });

    it('本地重命名会更新 Y.Doc 里的表名', () => {
        const { sync } = makeSync();
        const engine = new FakeEngine();
        sync.attach(engine as unknown as SheetEngine);

        engine.hooks!.onSheetAdd!(
            new Worksheet({ id: 'sheet2', name: '旧名', rowCount: 10, columnCount: 5 }),
            0
        );
        engine.hooks!.onSheetRename!('sheet2', '新名');

        const sheets = sync.doc.getArray<Y.Map<unknown>>(ROOT_SHEETS);
        expect(sheets.get(0).get('name')).toBe('新名');
        sync.destroy();
    });

    it('本地删除 sheet 会从 Y.Doc 移除', () => {
        const { sync } = makeSync();
        const engine = new FakeEngine();
        sync.attach(engine as unknown as SheetEngine);

        engine.hooks!.onSheetAdd!(
            new Worksheet({ id: 'sheet2', name: 'Sheet2', rowCount: 10, columnCount: 5 }),
            1
        );
        expect(sync.doc.getArray(ROOT_SHEETS).length).toBe(1);

        engine.hooks!.onSheetRemove!('sheet2');
        expect(sync.doc.getArray(ROOT_SHEETS).length).toBe(0);
        sync.destroy();
    });

    it('远端重命名 sheet 会更新本地引擎并刷新 UI', () => {
        const { sync } = makeSync();
        const engine = new FakeEngine(); // 本地已有 sheet1
        sync.attach(engine as unknown as SheetEngine);

        const remote = new Y.Doc();
        const remoteSheets = remote.getArray<Y.Map<unknown>>(ROOT_SHEETS);
        const remoteSheet = new Y.Map<unknown>();
        remoteSheet.set('id', 'sheet1');
        remoteSheet.set('name', 'Sheet1');
        remoteSheet.set('cellData', new Y.Map());
        remoteSheet.set('rowData', new Y.Map());
        remoteSheet.set('columnData', new Y.Map());
        remoteSheet.set('mergeData', new Y.Map());
        remoteSheets.push([remoteSheet]);

        // 先让本地建立 sheet 索引
        Y.applyUpdate(sync.doc, Y.encodeStateAsUpdate(remote), 'remote');
        engine.notifySheetMetaChange.mockClear();

        // 远端改名
        remoteSheet.set('name', '远端改名');
        Y.applyUpdate(sync.doc, Y.encodeStateAsUpdate(remote), 'remote');

        expect(engine.workbook.getSheet('sheet1')?.name).toBe('远端改名');
        expect(engine.notifySheetMetaChange).toHaveBeenCalled();
        sync.destroy();
    });

    it('远端增删 sheet 会触发结构重建回调', () => {
        const { sync, structureChanges } = makeSync();

        const remote = new Y.Doc();
        const remoteSheets = remote.getArray<Y.Map<unknown>>(ROOT_SHEETS);
        const sheet = new Y.Map<unknown>();
        sheet.set('id', 'remote1');
        sheet.set('name', '远端表');
        sheet.set('cellData', new Y.Map());
        sheet.set('rowData', new Y.Map());
        sheet.set('columnData', new Y.Map());
        sheet.set('mergeData', new Y.Map());
        remoteSheets.push([sheet]);

        Y.applyUpdate(sync.doc, Y.encodeStateAsUpdate(remote), 'remote');

        expect(sync.doc.getArray(ROOT_SHEETS).length).toBe(1);
        expect(structureChanges()).toBeGreaterThan(0);
        sync.destroy();
    });
});
