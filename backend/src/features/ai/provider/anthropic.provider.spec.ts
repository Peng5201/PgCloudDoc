/**
 * Anthropic 适配器：SSE 解析、工具调用聚合、错误映射。
 *
 * 用伪造的 ReadableStream 覆盖「跨 chunk 半行」的情况，
 * 这是流式解析最容易出错的地方。
 */

import { AnthropicProvider } from './anthropic.provider';

interface SseFixture {
    event: string;
    data: unknown;
}

function sseStream(events: SseFixture[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const payload = events
        .map((item) => `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`)
        .join('');

    return new ReadableStream<Uint8Array>({
        start(controller) {
            // 故意切成不均匀的小块，验证跨 chunk 的行缓冲
            const chunks = [payload.slice(0, 17), payload.slice(17, 61), payload.slice(61)];
            for (const chunk of chunks) {
                if (chunk) controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        },
    });
}

function jsonResponse(status: number, body = ''): Response {
    return new Response(body, { status });
}

const baseInput = {
    model: 'deepseek-v4-flash',
    system: 'system prompt',
    messages: [
        {
            role: 'user' as const,
            blocks: [{ type: 'text' as const, text: '查一下 A1:C10' }],
        },
    ],
    tools: [
        {
            name: 'read_range',
            description: '读取区域',
            parameters: { type: 'object', properties: {} },
        },
    ],
    maxTokens: 1024,
};

describe('AnthropicProvider', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    it('解析文本增量与跨 chunk 的工具调用，并返回规范化结果', async () => {
        const fetchMock = jest.fn(async () =>
            new Response(
                sseStream([
                    { event: 'message_start', data: { message: { usage: { input_tokens: 10 } } } },
                    {
                        event: 'content_block_start',
                        data: { index: 0, content_block: { type: 'text', text: '' } },
                    },
                    {
                        event: 'content_block_delta',
                        data: { index: 0, delta: { type: 'text_delta', text: '你好' } },
                    },
                    { event: 'content_block_stop', data: { index: 0 } },
                    {
                        event: 'content_block_start',
                        data: {
                            index: 1,
                            content_block: { type: 'tool_use', id: 'call_1', name: 'read_range', input: {} },
                        },
                    },
                    {
                        event: 'content_block_delta',
                        data: { index: 1, delta: { type: 'input_json_delta', partial_json: '{"range":' } },
                    },
                    {
                        event: 'content_block_delta',
                        data: { index: 1, delta: { type: 'input_json_delta', partial_json: '"A1:C10"}' } },
                    },
                    { event: 'content_block_stop', data: { index: 1 } },
                    {
                        event: 'message_delta',
                        data: { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
                    },
                    { event: 'message_stop', data: {} },
                ]),
                { status: 200 }
            )
        );
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const deltas: string[] = [];
        const provider = new AnthropicProvider({
            baseUrl: 'https://api.deepseek.com/anthropic',
            apiKey: 'test-key',
            timeoutMs: 5_000,
        });

        const result = await provider.streamTurn(
            baseInput,
            { onText: (delta) => deltas.push(delta) },
            new AbortController().signal
        );

        expect(deltas).toEqual(['你好']);
        expect(result.finishReason).toBe('tool_calls');
        expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
        expect(result.blocks).toEqual([
            { type: 'text', text: '你好' },
            { type: 'tool_use', id: 'call_1', name: 'read_range', input: { range: 'A1:C10' } },
        ]);

        // 请求形态：原生 Anthropic Messages + 工具 schema
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://api.deepseek.com/anthropic/v1/messages');
        expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key');
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body['model']).toBe('deepseek-v4-flash');
        expect(body['stream']).toBe(true);
        expect(body['system']).toBe('system prompt');
        expect(body['tools']).toEqual([
            {
                name: 'read_range',
                description: '读取区域',
                input_schema: { type: 'object', properties: {} },
            },
        ]);
    });

    it('上游非 2xx 抛 DEPENDENCY_FAILED', async () => {
        globalThis.fetch = jest.fn(async () => jsonResponse(401, 'bad key')) as unknown as typeof fetch;

        const provider = new AnthropicProvider({
            baseUrl: 'https://api.deepseek.com/anthropic',
            apiKey: 'bad',
            timeoutMs: 5_000,
        });

        await expect(
            provider.streamTurn(baseInput, { onText: () => undefined }, new AbortController().signal)
        ).rejects.toMatchObject({ code: 'DEPENDENCY_FAILED' });
    });

    it('把 tool_result 映射成 Anthropic 的 user 内容块', async () => {
        const fetchMock = jest.fn(async () =>
            new Response(
                sseStream([
                    { event: 'content_block_start', data: { index: 0, content_block: { type: 'text', text: '' } } },
                    {
                        event: 'content_block_delta',
                        data: { index: 0, delta: { type: 'text_delta', text: '完成' } },
                    },
                    { event: 'message_stop', data: {} },
                ]),
                { status: 200 }
            )
        );
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = new AnthropicProvider({
            baseUrl: 'https://api.deepseek.com/anthropic',
            apiKey: 'test-key',
            timeoutMs: 5_000,
        });

        await provider.streamTurn(
            {
                ...baseInput,
                messages: [
                    {
                        role: 'assistant',
                        blocks: [
                            {
                                type: 'tool_use',
                                id: 'call_1',
                                name: 'read_range',
                                input: { range: 'A1:C10' },
                            },
                        ],
                    },
                    {
                        role: 'user',
                        blocks: [
                            {
                                type: 'tool_result',
                                toolUseId: 'call_1',
                                ok: true,
                                content: '{"ok":true}',
                            },
                        ],
                    },
                ],
            },
            { onText: () => undefined },
            new AbortController().signal
        );

        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        const body = JSON.parse(String(init.body)) as { messages: unknown[] };
        expect(body.messages).toEqual([
            {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'call_1', name: 'read_range', input: { range: 'A1:C10' } },
                ],
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'call_1',
                        content: [{ type: 'text', text: '{"ok":true}' }],
                        is_error: false,
                    },
                ],
            },
        ]);
    });
});
