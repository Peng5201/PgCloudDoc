/**
 * HTTP 链路冒烟脚本 —— 打真实服务，验证整条 REST 链路。
 *
 * 为什么不写成 jest 的 e2e：
 *   Nest 12 发布的是纯 ESM 包，jest 30 在 Node 22 上装不进来
 *   （require(esm) 未支持，见 src/modules/auth/token.ts 的说明），
 *   `Test.createTestingModule` + supertest 那套跑不了。
 *   换成打真实 HTTP 的脚本反而更接近生产路径 —— 中间件、Guard、
 *   过滤器、缓存头全都真跑一遍。
 *
 * 前置：docker compose up -d && pnpm --filter backend exec prisma migrate deploy
 *       && nest start（另开一个终端）
 *
 *   node test/http.smoke.mjs
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

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

    const res = await fetch(`${BASE}${path}`, { ...init, headers });
    const text = await res.text();
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }
    return { status: res.status, headers: res.headers, body, text };
}

/** 从 Set-Cookie 里抠出 name=value，供后续请求带上 */
function pickCookie(response, name) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const cookie of raw) {
        const [pair] = cookie.split(';');
        const [key, ...rest] = pair.trim().split('=');
        if (key === name) return `${name}=${rest.join('=')}`;
    }
    return '';
}

async function main() {
    console.log(`目标：${BASE}`);

    // ────────────────────────── 健康检查 ──────────────────────────
    section('1. 健康检查');
    const live = await api('/health');
    check('liveness 返回 200', live.status === 200, `got ${live.status}`);

    const ready = await api('/health/ready');
    check('readiness 返回 200', ready.status === 200, `got ${ready.status}`);
    const criticalDown = (ready.body?.checks ?? []).filter(
        (c) => c.critical && c.status !== 'up'
    );
    check('关键依赖全部可用', criticalDown.length === 0, JSON.stringify(criticalDown));

    // ────────────────────────── 注册 / 登录 ──────────────────────────
    section('2. 注册 / 登录');
    const suffix = Date.now().toString(36);
    const email = `smoke-${suffix}@example.com`;
    const username = `smoke_${suffix}`;
    const password = 'passw0rd1';

    const register = await api('/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, username, password, displayName: 'Smoke' }),
    });
    check('注册成功（201 Created）', register.status === 201 && register.body?.success, `got ${register.status}`);
    check('响应里没有密码哈希', !JSON.stringify(register.body ?? {}).includes('passwordHash'));

    const dupEmail = await api('/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, username: `${username}_2`, password }),
    });
    check('重复邮箱被拒（409）', dupEmail.status === 409, `got ${dupEmail.status}`);

    const weak = await api('/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
            email: `weak-${suffix}@example.com`,
            username: `${username}_3`,
            password: '123',
        }),
    });
    check('弱密码被拒（422）', weak.status === 422, `got ${weak.status}`);

    const login = await api('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier: username, password }),
    });
    check('登录成功', login.status === 200 && login.body?.success, login.text?.slice(0, 200));
    const token = login.body?.data?.accessToken ?? '';
    const refreshCookie = pickCookie(login, 'pgclouddoc_rt');
    check('下发了 access token', token.length > 100, `len=${token.length}`);
    check('refresh token 走 httpOnly cookie', refreshCookie.length > 0);

    const badLogin = await api('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier: username, password: 'wrong-pass1' }),
    });
    check('密码错误返回 401', badLogin.status === 401, `got ${badLogin.status}`);

    // ────────────────────────── 文档 CRUD ──────────────────────────
    section('3. 文档 CRUD');
    const created = await api('/api/v1/documents', {
        method: 'POST',
        token,
        body: JSON.stringify({ name: '冒烟测试文档' }),
    });
    check('建文档成功（201 Created）', created.status === 201 && created.body?.success, `got ${created.status}`);
    const docId = created.body?.data?.id ?? '';
    check('新文档自动有 1 个版本', created.body?.data?.versionCount === 1);

    const list = await api('/api/v1/documents?limit=5', { token });
    check('列表含新建的文档', list.body?.data?.items?.some((d) => d.id === docId));
    check('列表项不带快照（体积控制）', !JSON.stringify(list.body?.data?.items ?? []).includes('sheetOrder'));

    const renamed = await api(`/api/v1/documents/${docId}`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ name: '改名后的文档' }),
    });
    check('改名成功', renamed.body?.data?.name === '改名后的文档', renamed.text?.slice(0, 200));

    // ────────────────────────── 快照与 HTTP 缓存 ──────────────────────────
    section('4. 快照与 HTTP 缓存（ETag / 304）');
    const snap1 = await api(`/api/v1/documents/${docId}/snapshot`, { token });
    check('取到快照', snap1.status === 200 && snap1.body?.sheets, snap1.text?.slice(0, 200));
    check('快照是工作簿本身（不套响应包装）', !!snap1.body?.sheetOrder);
    const etag = snap1.headers.get('etag');
    check('带 ETag', !!etag, `etag=${etag}`);
    check(
        'Cache-Control 是 must-revalidate',
        (snap1.headers.get('cache-control') ?? '').includes('must-revalidate'),
        snap1.headers.get('cache-control')
    );

    const snap2 = await api(`/api/v1/documents/${docId}/snapshot`, {
        token,
        headers: { 'If-None-Match': etag },
    });
    check('命中协商缓存返回 304', snap2.status === 304, `got ${snap2.status}`);
    check('304 不带响应体', snap2.text.length === 0, `len=${snap2.text.length}`);

    // 改内容后 ETag 必须变
    await api(`/api/v1/documents/${docId}`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ name: '再改一次' }),
    });
    const snap3 = await api(`/api/v1/documents/${docId}/snapshot`, {
        token,
        headers: { 'If-None-Match': etag },
    });
    check('内容变化后 ETag 失效', snap3.status === 200, `got ${snap3.status}`);

    // ────────────────────────── 版本 / 归档 ──────────────────────────
    section('5. 版本与归档');
    const archived = await api(`/api/v1/documents/${docId}/archive`, {
        method: 'POST',
        token,
        body: JSON.stringify({ remark: '冒烟归档' }),
    });
    check('手动归档成功', archived.body?.data?.versionNo === 2, archived.text?.slice(0, 200));

    const versions = await api(`/api/v1/documents/${docId}/versions`, { token });
    check('版本列表有 2 条', versions.body?.data?.length === 2, `got ${versions.body?.data?.length}`);

    const restored = await api(`/api/v1/documents/${docId}/versions/1/restore`, {
        method: 'POST',
        token,
    });
    check('回滚成功', restored.status === 200, restored.text?.slice(0, 200));

    const dup = await api(`/api/v1/documents/${docId}/duplicate`, { method: 'POST', token });
    check('复制成功（201 Created）', dup.status === 201 && dup.body?.data?.id !== docId, `got ${dup.status}`);

    // ────────────────────────── 权限 ──────────────────────────
    section('6. 权限（越权一律 404）');
    const otherEmail = `other-${suffix}@example.com`;
    await api('/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
            email: otherEmail,
            username: `${username}_other`,
            password,
        }),
    });
    const otherLogin = await api('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier: `${username}_other`, password }),
    });
    const otherToken = otherLogin.body?.data?.accessToken ?? '';

    // 先让拥有者访问一次把缓存热起来 —— 最容易复现「缓存命中跳过鉴权」的场景
    await api(`/api/v1/documents/${docId}`, { token });

    const crossDetail = await api(`/api/v1/documents/${docId}`, { token: otherToken });
    check('他人读详情 404', crossDetail.status === 404, `got ${crossDetail.status}`);
    const crossSnap = await api(`/api/v1/documents/${docId}/snapshot`, { token: otherToken });
    check('他人读快照 404', crossSnap.status === 404, `got ${crossSnap.status}`);
    const crossVer = await api(`/api/v1/documents/${docId}/versions`, { token: otherToken });
    check('他人读版本 404', crossVer.status === 404, `got ${crossVer.status}`);
    const crossPatch = await api(`/api/v1/documents/${docId}`, {
        method: 'PATCH',
        token: otherToken,
        body: JSON.stringify({ name: 'hacked' }),
    });
    check('他人改文档 404', crossPatch.status === 404, `got ${crossPatch.status}`);

    const anon = await api('/api/v1/documents');
    check('未登录访问 401', anon.status === 401, `got ${anon.status}`);
    check('错误体带 requestId', !!anon.body?.requestId, JSON.stringify(anon.body));
    check('错误体有稳定 code', anon.body?.code === 'UNAUTHORIZED', anon.body?.code);

    // ────────────────────────── 双 token ──────────────────────────
    section('7. 双 token：轮换 + 重放检测');
    const refreshed = await api('/api/v1/auth/refresh', {
        method: 'POST',
        cookie: refreshCookie,
        body: '{}',
    });
    check('刷新成功', refreshed.status === 200 && refreshed.body?.success, refreshed.text?.slice(0, 200));
    check('刷新后换发了新 refresh token', refreshed.body?.data?.refreshToken !== undefined);
    const newCookie = pickCookie(refreshed, 'pgclouddoc_rt');
    check('cookie 已更新', newCookie.length > 0 && newCookie !== refreshCookie);

    // 用**旧的** cookie 再刷新一次 —— 正常流程不会发生，必然是令牌泄漏
    const replay = await api('/api/v1/auth/refresh', {
        method: 'POST',
        cookie: refreshCookie,
        body: '{}',
    });
    check('重放旧 token 被识别（TOKEN_REUSED）', replay.body?.code === 'TOKEN_REUSED', replay.text?.slice(0, 200));
    check('重放返回 401', replay.status === 401, `got ${replay.status}`);

    // 整族被吊销后，新 cookie 也不能再用
    const afterRevoke = await api('/api/v1/auth/refresh', {
        method: 'POST',
        cookie: newCookie,
        body: '{}',
    });
    check('整族令牌已失效', afterRevoke.status === 401, `got ${afterRevoke.status}`);

    // ────────────────────────── 软删除 ──────────────────────────
    section('8. 软删除');
    const removed = await api(`/api/v1/documents/${docId}`, { method: 'DELETE', token });
    check('删除成功', removed.status === 200, removed.text?.slice(0, 200));

    const listAfter = await api('/api/v1/documents?limit=20', { token });
    check(
        '列表里已消失',
        !(listAfter.body?.data?.items ?? []).some((d) => d.id === docId)
    );

    const detailAfter = await api(`/api/v1/documents/${docId}`, { token });
    check('再读返回 404', detailAfter.status === 404, `got ${detailAfter.status}`);

    // ────────────────────────── 汇总 ──────────────────────────
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`通过 ${passed} 项，失败 ${failed} 项`);
    if (failed > 0) {
        console.log('\n失败项：');
        for (const f of failures) console.log(`  · ${f}`);
        process.exit(1);
    }
    console.log('✅ HTTP 冒烟全部通过');
}

main().catch((err) => {
    console.error('\n❌ 冒烟脚本异常：', err);
    process.exit(1);
});
