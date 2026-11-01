/**
 * Anthropic Messages 协议适配器。
 *
 * DeepSeek 提供 `https://api.deepseek.com/anthropic` 原生兼容端点，
 * 所以这里直接按 Anthropic Messages 的流式协议实现，而不是 OpenAI-compatible：
 *   - 工具调用是原生 `tool_use` / `tool_result` 内容块；
 *   - 文本增量是 `text_delta`；
 *   - 结束原因是 `stop_reason`。
 *
 * 只依赖全局 fetch，不引入任何 SDK；密钥只来自服务端环境变量。
 */

import type { AiContentBlock, AiFinishReason, AiUsage } from '@pgclouddoc/ai-protocol';
import { AppError, ErrorCode } from '../../../shared/errors/app-error';
import type {
    AiProvider,
    AiProviderHandlers,
    AiProviderMessage,
    AiProviderTurnInput,
    AiProviderTurnResult,
} from './types';

const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicProviderOptions {
    /** 例如 https://api.deepseek.com/anthropic */
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    /** 允许测试/自建网关覆盖 */
    version?: string;
}

interface StreamState {
    /** 按 content block index 保存，最后按 index 排序输出 */
    blocks: Map<number, AiContentBlock>;
    /** tool_use 的 partial_json 累积 */
    toolJson: Map<number, string>;
    /** 有的实现会在 content_block_start 里直接给完整 input */
    toolInitialInput: Map<number, unknown>;
    usage: AiUsage;
    stopReason: string | null;
    sawToolUse: boolean;
}

export class AnthropicProvider implements AiProvider {
    readonly name = 'anthropic';

    constructor(private readonly options: AnthropicProviderOptions) {}

    async streamTurn(
        input: AiProviderTurnInput,
        handlers: AiProviderHandlers,
        signal: AbortSignal
    ): Promise<AiProviderTurnResult> {
        const controller = new AbortController();
        const abort = (): void => controller.abort();
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', abort);

        const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
        const state = createState();

        try {
            const response = await fetch(
                `${this.options.baseUrl.replace(/\/+$/, '')}/v1/messages`,
                {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        // Anthropic 原生客户端用 x-api-key；部分兼容网关只认 Bearer，
                        // 两个头都带上可以同时兼容 DeepSeek / 自建代理。
                        'x-api-key': this.options.apiKey,
                        authorization: `Bearer ${this.options.apiKey}`,
                        'anthropic-version': this.options.version ?? ANTHROPIC_VERSION,
                        accept: 'text/event-stream',
                    },
                    body: JSON.stringify({
                        model: input.model,
                        max_tokens: input.maxTokens,
                        system: input.system,
                        messages: toAnthropicMessages(input.messages),
                        tools: input.tools.map((tool) => ({
                            name: tool.name,
                            description: tool.description,
                            input_schema: tool.parameters,
                        })),
                        stream: true,
                    }),
                    signal: controller.signal,
                }
            );

            if (!response.ok) {
                const body = await safeText(response);
                const detail = extractProviderMessage(body);
                throw new AppError(
                    ErrorCode.DEPENDENCY_FAILED,
                    `AI 服务返回 ${response.status}${detail ? `：${detail}` : ''}`,
                    { details: body.slice(0, 500) }
                );
            }
            if (!response.body) {
                throw new AppError(ErrorCode.DEPENDENCY_FAILED, 'AI 服务没有返回响应流');
            }

            for await (const event of readSse(response.body)) {
                applyEvent(event, state, handlers);
            }

            return finish(state);
        } catch (err) {
            // 客户端主动断开：保留已生成内容，标记 cancelled
            if (signal.aborted) return finish(state, 'cancelled');
            // 超时：转成可读错误，让上层发 SSE error
            if (controller.signal.aborted) {
                throw new AppError(ErrorCode.DEPENDENCY_FAILED, 'AI 服务响应超时', {
                    cause: err,
                });
            }
            throw err;
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
        }
    }
}

// ─────────────────────────── 请求转换 ───────────────────────────

function toAnthropicMessages(messages: AiProviderMessage[]): unknown[] {
    return messages
        .map((message) => ({
            role: message.role,
            content: message.blocks.map(toAnthropicBlock).filter((block) => block !== null),
        }))
        .filter((message) => message.content.length > 0);
}

function toAnthropicBlock(block: AiContentBlock): unknown | null {
    if (block.type === 'text') {
        return block.text ? { type: 'text', text: block.text } : null;
    }
    if (block.type === 'tool_use') {
        return {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input ?? {},
        };
    }
    return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: [{ type: 'text', text: block.content }],
        is_error: !block.ok,
    };
}

// ─────────────────────────── 流状态 ───────────────────────────

function createState(): StreamState {
    return {
        blocks: new Map(),
        toolJson: new Map(),
        toolInitialInput: new Map(),
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: null,
        sawToolUse: false,
    };
}

function applyEvent(
    event: { event: string; data: string },
    state: StreamState,
    handlers: AiProviderHandlers
): void {
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
        return;
    }

    switch (event.event) {
        case 'message_start': {
            const message = payload['message'] as
                | { usage?: Record<string, number> }
                | undefined;
            const usage = message?.usage;
            if (usage) {
                state.usage.inputTokens = numberOrZero(usage['input_tokens']);
                state.usage.cachedTokens =
                    numberOrZero(usage['cache_read_input_tokens']) || undefined;
            }
            return;
        }

        case 'content_block_start': {
            const index = numberOrZero(payload['index']);
            const block = payload['content_block'] as
                | {
                      type?: string;
                      id?: string;
                      name?: string;
                      input?: unknown;
                  }
                | undefined;
            if (!block) return;

            if (block.type === 'text') {
                state.blocks.set(index, { type: 'text', text: '' });
                return;
            }
            if (block.type === 'tool_use') {
                state.blocks.set(index, {
                    type: 'tool_use',
                    id: String(block.id ?? ''),
                    name: String(block.name ?? ''),
                    input: {},
                });
                state.toolJson.set(index, '');
                state.toolInitialInput.set(index, block.input ?? {});
                state.sawToolUse = true;
            }
            return;
        }

        case 'content_block_delta': {
            const index = numberOrZero(payload['index']);
            const delta = payload['delta'] as
                | { type?: string; text?: string; partial_json?: string }
                | undefined;
            if (!delta) return;

            if (delta.type === 'text_delta') {
                const text = delta.text ?? '';
                const block = state.blocks.get(index);
                if (block?.type === 'text') block.text += text;
                else state.blocks.set(index, { type: 'text', text });
                if (text) handlers.onText(text);
                return;
            }
            if (delta.type === 'input_json_delta') {
                const previous = state.toolJson.get(index) ?? '';
                state.toolJson.set(index, previous + (delta.partial_json ?? ''));
            }
            return;
        }

        case 'content_block_stop': {
            const index = numberOrZero(payload['index']);
            const block = state.blocks.get(index);
            if (block?.type !== 'tool_use') return;

            const raw = state.toolJson.get(index) ?? '';
            const parsed = raw ? safeJsonParse(raw) : state.toolInitialInput.get(index);
            block.input = parsed ?? {};
            return;
        }

        case 'message_delta': {
            const delta = payload['delta'] as { stop_reason?: string } | undefined;
            if (delta?.stop_reason) state.stopReason = delta.stop_reason;
            const usage = payload['usage'] as Record<string, number> | undefined;
            if (usage) {
                state.usage.outputTokens = numberOrZero(usage['output_tokens']);
            }
            return;
        }

        case 'error': {
            const error = payload['error'] as
                | { type?: string; message?: string }
                | undefined;
            throw new AppError(
                ErrorCode.DEPENDENCY_FAILED,
                error?.message ?? 'AI 服务返回错误',
                { details: error?.type }
            );
        }

        default:
            // ping / message_stop / 未知事件：忽略
            return;
    }
}

function finish(state: StreamState, forced?: AiFinishReason): AiProviderTurnResult {
    const blocks = [...state.blocks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, block]) => block)
        .filter((block) => block.type !== 'text' || block.text.length > 0);

    const finishReason: AiFinishReason =
        forced ??
        (state.sawToolUse || state.stopReason === 'tool_use'
            ? 'tool_calls'
            : state.stopReason === 'max_tokens'
              ? 'length'
              : 'stop');

    return { blocks, finishReason, usage: state.usage };
}

// ─────────────────────────── SSE ───────────────────────────

interface SseEvent {
    event: string;
    data: string;
}

async function* readSse(
    body: ReadableStream<Uint8Array>
): AsyncGenerator<SseEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            buffer = buffer.replace(/\r\n/g, '\n');

            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
                const raw = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const event = parseSseBlock(raw);
                if (event) yield event;
                boundary = buffer.indexOf('\n\n');
            }
        }
    } finally {
        reader.releaseLock();
    }
}

function parseSseBlock(raw: string): SseEvent | null {
    let event = 'message';
    const data: string[] = [];

    for (const line of raw.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator >= 0 ? line.slice(0, separator) : line;
        let value = separator >= 0 ? line.slice(separator + 1) : '';
        if (value.startsWith(' ')) value = value.slice(1);

        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
    }

    return data.length > 0 ? { event, data: data.join('\n') } : null;
}

// ─────────────────────────── 工具函数 ───────────────────────────

function numberOrZero(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function safeJsonParse(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

async function safeText(response: Response): Promise<string> {
    try {
        return await response.text();
    } catch {
        return '';
    }
}

/** 从 Anthropic / 兼容网关的错误体里提取一行可读信息 */
function extractProviderMessage(body: string): string {
    try {
        const parsed = JSON.parse(body) as {
            error?: { message?: string };
            message?: string;
        };
        const message = parsed.error?.message ?? parsed.message;
        return typeof message === 'string' ? message.slice(0, 200) : '';
    } catch {
        return '';
    }
}
