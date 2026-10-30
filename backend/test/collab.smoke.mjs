/**
 * 协同链路手工冒烟脚本。
 *
 * 不是单元测试 —— 它要求 docker-compose 里的 PG/Redis/Kafka 和 Nest 服务都在跑，
 * 用来一次性验证「两个客户端改同一个文档能不能互相看见、有没有落库」。
 *
 *   node test/collab.smoke.mjs
 */

import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

const MESSAGE_SYNC = 0;

async function api(path, options = {}) {
    const res = await fetch(`${BASE}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
}

/** 一个协同客户端：持有一份 Y.Doc，负责收发 sync 消息 */
class CollabClient {
    constructor(name, doc) {
        this.name = name;
        this.doc = doc;
        this.received = [];
        // 远端来的 update 用这个 origin 标记，避免再发回去（否则会无限回声）
        this.REMOTE = Symbol(`remote-${name}`);
    }

    connect(url) {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(url, { perMessageDeflate: false });
            this.ws.binaryType = 'nodebuffer';
            this.ws.on('open', () => resolve());
            this.ws.on('error', reject);
            this.ws.on('message', (data) => this.onMessage(Buffer.from(data)));

            // 本地编辑 → 发给服务端
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
        const messageType = data[0];
        const payload = new Uint8Array(data.subarray(1));
        if (messageType !== MESSAGE_SYNC) return;

        const decoder = decoding.createDecoder(payload);
        const encoder = encoding.createEncoder();
        const type = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this.REMOTE);
        this.received.push(type);

        // 服务端回的 syncStep1 要回 syncStep2（encoder 里已经是子消息，补外层类型即可）
        if (encoding.length(encoder) > 0) {
            const out = encoding.createEncoder();
            encoding.writeVarUint(out, MESSAGE_SYNC);
            encoding.writeUint8Array(out, encoding.toUint8Array(encoder));
            this.ws.send(encoding.toUint8Array(out), { binary: true });
        }
    }

    close() {
        this.ws?.close();
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function main() {
    // ── 登录 ──
    const login = await api('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier: 'alice', password: 'passw0rd1' }),
    });
    if (!login.body?.success) {
        throw new Error(`登录失败：${JSON.stringify(login.body)}`);
    }
    const token = login.body.data.accessToken;

    // ── 建文档 ──
    const created = await api('/api/v1/documents', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: '协同冒烟文档' }),
    });
    const docId = created.body.data.id;
    console.log(`文档已建：${docId}`);

    // ── 两个客户端接入 ──
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = new CollabClient('A', docA);
    const b = new CollabClient('B', docB);
    const url = (id) => `ws://localhost:3000/collab/${id}?access_token=${token}`;

    await Promise.all([a.connect(url(docId)), b.connect(url(docId))]);
    console.log('两个客户端已接入');
    await sleep(500);

    // 双方都该拿到服务端的初始状态
    const nameA0 = docA.getMap('meta').get('name');
    const nameB0 = docB.getMap('meta').get('name');
    console.log(`初始状态 A.name=${nameA0} B.name=${nameB0}`);
    if (nameA0 !== '协同冒烟文档' || nameB0 !== '协同冒烟文档') {
        throw new Error('初始状态同步失败');
    }

    // ── A 改内容，B 应该看见 ──
    // 扁平 key："row:col:field"，见 infra/yjs/ydoc.ts 的设计说明
    console.log('A 写入单元格 (0,0) = "hello"');
    docA.transact(() => {
        const cellData = docA.getArray('sheets').get(0).get('cellData');
        cellData.set('0:0:v', 'hello');
        cellData.set('0:0:t', 1);
    });

    await sleep(800);

    const bValue = docB.getArray('sheets').get(0).get('cellData').get('0:0:v');
    console.log(`B 收到的单元格值：${JSON.stringify(bValue)}`);
    if (bValue !== 'hello') {
        throw new Error('B 没有收到 A 的编辑');
    }

    // ── 反向：B 改，A 看见 ──
    console.log('B 写入单元格 (1,1) = 42');
    docB.transact(() => {
        const cellData = docB.getArray('sheets').get(0).get('cellData');
        cellData.set('1:1:v', 42);
        cellData.set('1:1:t', 2);
    });
    await sleep(800);

    const aValue = docA.getArray('sheets').get(0).get('cellData').get('1:1:v');
    console.log(`A 收到的单元格值：${JSON.stringify(aValue)}`);
    if (aValue !== 42) {
        throw new Error('A 没有收到 B 的编辑');
    }

    // ── 并发同格不同字段：两边同时新建同一个格子，字段都必须活下来 ──
    console.log('并发：A 写 (2,2).v，B 写 (2,2).s');
    docA.transact(() => {
        docA.getArray('sheets').get(0).get('cellData').set('2:2:v', 'from-a');
    });
    docB.transact(() => {
        docB.getArray('sheets').get(0).get('cellData').set('2:2:s', 'style-from-b');
    });
    await sleep(1000);

    const mergedCell = {
        v: docB.getArray('sheets').get(0).get('cellData').get('2:2:v'),
        s: docA.getArray('sheets').get(0).get('cellData').get('2:2:s'),
    };
    console.log(`合并后的 (2,2)：${JSON.stringify(mergedCell)}`);
    if (mergedCell.v !== 'from-a' || mergedCell.s !== 'style-from-b') {
        throw new Error('同格不同字段的并发编辑丢失了');
    }

    // ── 落库验证 ──
    // /snapshot 用 @SkipWrap()，响应体就是工作簿本身，不是 { success, data } 包装
    const snapshot = await api(`/api/v1/documents/${docId}/snapshot`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const workbook = snapshot.body;
    const cellData = workbook.sheets[workbook.sheetOrder[0]].cellData;
    console.log(`快照里的单元格：${JSON.stringify(cellData)}`);
    if (cellData?.['0']?.['0']?.v !== 'hello' || cellData?.['1']?.['1']?.v !== 42) {
        throw new Error('快照与协同状态不一致');
    }

    a.close();
    b.close();
    console.log('\n✅ 协同冒烟通过：双向同步 + 落库都正确');
}

main().catch((err) => {
    console.error('\n❌ 协同冒烟失败：', err.message);
    process.exit(1);
});
