#!/usr/bin/env node
/**
 * 验证 AI 供应商配置：流式 + 原生工具调用。
 *
 *   cd backend && pnpm ai:probe
 *   # 或 node --env-file=.env scripts/probe-ai.mjs
 *
 * 只读 backend/.env，不连数据库。成功时打印文本、工具名与 stop_reason；
 * 失败时打印上游 HTTP 状态与错误体（不打印密钥）。
 */

import 'dotenv/config';

const baseUrl = (process.env.AI_BASE_URL || 'https://api.deepseek.com/anthropic').replace(
    /\/+$/,
    ''
);
const apiKey = process.env.AI_API_KEY || '';
const model = process.env.AI_MODEL || 'deepseek-v4-flash';

if (!apiKey) {
    console.error('AI_API_KEY 为空：请先在 backend/.env 里配置');
    process.exit(1);
}

console.log(`provider: anthropic-compatible`);
console.log(`baseUrl : ${baseUrl}`);
console.log(`model   : ${model}`);
console.log('');

const body = {
    model,
    max_tokens: 512,
    system: '你是一个测试助手。用户要求读取表格时，必须调用 read_range 工具，不要直接回答。',
    messages: [{ role: 'user', content: '请读取 A1:C3 区域' }],
    tools: [
        {
            name: 'read_range',
            description: '读取表格区域',
            input_schema: {
                type: 'object',
                properties: {
                    range: { type: 'string', description: 'A1 区域，例如 A1:C3' },
                },
                required: ['range'],
            },
        },
    ],
    stream: true,
};

let response;
try {
    response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            authorization: `Bearer ${apiKey}`,
            'anthropic-version': '2023-06-01',
            accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
    });
} catch (err) {
    console.error(`请求失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
}

if (!response.ok) {
    console.error(`HTTP ${response.status}`);
    console.error((await response.text()).slice(0, 2_000));
    process.exit(1);
}
if (!response.body) {
    console.error('响应没有 body');
    process.exit(1);
}

let text = '';
let stopReason = null;
const toolBlocks = new Map();

function handleBlock(raw) {
    let event = 'message';
    const data = [];
    for (const line of raw.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const index = line.indexOf(':');
        const field = index >= 0 ? line.slice(0, index) : line;
        let value = index >= 0 ? line.slice(index + 1) : '';
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
    }
    if (data.length === 0) return;

    let payload;
    try {
        payload = JSON.parse(data.join('\n'));
    } catch {
        return;
    }

    if (event === 'content_block_start' && payload.content_block?.type === 'tool_use') {
        toolBlocks.set(payload.index, {
            id: payload.content_block.id,
            name: payload.content_block.name,
            json: '',
        });
    } else if (event === 'content_block_delta') {
        if (payload.delta?.type === 'text_delta') text += payload.delta.text ?? '';
        if (payload.delta?.type === 'input_json_delta') {
            const block = toolBlocks.get(payload.index);
            if (block) block.json += payload.delta.partial_json ?? '';
        }
    } else if (event === 'message_delta' && payload.delta?.stop_reason) {
        stopReason = payload.delta.stop_reason;
    } else if (event === 'error') {
        console.error('上游 error：', JSON.stringify(payload.error ?? payload));
    }
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
        handleBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
    }
}

console.log('text      :', text || '（无文本）');
console.log('toolCalls :');
for (const block of toolBlocks.values()) {
    console.log(`  - ${block.name}(${block.json || '{}'})`);
}
if (toolBlocks.size === 0) console.log('  （没有工具调用）');
console.log('stopReason:', stopReason ?? '（未收到）');

if (!stopReason) {
    console.error('\n没有收到 message_delta.stop_reason，流可能被截断');
    process.exit(1);
}
if (toolBlocks.size === 0) {
    console.error('\n模型没有返回 tool_use：该模型/端点可能不支持原生工具调用');
    process.exit(2);
}
console.log('\nOK：流式与原生工具调用都正常');
