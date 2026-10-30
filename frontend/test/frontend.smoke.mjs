/**
 * 前端接入的集成冒烟 —— 打 **vite 开发服务器**（不是直连后端）。
 *
 * 走 5173 是有意的：这样 `/api` 的 HTTP 代理、`/collab` 的 WebSocket 代理、
 * httpOnly cookie 的传递全都一起验到了 —— 这些正是浏览器真正走的路径，
 * 直连 3000 反而测不到代理配错这类问题。
 *
 * 前置：后端 + 前端 dev server 都在跑
 *   node test/frontend.smoke.mjs
 */

import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const HTTP_BASE = process.env.HTTP_BASE ?? 'http://localhost:5173';
const WS_BASE = process.env.WS_BASE ?? 'ws://localhost:5173';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const LOCAL = Symbol('smoke:local');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
    if (condition) {
        passed++;
        console.log(`  ✅ ${name}`);
    } else {
        failed++;
        failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
        console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

function section(title) {
    console.log(`\n${title}`);
}

async function api(path, { token, cookie, ...init } = {}) {
    const headers = { ...init.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = cookie;
    if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${HTTP_BASE}${path}`, {
        ...init,
        headers,
        credentials: 'include',
    });
    const text = await res.text();
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }
    return { status: res.status, headers: res.headers, body, text };
}

function pickCookie(response, name) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const cookie of raw) {
        const [pair] = cookie.split(';');
        const [key, ...rest] = pair.trim().split('=');
        if (key === name) return `${name}=${rest.join('=')}`;
    }
    return '';
}

/** 一个协同客户端，跟前端 doc-sync.ts 走同一套协议 */
class CollabClient {
    constructor(name, doc) {
        this.name = name;
        this.doc = doc;
        this.REMOTE = Symbol(`remote-${name}`);
    }

    connect(documentId, token, timeoutMs = 8000) {
        return new Promise((resolve, reject) => {
            // 没有超时的话，代理配错（比如 vite 没开 ws:true）会让这里永久挂住，
            // 冒烟脚本就变成「看起来在跑其实卡死」
            const timer = setTimeout(() => {
                this.ws?.terminate();
                reject(new Error(`WS 连接超时（${timeoutMs}ms）——检查 /collab 代理是否开了 ws: true`));
            }, timeoutMs);

            this.ws = new WebSocket(
                `${WS_BASE}/collab/${documentId}?access_token=${encodeURIComponent(token)}`,
                { perMessageDeflate: false }
            );
            this.ws.binaryType = 'nodebuffer';
            this.ws.on('open', () => {
                clearTimeout(timer);
                resolve();
            });
            this.ws.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
            this.ws.on('message', (data) => this.onMessage(Buffer.from(data)));
            this.ws.on('close', (code, reason) => {
                this.closeCode = code;
                this.closeReason = reason?.toString();
            });

            this.doc.on('update', (update, origin) => {
                if (origin === this.REMOTE) return;
                const encoder = encoding.createEncoder();
                encoding.writeVarUint(encoder, MESSAGE_SYNC);
                syncProtocol.writeUpdate(encoder, update);
                if (this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.send(encoding.toUint8Array(encoder), { binary: true });
                }
            });
        });
    }

    onMessage(data) {
        const type = data[0];
        const payload = new Uint8Array(data.subarray(1));
        if (type === MESSAGE_SYNC) {
            const decoder = decoding.createDecoder(payload);
            const encoder = encoding.createEncoder();
            const sub = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this.REMOTE);
            if (encoding.length(encoder) > 0) {
                const out = encoding.createEncoder();
                encoding.writeVarUint(out, MESSAGE_SYNC);
                encoding.writeUint8Array(out, encoding.toUint8Array(encoder));
                this.ws.send(encoding.toUint8Array(out), { binary: true });
            }
            this.lastSyncType = sub;
        } else if (type === MESSAGE_AWARENESS) {
            this.awareness = this.awareness ?? new awarenessProtocol.Awareness(this.doc);
            awarenessProtocol.applyAwarenessUpdate(this.awareness, payload, 'remote');
        }
    }

    cellValue(row, col, field) {
        return this.doc
            .getArray('sheets')
            .get(0)
            .get('cellData')
            .get(`${row}:${col}:${field}`);
    }

    writeCell(row, col, fields) {
        this.doc.transact(() => {
            const map = this.doc.getArray('sheets').get(0).get('cellData');
            for (const [field, value] of Object.entries(fields)) {
                map.set(`${row}:${col}:${field}`, value);
            }
        }, LOCAL);
    }

    close() {
        this.ws?.close();
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function main() {
    console.log(`目标：${HTTP_BASE}（经 vite 代理）`);

    section('1. 静态页面与代理');
    const index = await fetch(`${HTTP_BASE}/`);
    check('首页可访问', index.status === 200, `got ${index.status}`);
    const html = await index.text();
    check('是 SPA 入口', html.includes('<div id="root">'));

    const proxied = await api('/health');
    check('/api 代理到后端', proxied.status === 200, `got ${proxied.status}`);

    section('2. 注册 / 登录（走代理，验证 cookie）');
    const suffix = Date.now().toString(36);
    const email = `fe-${suffix}@example.com`;
    const username = `fe_${suffix}`;
    const password = 'passw0rd1';

    const register = await api('/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, username, password, displayName: '前端冒烟' }),
    });
    check('注册成功', register.status === 201, `got ${register.status}`);
    const token = register.body?.data?.accessToken ?? '';
    const cookie = pickCookie(register, 'pgclouddoc_rt');
    check('拿到 access token', token.length > 100);
    check('refresh cookie 透传到浏览器', cookie.length > 0);

    // 用 cookie 换新 token —— 验证同源代理下 httpOnly cookie 是通的
    const refreshed = await api('/api/v1/auth/refresh', {
        method: 'POST',
        cookie,
        body: '{}',
    });
    check('cookie 能用于刷新（同源代理生效）', refreshed.status === 200, `got ${refreshed.status}`);

    section('3. 文档 CRUD');
    const created = await api('/api/v1/documents', {
        method: 'POST',
        token,
        body: JSON.stringify({ name: '前端协同冒烟' }),
    });
    check('建文档成功', created.status === 201, `got ${created.status}`);
    const docId = created.body?.data?.id ?? '';

    const list = await api('/api/v1/documents?limit=10', { token });
    check('列表能看到', list.body?.data?.items?.some((d) => d.id === docId));

    section('4. WebSocket 代理 + 协同协议');
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = new CollabClient('A', docA);
    const b = new CollabClient('B', docB);

    await Promise.all([a.connect(docId, token), b.connect(docId, token)]);
    check('两个客户端经 /collab 代理接入', true);
    await sleep(600);

    check(
        '双方都收到服务端初始状态',
        docA.getArray('sheets').length > 0 && docB.getArray('sheets').length > 0,
        `A=${docA.getArray('sheets').length} B=${docB.getArray('sheets').length}`
    );

    a.writeCell(0, 0, { v: 'hello', t: 1 });
    await sleep(700);
    check('A 的改动 B 能收到', b.cellValue(0, 0, 'v') === 'hello', String(b.cellValue(0, 0, 'v')));

    b.writeCell(1, 1, { v: 42, t: 2 });
    await sleep(700);
    check('B 的改动 A 能收到', a.cellValue(1, 1, 'v') === 42, String(a.cellValue(1, 1, 'v')));

    // 并发同格不同字段：这是「嵌套 Y.Map 会丢数据、扁平 key 不会」的场景
    a.writeCell(2, 2, { v: 'from-a' });
    b.writeCell(2, 2, { s: 'style-from-b' });
    await sleep(900);
    check(
        '并发同格不同字段都保留',
        a.cellValue(2, 2, 'v') === 'from-a' && a.cellValue(2, 2, 's') === 'style-from-b',
        JSON.stringify({ v: a.cellValue(2, 2, 'v'), s: a.cellValue(2, 2, 's') })
    );

    section('5. 落库与快照（浏览器读到的就是这份）');
    const snap = await api(`/api/v1/documents/${docId}/snapshot`, { token });
    const cellData = snap.body?.sheets?.[snap.body?.sheetOrder?.[0]]?.cellData;
    check(
        '快照里能看到协同写入的格子',
        cellData?.[0]?.[0]?.v === 'hello' && cellData?.[1]?.[1]?.v === 42,
        JSON.stringify(cellData)
    );

    a.close();
    b.close();

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`通过 ${passed} 项，失败 ${failed} 项`);
    if (failed > 0) {
        console.log('\n失败项：');
        for (const f of failures) console.log(`  · ${f}`);
        process.exit(1);
    }
    console.log('✅ 前端接入冒烟全部通过');
    // ws / Y.Doc 会挂住事件循环，必须显式退出，否则冒烟脚本跑完了却不结束
    process.exit(0);
}

main().catch((err) => {
    console.error('\n❌ 冒烟脚本异常：', err);
    process.exit(1);
});
