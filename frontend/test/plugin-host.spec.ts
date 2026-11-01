/**
 * 插件宿主端到端（不开浏览器）。
 *
 * 用一个真实的 Workbook/Worksheet + 最小 FakeEngine：
 *   - 索引里只有 manifest 时工具栏按钮就能出现（插件未执行）
 *   - 命中 onDocumentOpen:sheet 后激活，命令通过 documents.active() 读写
 *   - 写入进入 History，一次 transact = 一次撤销
 *
 * 插件模块用 data: URL 动态 import，避免测试依赖真实 dev server。
 */

import { describe, expect, it } from 'vitest';
import { PluginHost } from '../src/app/plugins/host/plugin-host';
import type { DiscoveredPlugin } from '../src/app/plugins/host/plugin-registry';
import { SidePanelStore } from '../src/shared/side-panel/store';
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
        const sheet = new Worksheet({
            id: 'sheet1',
            name: 'Sheet1',
            rowCount: 100,
            columnCount: 20,
        });
        this.workbook = new Workbook({
            id: 'wb',
            name: '测试簿',
            appVersion: '1.0.0',
            sheetOrder: [sheet.id],
            sheets: [sheet],
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

const PLUGIN_ID = 'com.test.host-demo';
const moduleSource = `
export async function activate(ctx) {
    ctx.ui.registerToolbarItem({
        id: 'run',
        slot: 'sheet.toolbar.end',
        title: '运行时按钮',
        command: 'demo.run'
    });

    ctx.subscriptions.push(ctx.commands.register('demo.run', async () => {
        const doc = ctx.documents.active();
        if (!doc) throw new Error('no active document');

        const before = await doc.getRangeValues({
            startRow: 0, startColumn: 0, endRow: 0, endColumn: 0
        });

        await doc.transact('测试写入', (tx) => {
            tx.setRangeValues(
                { startRow: 0, startColumn: 0, endRow: 1, endColumn: 1 },
                [[1, 'hello'], [true, null]]
            );
        });

        const after = await doc.getRangeValues({
            startRow: 0, startColumn: 0, endRow: 1, endColumn: 1
        });
        globalThis.__pluginTestResult = { before, after, title: doc.title, canWrite: doc.canWrite };
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
        commands: [{ id: 'demo.run', title: '运行示例' }],
        toolbar: [
            { slot: 'sheet.toolbar.end', command: 'demo.run', title: '示例按钮' },
        ],
    },
    permissions: ['document:read', 'document:write'],
    settings: {},
    source: 'dev',
};

describe('插件宿主', () => {
    it('manifest 先渲染入口，激活后可读写文档并整体撤销', async () => {
        const engine = new FakeEngine();
        const host = new PluginHost({
            userId: 'user-1',
            loadPlugins: async () => [plugin],
        });

        try {
            await host.initialize();

            // 未激活时 manifest 贡献已经可见（点击时才加载代码）
            expect(host.ui.toolbarItems('sheet.toolbar.end').map((item) => item.title)).toEqual([
                '示例按钮',
            ]);

            host.attachDocument({
                id: 'doc-1',
                engine: engine as unknown as SheetEngine,
                getTitle: () => '测试文档',
                canWrite: () => true,
            });

            expect(await host.ensureActivated(PLUGIN_ID)).toBe(true);
            expect(host.ui.toolbarItems('sheet.toolbar.end').map((item) => item.title)).toEqual([
                '示例按钮',
                '运行时按钮',
            ]);

            await host.executeCommand(PLUGIN_ID, 'demo.run');

            const result = (
                globalThis as typeof globalThis & {
                    __pluginTestResult?: {
                        before: unknown;
                        after: unknown;
                        title: string;
                        canWrite: boolean;
                    };
                }
            ).__pluginTestResult;

            expect(result?.title).toBe('测试文档');
            expect(result?.canWrite).toBe(true);
            expect(result?.before).toBeDefined();
            expect(result?.after).toBeDefined();

            const sheet = engine.workbook.getActiveSheet();
            expect(sheet?.getCell(0, 0)?.v).toBe(1);
            expect(sheet?.getCell(0, 1)?.v).toBe('hello');
            expect(sheet?.getCell(1, 0)?.v).toBe(true);
            // null 是真删除，不是写入空串
            expect(sheet?.getCell(1, 1)).toBeUndefined();

            engine.history.undo();
            expect(engine.workbook.getActiveSheet()?.getCell(0, 0)).toBeUndefined();
            expect(engine.workbook.getActiveSheet()?.getCell(0, 1)).toBeUndefined();
        } finally {
            host.dispose();
            delete (globalThis as typeof globalThis & { __pluginTestResult?: unknown })
                .__pluginTestResult;
        }
    });
});

/** 侧面板：manifest 占位 → 用户打开 → 懒激活 → 运行时面板替换 */
const PANEL_PLUGIN_ID = 'com.test.panel-demo';
const panelModuleSource = `
export async function activate(ctx) {
    ctx.ui.registerPanel({
        id: 'demo.panel',
        title: '运行时面板',
        slot: 'editor.sidebar',
        mount(container) {
            container.textContent = 'panel-mounted';
            return () => container.replaceChildren();
        }
    });
    globalThis.__pluginPanelVisible = ctx.ui.isPanelVisible('demo.panel');
}
`;

const panelPlugin: DiscoveredPlugin = {
    id: PANEL_PLUGIN_ID,
    version: '1.0.0',
    baseUrl: '/',
    entry: `data:text/javascript;charset=utf-8,${encodeURIComponent(panelModuleSource)}`,
    engines: { pgclouddoc: '>=1.0.0 <2.0.0', pluginApi: '1' },
    activationEvents: ['onView:demo.panel'],
    contributes: {
        panels: [{ id: 'demo.panel', title: '示例面板', slot: 'editor.sidebar' }],
    },
    permissions: [],
    settings: {},
    source: 'dev',
};

function memoryStorage() {
    let prefs: import('../src/shared/side-panel/types').SidePanelPrefs | null = null;
    return {
        read: () => prefs,
        write: (next: import('../src/shared/side-panel/types').SidePanelPrefs) => {
            prefs = next;
        },
    };
}

describe('插件侧面板', () => {
    it('manifest 先占位，打开时激活插件并替换成真实面板', async () => {
        const sidePanel = new SidePanelStore({ storage: memoryStorage() });
        const host = new PluginHost({
            userId: 'user-1',
            loadPlugins: async () => [panelPlugin],
            sidePanel,
        });

        try {
            await host.initialize();

            const viewId = `${PANEL_PLUGIN_ID}:demo.panel`;
            const placeholder = sidePanel.getSnapshot().views.find((view) => view.id === viewId);
            // 插件代码没执行，活动栏里已经有入口
            expect(placeholder?.title).toBe('示例面板');
            expect(placeholder?.pending).toBe(true);
            expect(placeholder?.owner).toEqual({ kind: 'plugin', pluginId: PANEL_PLUGIN_ID });

            // 打开面板 = 触发 onView 懒激活
            sidePanel.show(viewId);
            expect(await host.ensureActivated(PANEL_PLUGIN_ID)).toBe(true);

            const view = sidePanel.getSnapshot().views.find((item) => item.id === viewId);
            expect(view?.title).toBe('运行时面板');
            expect(view?.pending).toBeUndefined();
            expect(typeof view?.mount).toBe('function');
            expect(sidePanel.isVisible(viewId)).toBe(true);

            // 插件侧的 isPanelVisible 走的是同一条状态
            expect(
                (globalThis as typeof globalThis & { __pluginPanelVisible?: boolean })
                    .__pluginPanelVisible
            ).toBe(true);

            // Node 环境没有真实 DOM，验证的是挂载函数被调用、内容写进了容器
            const container = {
                textContent: '',
                replaceChildren: () => undefined,
            } as unknown as HTMLElement;
            view?.mount?.(container);
            expect(container.textContent).toBe('panel-mounted');
        } finally {
            host.dispose();
            delete (globalThis as typeof globalThis & { __pluginPanelVisible?: boolean })
                .__pluginPanelVisible;
        }
    });

    it('插件停用后面板从活动栏移除', async () => {
        const sidePanel = new SidePanelStore({ storage: memoryStorage() });
        const host = new PluginHost({
            userId: 'user-1',
            loadPlugins: async () => [panelPlugin],
            sidePanel,
        });

        await host.initialize();
        const viewId = `${PANEL_PLUGIN_ID}:demo.panel`;
        expect(sidePanel.getSnapshot().views.map((view) => view.id)).toEqual([viewId]);

        host.dispose();

        expect(sidePanel.getSnapshot().views).toEqual([]);
        expect(sidePanel.getSnapshot().activeId).toBeNull();
    });
});
