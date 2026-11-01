/**
 * 工作表作用域 API：跨表读、表元信息、跨表事务。
 *
 * 核心断言：读取/写入非活动表时，用户的当前表与选区都不能变。
 */

import { describe, expect, it } from 'vitest';
import { PluginHost } from '../src/app/plugins/host/plugin-host';
import type { DiscoveredPlugin } from '../src/app/plugins/host/plugin-registry';
import {
    History,
    Workbook,
    Worksheet,
    saveWorkbook,
    singleSelection,
    type EngineEvent,
    type IEdit,
    type ISelection,
    type IWorkbookData,
    type SheetEngine,
} from '../src/app/spreadsheet/engine';

class FakeEngine {
    readonly workbook: Workbook;
    readonly history: History;
    isReadOnly = false;

    private selection: ISelection = singleSelection(0, 0);
    private readonly listeners = new Map<EngineEvent, Set<() => void>>();

    constructor() {
        const sheet1 = new Worksheet({
            id: 'sheet1',
            name: 'Sheet1',
            rowCount: 100,
            columnCount: 20,
        });
        const sheet2 = new Worksheet({
            id: 'sheet2',
            name: 'Sheet2',
            rowCount: 50,
            columnCount: 10,
        });
        sheet2.cellData.setValue(0, 0, { v: 'alice' });
        sheet2.cellData.setValue(0, 1, { v: 42 });

        this.workbook = new Workbook({
            id: 'wb',
            name: '测试簿',
            appVersion: '1.0.0',
            sheetOrder: [sheet1.id, sheet2.id],
            sheets: [sheet1, sheet2],
        });
        this.history = new History(100, () => {
            this.emit('history-change');
            this.emit('content-change');
        });
    }

    on(event: EngineEvent, handler: () => void): () => void {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(handler);
        return () => {
            set?.delete(handler);
        };
    }

    execute(edit: IEdit): void {
        this.history.push(edit);
    }

    getSelection(): ISelection {
        return this.selection;
    }

    setSelection(selection: ISelection): void {
        this.selection = selection;
        this.emit('selection-change');
    }

    getSheets() {
        return this.workbook.getSheets().map((sheet) => ({
            id: sheet.id,
            name: sheet.name,
            tabColor: sheet.tabColor,
            hidden: sheet.hidden === 1,
        }));
    }

    toJSON(): IWorkbookData {
        return saveWorkbook(this.workbook);
    }

    private emit(event: EngineEvent): void {
        for (const handler of [...(this.listeners.get(event) ?? [])]) handler();
    }
}

const PLUGIN_ID = 'com.test.sheet-scope';
const moduleSource = `
export async function activate(ctx) {
    ctx.subscriptions.push(ctx.commands.register('scope.run', async () => {
        const doc = ctx.documents.active();
        if (!doc) throw new Error('no active document');

        const info = doc.getSheetInfo();
        const activeBefore = doc.getActiveSheetId();
        const sheet2 = info.find((sheet) => sheet.name === 'Sheet2');
        if (!sheet2) throw new Error('Sheet2 不存在');

        const rows = await doc.getRangeValuesInSheet(sheet2.id, {
            startRow: 0, startColumn: 0, endRow: 0, endColumn: 1
        });
        const activeAfterRead = doc.getActiveSheetId();

        await doc.transactInSheet(sheet2.id, '跨表写入', (tx) => {
            tx.setRangeValues(
                { startRow: 1, startColumn: 0, endRow: 1, endColumn: 0 },
                [['written']]
            );
        });

        const written = await doc.getRangeValuesInSheet(sheet2.id, {
            startRow: 1, startColumn: 0, endRow: 1, endColumn: 0
        });
        const activeAfterWrite = doc.getActiveSheetId();

        let unknownSheetError = null;
        try {
            await doc.getRangeValuesInSheet('missing', {
                startRow: 0, startColumn: 0, endRow: 0, endColumn: 0
            });
        } catch (err) {
            unknownSheetError = err && err.code;
        }

        globalThis.__sheetScopeResult = {
            info, activeBefore, rows, activeAfterRead, written, activeAfterWrite, unknownSheetError
        };
    }));
}
`;

const plugin: DiscoveredPlugin = {
    id: PLUGIN_ID,
    version: '1.0.0',
    baseUrl: '/',
    entry: `data:text/javascript;charset=utf-8,${encodeURIComponent(moduleSource)}`,
    engines: { pgclouddoc: '>=1.0.0 <2.0.0', pluginApi: '1' },
    activationEvents: ['onDocumentOpen:sheet'],
    contributes: {
        commands: [{ id: 'scope.run', title: '跨表测试' }],
    },
    permissions: ['document:read', 'document:write'],
    settings: {},
    source: 'dev',
};

interface SheetScopeResult {
    info: Array<{
        id: string;
        name: string;
        hidden: boolean;
        rowCount: number;
        columnCount: number;
        usedRange: { startRow: number; startColumn: number; endRow: number; endColumn: number } | null;
    }>;
    activeBefore: string;
    rows: Array<Array<{ value: unknown; displayText: string }>>;
    activeAfterRead: string;
    written: Array<Array<{ value: unknown; displayText: string }>>;
    activeAfterWrite: string;
    unknownSheetError: string | null;
}

describe('工作表作用域文档 API', () => {
    it('跨表读写不改变活动表与选区，且写入可一次撤销', async () => {
        const engine = new FakeEngine();
        const selectionBefore = engine.getSelection();
        const host = new PluginHost({
            userId: 'user-1',
            loadPlugins: async () => [plugin],
        });

        try {
            await host.initialize();
            host.attachDocument({
                id: 'doc-1',
                engine: engine as unknown as SheetEngine,
                getTitle: () => '测试文档',
                canWrite: () => true,
            });

            expect(await host.ensureActivated(PLUGIN_ID)).toBe(true);
            await host.executeCommand(PLUGIN_ID, 'scope.run');

            const result = (globalThis as typeof globalThis & {
                __sheetScopeResult?: SheetScopeResult;
            }).__sheetScopeResult;

            expect(result).toBeDefined();

            // 元信息
            expect(result?.info.map((sheet) => sheet.name)).toEqual(['Sheet1', 'Sheet2']);
            const sheet2Info = result?.info.find((sheet) => sheet.name === 'Sheet2');
            expect(sheet2Info?.rowCount).toBe(50);
            expect(sheet2Info?.columnCount).toBe(10);
            expect(sheet2Info?.usedRange).toEqual({
                startRow: 0,
                startColumn: 0,
                endRow: 0,
                endColumn: 1,
            });
            expect(result?.info.find((sheet) => sheet.name === 'Sheet1')?.usedRange).toBeNull();

            // 跨表读
            expect(result?.rows[0]?.[0]?.value).toBe('alice');
            expect(result?.rows[0]?.[1]?.value).toBe(42);

            // 活动表与选区全程不变
            expect(result?.activeBefore).toBe('sheet1');
            expect(result?.activeAfterRead).toBe('sheet1');
            expect(result?.activeAfterWrite).toBe('sheet1');
            expect(engine.workbook.activeSheetId).toBe('sheet1');
            expect(engine.getSelection()).toEqual(selectionBefore);

            // 跨表写落到了目标表
            expect(result?.written[0]?.[0]?.value).toBe('written');
            expect(engine.workbook.getSheet('sheet2')?.getCell(1, 0)?.v).toBe('written');
            expect(engine.workbook.getSheet('sheet1')?.getCell(1, 0)).toBeUndefined();

            // 一次事务 = 一次撤销
            engine.history.undo();
            expect(engine.workbook.getSheet('sheet2')?.getCell(1, 0)).toBeUndefined();

            expect(result?.unknownSheetError).toBe('E_PLUGIN_INVALID_RANGE');
        } finally {
            host.dispose();
            delete (globalThis as typeof globalThis & { __sheetScopeResult?: unknown })
                .__sheetScopeResult;
        }
    });
});
