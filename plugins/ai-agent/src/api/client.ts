/**
 * AI 网关客户端。
 *
 * 所有请求都走 ctx.net.fetch：宿主负责注入登录态、单飞刷新 401。
 * 这里只处理统一信封和 SSE 事件。
 */

import {
    AI_SSE,
    type AiConfigResponse,
    type AiConversationDetail,
    type AiConversationSummary,
    type AiErrorEvent,
    type AiFinishReason,
    type AiToolCallEvent,
    type AiTurnEndEvent,
    type AiTurnRequest,
    type AiUsage,
} from '@pgclouddoc/ai-protocol';
import type { PluginContext } from '@pgclouddoc/plugin-api';
import { consumeSse } from './sse';

export class AiApiError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly status = 0
    ) {
        super(message);
        this.name = 'AiApiError';
    }
}

export interface TurnStreamHandlers {
    onText(delta: string): void;
    onToolCall(call: AiToolCallEvent): void;
    onUsage(usage: AiUsage): void;
    onTurnEnd(event: AiTurnEndEvent): void;
    onError(event: AiErrorEvent): void;
}

export interface TurnOutcome {
    finishReason: AiFinishReason;
    toolCalls: AiToolCallEvent[];
    usage?: AiUsage;
    error?: AiErrorEvent;
}

interface ApiEnvelope<T> {
    success?: boolean;
    data?: T;
    code?: string;
    message?: string;
}

export class AiApiClient {
    constructor(private readonly ctx: PluginContext) {}

    getConfig(): Promise<AiConfigResponse> {
        return this.getJson('/api/v1/ai/config');
    }

    createConversation(documentId: string): Promise<AiConversationSummary> {
        return this.sendJson('/api/v1/ai/conversations', {
            method: 'POST',
            body: { documentId },
        });
    }

    listConversations(documentId: string): Promise<AiConversationSummary[]> {
        return this.getJson(
            `/api/v1/ai/conversations?documentId=${encodeURIComponent(documentId)}`
        );
    }

    getConversation(id: string): Promise<AiConversationDetail> {
        return this.getJson(`/api/v1/ai/conversations/${encodeURIComponent(id)}`);
    }

    renameConversation(id: string, title: string): Promise<AiConversationSummary> {
        return this.sendJson(`/api/v1/ai/conversations/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: { title },
        });
    }

    async deleteConversation(id: string): Promise<void> {
        await this.sendJson(`/api/v1/ai/conversations/${encodeURIComponent(id)}`, {
            method: 'DELETE',
        });
    }

    /** 推进一轮对话；返回本轮完整结果，文本/工具增量通过 handlers 实时回调 */
    async streamTurn(
        conversationId: string,
        request: AiTurnRequest,
        handlers: TurnStreamHandlers,
        signal: AbortSignal
    ): Promise<TurnOutcome> {
        const response = await this.ctx.net.fetch(
            `/api/v1/ai/conversations/${encodeURIComponent(conversationId)}/turns`,
            {
                method: 'POST',
                headers: { Accept: 'text/event-stream' },
                body: request,
                signal,
            }
        );

        if (!response.ok) throw await toApiError(response);
        if (!response.body) {
            throw new AiApiError('AI_STREAM_MISSING', '服务端没有返回响应流');
        }

        const outcome: TurnOutcome = { finishReason: 'stop', toolCalls: [] };

        await consumeSse(response.body, ({ event, data }) => {
            const payload = safeJson(data);
            if (!payload) return;

            switch (event) {
                case AI_SSE.textDelta: {
                    const delta = typeof payload['delta'] === 'string' ? payload['delta'] : '';
                    if (delta) handlers.onText(delta);
                    return;
                }
                case AI_SSE.toolCall: {
                    const call = normalizeToolCall(payload);
                    if (!call) return;
                    outcome.toolCalls.push(call);
                    handlers.onToolCall(call);
                    return;
                }
                case AI_SSE.usage: {
                    const usage = normalizeUsage(payload);
                    outcome.usage = usage;
                    handlers.onUsage(usage);
                    return;
                }
                case AI_SSE.turnEnd: {
                    const end = normalizeTurnEnd(payload);
                    outcome.finishReason = end.finishReason;
                    handlers.onTurnEnd(end);
                    return;
                }
                case AI_SSE.error: {
                    const error = normalizeError(payload);
                    outcome.error = error;
                    handlers.onError(error);
                    return;
                }
                default:
                    return;
            }
        });

        return outcome;
    }

    // ─────────────────────────── HTTP ───────────────────────────

    private async getJson<T>(path: string): Promise<T> {
        const response = await this.ctx.net.fetch(path, {
            headers: { Accept: 'application/json' },
        });
        return unwrap<T>(response);
    }

    private async sendJson<T>(
        path: string,
        init: { method: 'POST' | 'PATCH' | 'DELETE'; body?: unknown }
    ): Promise<T> {
        const response = await this.ctx.net.fetch(path, {
            method: init.method,
            headers: { Accept: 'application/json' },
            body: init.body,
        });
        return unwrap<T>(response);
    }
}

async function unwrap<T>(response: Response): Promise<T> {
    const envelope = await readEnvelope<T>(response);
    if (!response.ok || envelope?.success === false) {
        throw new AiApiError(
            envelope?.code ?? `HTTP_${response.status}`,
            envelope?.message ?? `请求失败（${response.status}）`,
            response.status
        );
    }
    if (!envelope) {
        throw new AiApiError('INVALID_RESPONSE', '服务端返回了无法解析的响应', response.status);
    }
    return envelope.data as T;
}

async function toApiError(response: Response): Promise<AiApiError> {
    const envelope = await readEnvelope<unknown>(response);
    return new AiApiError(
        envelope?.code ?? `HTTP_${response.status}`,
        envelope?.message ?? `请求失败（${response.status}）`,
        response.status
    );
}

async function readEnvelope<T>(response: Response): Promise<ApiEnvelope<T> | null> {
    try {
        return (await response.json()) as ApiEnvelope<T>;
    } catch {
        return null;
    }
}

// ─────────────────────────── 事件校验 ───────────────────────────

function normalizeToolCall(payload: Record<string, unknown>): AiToolCallEvent | null {
    const id = typeof payload['id'] === 'string' ? payload['id'] : '';
    const name = typeof payload['name'] === 'string' ? payload['name'] : '';
    if (!id || !name) return null;
    return { id, name, arguments: payload['arguments'] ?? {} };
}

function normalizeUsage(payload: Record<string, unknown>): AiUsage {
    return {
        inputTokens: numberOrZero(payload['inputTokens']),
        outputTokens: numberOrZero(payload['outputTokens']),
        cachedTokens:
            numberOrZero(payload['cachedTokens']) > 0
                ? numberOrZero(payload['cachedTokens'])
                : undefined,
    };
}

function normalizeTurnEnd(payload: Record<string, unknown>): AiTurnEndEvent {
    const reason = payload['finishReason'];
    const finishReason: AiFinishReason =
        reason === 'tool_calls' ||
        reason === 'length' ||
        reason === 'cancelled' ||
        reason === 'error'
            ? reason
            : 'stop';
    return {
        turnId: typeof payload['turnId'] === 'string' ? payload['turnId'] : '',
        finishReason,
    };
}

function normalizeError(payload: Record<string, unknown>): AiErrorEvent {
    return {
        code: typeof payload['code'] === 'string' ? payload['code'] : 'AI_ERROR',
        message: typeof payload['message'] === 'string' ? payload['message'] : 'AI 服务异常',
        retryable: payload['retryable'] === true,
    };
}

function safeJson(raw: string): Record<string, unknown> | null {
    try {
        const value = JSON.parse(raw) as unknown;
        return value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function numberOrZero(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
