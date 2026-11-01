/**
 * 侧面板状态机：注册顺序、活动视图回退、显隐控制、宽度持久化。
 */

import { describe, expect, it, vi } from 'vitest';
import { SidePanelStore } from '../src/shared/side-panel/store';
import type {
    SidePanelPrefs,
    SidePanelStorage,
    SidePanelView,
} from '../src/shared/side-panel/types';

function memoryStorage(initial: SidePanelPrefs | null = null) {
    let current = initial;
    const writes: Required<SidePanelPrefs>[] = [];
    const storage: SidePanelStorage = {
        read: () => current,
        write: (prefs) => {
            current = prefs;
            writes.push(prefs);
        },
    };
    return { storage, writes, current: () => current };
}

function makeView(id: string, extra: Partial<SidePanelView> = {}): SidePanelView {
    return {
        id,
        title: id,
        owner: { kind: 'host' },
        render: () => null,
        ...extra,
    };
}

describe('SidePanelStore', () => {
    it('按 order 排序；活动视图跟着第一次注册的走，默认关闭', () => {
        const store = new SidePanelStore({ storage: memoryStorage().storage });

        store.register(makeView('b', { order: 200 }));
        store.register(makeView('a', { order: 10 }));
        store.register(makeView('c'));

        const state = store.getSnapshot();
        expect(state.views.map((view) => view.id)).toEqual(['a', 'c', 'b']);
        // 后注册的视图不会抢走活动位，避免插件晚加载导致面板突然跳页
        expect(state.activeId).toBe('b');
        expect(state.open).toBe(false);
    });

    it('show / hide / toggle 控制显隐与活动视图', () => {
        const store = new SidePanelStore({ storage: memoryStorage().storage });
        store.register(makeView('a'));
        store.register(makeView('b'));

        store.show();
        expect(store.getSnapshot().open).toBe(true);
        expect(store.isVisible('a')).toBe(true);

        store.show('b');
        expect(store.getSnapshot().activeId).toBe('b');

        // 已经在这个视图上，再 toggle 就是收起
        store.toggle('b');
        expect(store.getSnapshot().open).toBe(false);

        store.toggle('b');
        expect(store.getSnapshot().open).toBe(true);
        expect(store.getSnapshot().activeId).toBe('b');

        store.hide();
        expect(store.getSnapshot().open).toBe(false);
        expect(store.isVisible('b')).toBe(false);
    });

    it('显示未注册的视图只告警，不影响开合', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const store = new SidePanelStore({ storage: memoryStorage().storage });
        store.register(makeView('a'));

        store.show('missing');

        expect(warn).toHaveBeenCalled();
        expect(store.getSnapshot().open).toBe(true);
        expect(store.getSnapshot().activeId).toBe('a');
        warn.mockRestore();
    });

    it('注销活动视图后退到第一个；全部注销后回到 null', () => {
        const store = new SidePanelStore({ storage: memoryStorage().storage });
        const a = store.register(makeView('a'));
        const b = store.register(makeView('b', { order: 200 }));
        store.show('b');

        b.dispose();
        expect(store.getSnapshot().views.map((view) => view.id)).toEqual(['a']);
        expect(store.getSnapshot().activeId).toBe('a');

        a.dispose();
        expect(store.getSnapshot().views).toEqual([]);
        expect(store.getSnapshot().activeId).toBeNull();
    });

    it('同 id 重复注册原地替换内容，活动视图不变', () => {
        const store = new SidePanelStore({ storage: memoryStorage().storage });
        store.register(makeView('panel', { pending: true }));
        store.show('panel');

        const mount = () => undefined;
        store.register(makeView('panel', { render: undefined, mount, title: '真实面板' }));

        const state = store.getSnapshot();
        expect(state.views).toHaveLength(1);
        expect(state.activeId).toBe('panel');
        expect(state.views[0].title).toBe('真实面板');
        expect(state.views[0].mount).toBe(mount);
        expect(state.views[0].pending).toBeUndefined();
    });

    it('onFirstShow 只在第一次显示时触发一次；换内容后可再次触发', () => {
        const first = vi.fn();
        const second = vi.fn();
        const store = new SidePanelStore({ storage: memoryStorage().storage });

        store.register(makeView('panel', { pending: true, onFirstShow: first }));
        store.show('panel');
        expect(first).toHaveBeenCalledTimes(1);

        store.hide();
        store.show('panel');
        expect(first).toHaveBeenCalledTimes(1);

        // manifest 占位 → 运行时面板：内容来源变了，允许重新触发
        store.register(
            makeView('panel', { render: undefined, mount: () => undefined, onFirstShow: second })
        );
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('onFirstShow 抛错不会打断面板', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const store = new SidePanelStore({ storage: memoryStorage().storage });
        store.register(
            makeView('panel', {
                onFirstShow: () => {
                    throw new Error('boom');
                },
            })
        );

        expect(() => store.show('panel')).not.toThrow();
        expect(store.getSnapshot().open).toBe(true);
        error.mockRestore();
    });

    it('宽度按上下限夹取，并在变更时落盘', () => {
        const memory = memoryStorage({ width: 100_000 });
        const store = new SidePanelStore({ storage: memory.storage });

        // 读到的超限值先夹到上限
        expect(store.getSnapshot().width).toBe(720);

        store.setWidth(10);
        expect(store.getSnapshot().width).toBe(220);

        store.setWidth(400);
        expect(store.getSnapshot().width).toBe(400);
        expect(memory.current()?.width).toBe(400);

        store.resetWidth();
        expect(store.getSnapshot().width).toBe(320);
    });

    it('恢复上次的开合与活动视图', () => {
        const store = new SidePanelStore({
            storage: memoryStorage({ open: true, activeId: 'b', width: 360 }).storage,
        });
        store.register(makeView('a'));
        store.register(makeView('b'));

        const state = store.getSnapshot();
        expect(state.open).toBe(true);
        expect(state.activeId).toBe('b');
        expect(state.width).toBe(360);
    });

    it('视图必须提供内容；pending 占位除外；render 与 mount 互斥', () => {
        const store = new SidePanelStore({ storage: memoryStorage().storage });

        expect(() => store.register(makeView('empty'))).not.toThrow();
        expect(() =>
            store.register({ ...makeView('none'), render: undefined })
        ).toThrow(/必须提供 render 或 mount/);

        // pending 占位可以没有任何内容
        expect(() =>
            store.register({ ...makeView('pending'), render: undefined, pending: true })
        ).not.toThrow();

        expect(() =>
            store.register({
                ...makeView('both'),
                mount: () => undefined,
            })
        ).toThrow(/只能二选一/);
    });
});
