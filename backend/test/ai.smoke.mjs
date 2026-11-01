/**
 * AI 网关冒烟测试。
 *
 * 前提：后端以 mock provider 启动（不调外部模型）：
 *   PORT=3100 AI_PROVIDER=mock pnpm --filter backend start
 *   SMOKE_BASE=http://localhost:3100 node test/ai.smoke.mjs
 *
 * 覆盖：配置 → 建会话 → 用户轮（SSE + tool_call）→ 工具结果轮 → 会话恢复 → 清理。
 */

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3100';

let failures = 0;
function check(name, ok, detail = '') {
    if (ok) {
        console.log(`  ✅ ${name}`);
    } else {
        failures += 1;
        console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

async function api(path, { token, ...init } = {}) {
    const headers = { ...init.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${BASE}${path}`, { ...init, headers });
    const text = await response.text();
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }
    return { status: response.status, body, text };
}

function parseSse(text) {
    return text
        .split(/\n\n/)
        .map((block) => {
            let event = 'message';
            const data = [];
            for (const line of block.split('\n')) {
                if (!line || line.startsWith(':')) continue;
                const index = line.indexOf(':');
                const field = index >= 0 ? line.slice(0, index) : line;
                let value = index >= 0 ? line.slice(index + 1) : '';
                if (value.startsWith(' ')) value = value.slice(1);
                if (field === 'event') event = value;
                else if (field === 'data') data.push(value);
            }
            if (data.length === 0) return null;
            const payload = data.join('\n');
            try {
                return { event, data: JSON.parse(payload) };
            } catch {
                return { event, data: payload };
            }
        })
        .filter(Boolean);
}

function contextFor(documentId) {
    return {
        documentId,
        title: 'AI 冒烟测试',
        activeSheet: { id: 'sheet1', name: 'Sheet1' },
        sheets: [
            {
                id: 'sheet1',
                name: 'Sheet1',
                hidden: false,
                rowCount: 100,
                columnCount: 26,
                usedRange: 'A1:C10',
            },
        ],
        selection: {
            active: 'A1',
            ranges: [{ address: 'A1:C10', rows: 10, columns: 3 }],
            preview: [['名称', '数量', '金额']],
            previewAddress: 'A1:C1',
            truncated: false,
        },
        capabilities: { canWrite: true },
    };
}

const tools = [
    {
        name: 'read_range',
        description: '读取区域',
        parameters: {
            type: 'object',
            properties: { range: { type: 'string' } },
            required: ['range'],
        },
    },
];

async function main() {
    console.log(`BASE = ${BASE}`);
    const suffix = Date.now().toString(36);
    const username = `ai_smoke_${suffix}`;
    const password = 'passw0rd1';

    const register = await api('/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
            email: `${username}@example.com`,
            username,
            password,
            displayName: 'AI Smoke',
        }),
    });
    check('注册成功', register.status === 201, `got ${register.status}`);

    const login = await api('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier: username, password }),
    });
    const token = login.body?.data?.accessToken ?? '';
    check('登录成功并拿到 access token', Boolean(token), `got ${login.status}`);

    const created = await api('/api/v1/documents', {
        method: 'POST',
        token,
        body: JSON.stringify({ name: `AI 冒烟 ${suffix}` }),
    });
    const documentId = created.body?.data?.id ?? '';
    check('创建文档', created.status === 201 && Boolean(documentId), `got ${created.status}`);

    try {
        const config = await api('/api/v1/ai/config', { token });
        check('AI 配置可用（mock）', config.status === 200 && config.body?.data?.enabled === true);
        check(
            '配置返回模型与限制',
            Array.isArray(config.body?.data?.models) &&
                config.body?.data?.models.length > 0 &&
                typeof config.body?.data?.limits?.maxToolCallsPerTurn === 'number'
        );

        const conversation = await api('/api/v1/ai/conversations', {
            method: 'POST',
            token,
            body: JSON.stringify({ documentId }),
        });
        const conversationId = conversation.body?.data?.id ?? '';
        check('创建会话', conversation.status === 201 && Boolean(conversationId), conversation.text?.slice(0, 200));

        // ── 第一轮：用户消息 → 模型请求工具 ──
        const first = await api(`/api/v1/ai/conversations/${conversationId}/turns`, {
            method: 'POST',
            token,
            headers: { Accept: 'text/event-stream' },
            body: JSON.stringify({
                requestId: `req-${suffix}-1`,
                input: { type: 'user', text: '请读取当前选区' },
                context: contextFor(documentId),
                tools,
            }),
        });
        const firstEvents = parseSse(first.text ?? '');
        const names = firstEvents.map((event) => event.event);
        check('第一轮返回 SSE', first.status === 200 && names.includes('turn_start'));
        check('第一轮有文本增量', names.includes('text_delta'));
        check('第一轮请求工具', names.includes('tool_call'));

        const toolCall = firstEvents.find((event) => event.event === 'tool_call')?.data;
        check(
            '工具调用参数正确',
            toolCall?.name === 'read_range' && toolCall?.arguments?.range === 'A1:C10',
            JSON.stringify(toolCall)
        );
        check(
            '第一轮以 tool_calls 结束',
            firstEvents.find((event) => event.event === 'turn_end')?.data?.finishReason ===
                'tool_calls'
        );

        // ── 第二轮：工具结果 → 模型收尾 ──
        const second = await api(`/api/v1/ai/conversations/${conversationId}/turns`, {
            method: 'POST',
            token,
            headers: { Accept: 'text/event-stream' },
            body: JSON.stringify({
                requestId: `req-${suffix}-2`,
                input: {
                    type: 'tool_results',
                    results: [
                        {
                            toolCallId: toolCall?.id ?? 'mock',
                            name: 'read_range',
                            ok: true,
                            result: { values: [['名称', '数量', '金额']] },
                        },
                    ],
                },
                context: contextFor(documentId),
                tools,
            }),
        });
        const secondEvents = parseSse(second.text ?? '');
        check('第二轮返回 SSE', second.status === 200 && secondEvents.length > 0);
        check('第二轮以 stop 结束', secondEvents.find((event) => event.event === 'turn_end')?.data?.finishReason === 'stop');

        // ── 会话恢复 ──
        const detail = await api(`/api/v1/ai/conversations/${conversationId}`, { token });
        const messages = detail.body?.data?.messages ?? [];
        check('会话返回 4 条消息', messages.length === 4, `got ${messages.length}`);
        check(
            '消息角色顺序正确',
            messages.map((message) => message.role).join(',') ===
                'user,assistant,user,assistant'
        );
        check(
            '助手消息含 tool_use',
            messages.some((message) =>
                (message.blocks ?? []).some((block) => block.type === 'tool_use')
            )
        );

        const list = await api(`/api/v1/ai/conversations?documentId=${encodeURIComponent(documentId)}`, {
            token,
        });
        check(
            '会话列表按文档过滤',
            Array.isArray(list.body?.data) && list.body.data.some((item) => item.id === conversationId)
        );

        const removed = await api(`/api/v1/ai/conversations/${conversationId}`, {
            method: 'DELETE',
            token,
        });
        check('删除会话', removed.status === 200);
    } finally {
        await api(`/api/v1/documents/${documentId}`, { method: 'DELETE', token });
    }

    console.log('');
    if (failures > 0) {
        console.error(`${failures} 项失败`);
        process.exit(1);
    }
    console.log('全部通过');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
