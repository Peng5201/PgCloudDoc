/**
 * 后台休眠：页面切到后台超过 10s 主动断开 WebSocket，回到前台立即重连。
 *
 * 钉住三个行为：
 *   1. 后台不足阈值不断，超过阈值才断
 *   2. 主动断开后不能再走「指数退避重连」（后台不该继续锤服务端）
 *   3. 回前台立刻建连、不走退避，并且 Y.Doc 还是同一个实例（页面数据不动）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/api/client', () => ({
    getAccessToken: () => 'test-token',
    refreshAccessToken: async () => 'test-token',
}));

import { DocSync } from '../src/app/collab/doc-sync';

// ─────────────────────────── 测试替身 ───────────────────────────

class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    static instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.CONNECTING;
    binaryType = '';
    closed = false;
    closeCode: number | undefined;

    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
    }

    open(): void {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }

    send(): void {
        // 测试里不关心发出的帧内容
    }

    close(code?: number): void {
        this.readyState = FakeWebSocket.CLOSED;
        this.closed = true;
        this.closeCode = code;
        this.onclose?.({ code: code ?? 1000 });
    }
}

/** 可控的 visibilityState */
let hidden = false;
const visibilityListeners = new Set<() => void>();

/** window 上的交互兜底监听（pointermove / keydown …） */
const wakeListeners = new Map<string, Set<() => void>>();

function setHidden(next: boolean): void {
    hidden = next;
    for (const listener of [...visibilityListeners]) listener();
}

function fireWake(type: string): void {
    for (const listener of [...(wakeListeners.get(type) ?? [])]) listener();
}

function makeSync(): DocSync {
    return new DocSync({
        documentId: 'doc-1',
        token: 'test-token',
        user: { id: 'u1', username: 'alice', displayName: 'Alice' },
    });
}

function currentStatus(sync: DocSync): string {
    let status = '';
    const off = sync.onStatus((next) => {
        status = next.status;
    });
    off();
    return status;
}

// ─────────────────────────── 用例 ───────────────────────────

describe('切后台自动断开协同连接', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        FakeWebSocket.instances = [];
        hidden = false;
        visibilityListeners.clear();
        wakeListeners.clear();

        vi.stubGlobal('WebSocket', FakeWebSocket);
        vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' });
        vi.stubGlobal('document', {
            get visibilityState() {
                return hidden ? 'hidden' : 'visible';
            },
            addEventListener: (type: string, listener: () => void) => {
                if (type === 'visibilitychange') visibilityListeners.add(listener);
            },
            removeEventListener: (type: string, listener: () => void) => {
                if (type === 'visibilitychange') visibilityListeners.delete(listener);
            },
        });
        vi.stubGlobal('window', {
            addEventListener: (type: string, listener: () => void) => {
                let set = wakeListeners.get(type);
                if (!set) {
                    set = new Set();
                    wakeListeners.set(type, set);
                }
                set.add(listener);
            },
            removeEventListener: (type: string, listener: () => void) => {
                wakeListeners.get(type)?.delete(listener);
            },
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('后台不足 10s 不断开', () => {
        const sync = makeSync();
        sync.connect();
        const ws = FakeWebSocket.instances[0];
        ws.open();

        setHidden(true);
        vi.advanceTimersByTime(9_999);
        expect(ws.closed).toBe(false);

        // 回到前台：计时器作废，连接保持原样
        setHidden(false);
        vi.advanceTimersByTime(60_000);
        expect(ws.closed).toBe(false);
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(currentStatus(sync)).toBe('connected');
    });

    it('后台满 10s 主动断开，且不再排退避重连', () => {
        const sync = makeSync();
        sync.connect();
        const ws = FakeWebSocket.instances[0];
        ws.open();

        setHidden(true);
        vi.advanceTimersByTime(10_000);

        expect(ws.closed).toBe(true);
        expect(ws.closeCode).toBe(1000);
        expect(currentStatus(sync)).toBe('disconnected');

        // 后台里等很久也不能自己重连
        vi.advanceTimersByTime(60_000);
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('回到前台立即重连（不等退避），Y.Doc 和数据都不重建', () => {
        const sync = makeSync();
        sync.connect();
        FakeWebSocket.instances[0].open();

        const docBefore = sync.doc;

        setHidden(true);
        vi.advanceTimersByTime(10_000);
        expect(FakeWebSocket.instances).toHaveLength(1);

        setHidden(false);
        // 不需要推进任何计时器：同步建连
        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(FakeWebSocket.instances[1].url).toContain('/collab/doc-1');
        expect(currentStatus(sync)).toBe('connecting');

        FakeWebSocket.instances[1].open();
        expect(currentStatus(sync)).toBe('connected');

        // 传输层重连，文档对象没换 —— 页面不会因为重连而重建数据
        expect(sync.doc).toBe(docBefore);
    });

    it('销毁时摘掉可见性监听，不再响应', () => {
        const sync = makeSync();
        sync.connect();
        FakeWebSocket.instances[0].open();

        sync.destroy();
        expect(visibilityListeners.size).toBe(0);
        for (const set of wakeListeners.values()) expect(set.size).toBe(0);

        setHidden(true);
        vi.advanceTimersByTime(60_000);
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('visibilitychange 迟到时，第一次交互（鼠标移动）也能立即重连', () => {
        const sync = makeSync();
        sync.connect();
        FakeWebSocket.instances[0].open();

        setHidden(true);
        vi.advanceTimersByTime(10_000);
        expect(FakeWebSocket.instances).toHaveLength(1);

        // 注意：这里**不**派发 visibilitychange，模拟浏览器把可见性更新
        // 压到用户输入才触发的情况 —— 鼠标一动就应该重连
        fireWake('pointermove');

        expect(FakeWebSocket.instances).toHaveLength(2);
        FakeWebSocket.instances[1].open();
        expect(currentStatus(sync)).toBe('connected');
    });
});
