/**
 * 工具栏改样式的协同同步。
 *
 * 回归点：样式不是存在格子里，而是「共享样式表 + 单元格存 id」。
 * 如果只同步 `cell.s` 而不同步样式表，其他协作者拿到一个不存在的 id，
 * 表现就是「工具栏操作别人看不到」。
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/api/client', () => ({
    getAccessToken: () => 'test-token',
    refreshAccessToken: async () => 'test-token',
}));

import * as Y from 'yjs';
import { DocSync } from '../src/app/collab/doc-sync';
import { ROOT_STYLES } from '../src/app/collab/doc-shape';
import {
    Workbook,
    Worksheet,
    type IEngineChangeHooks,
    type SheetEngine,
} from '../src/app/spreadsheet/engine';

/** 只实现 DocSync 用到的那部分引擎接口（模型层不碰 canvas，可脱离 DOM 跑） */
class FakeEngine {
    readonly workbook: Workbook;
    readonly notifyExternalChange = vi.fn();

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

    attachChangeHooks(_hooks: IEngineChangeHooks | null): void {
        // 本用例不测单元格增量，无需实现
    }
}

function makeSync(): DocSync {
    return new DocSync({
        documentId: 'doc1',
        token: 'token',
        user: { id: 'u1', username: 'u1', displayName: null },
    });
}

describe('样式协同', () => {
    it('本地新样式会写进 Y.Doc 的共享样式表', () => {
        const sync = makeSync();
        const engine = new FakeEngine('sheet1');
        sync.attach(engine as unknown as SheetEngine);

        const id = engine.workbook.registerStyle({ bl: 1, cl: { rgb: '#ff0000' } });

        expect(sync.doc.getMap(ROOT_STYLES).get(id)).toEqual({
            bl: 1,
            cl: { rgb: '#ff0000' },
        });
        sync.destroy();
    });

    it('远端样式会补进本地 workbook 并触发重绘', () => {
        const sync = makeSync();
        const engine = new FakeEngine('sheet1');
        sync.attach(engine as unknown as SheetEngine);

        // 模拟另一个客户端写入样式并同步过来
        const remote = new Y.Doc();
        remote.getMap(ROOT_STYLES).set('sh-remote', { bl: 1, fs: 20 });
        Y.applyUpdate(sync.doc, Y.encodeStateAsUpdate(remote), 'remote');

        expect(engine.workbook.styles['sh-remote']).toEqual({ bl: 1, fs: 20 });
        expect(engine.notifyExternalChange).toHaveBeenCalled();
        sync.destroy();
    });

    it('样式 id 内容寻址：同内容同 id，嵌套字段不同则 id 不同', () => {
        const sync = makeSync();
        const engine = new FakeEngine('sheet1');

        const a = engine.workbook.registerStyle({ bl: 1, cl: { rgb: '#fff' } });
        const b = engine.workbook.registerStyle({ cl: { rgb: '#fff' }, bl: 1 });
        const c = engine.workbook.registerStyle({ bl: 1, cl: { rgb: '#000' } });

        // key 顺序不同但内容相同 → 同一 id
        expect(b).toBe(a);
        // 只差嵌套颜色 → 必须是不同 id（旧实现会把嵌套键过滤掉，误判为同一份）
        expect(c).not.toBe(a);
        sync.destroy();
    });
});
