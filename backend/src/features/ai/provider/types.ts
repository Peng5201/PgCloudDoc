/**
 * Provider 无关的内部契约。
 *
 * 网关只认这一套类型；Anthropic / Mock / 未来的 OpenAI-compatible
 * 都在各自适配器里完成两端的翻译。
 */

import type {
    AiContentBlock,
    AiFinishReason,
    AiToolDefinition,
    AiUsage,
} from '@pgclouddoc/ai-protocol';

export interface AiProviderMessage {
    role: 'user' | 'assistant';
    blocks: AiContentBlock[];
}

export interface AiProviderTurnInput {
    model: string;
    system: string;
    messages: AiProviderMessage[];
    tools: AiToolDefinition[];
    maxTokens: number;
}

export interface AiProviderHandlers {
    /** 文本增量。服务端直接转成 SSE text_delta */
    onText(delta: string): void;
}

export interface AiProviderTurnResult {
    /** 有序内容块：text + tool_use */
    blocks: AiContentBlock[];
    finishReason: AiFinishReason;
    usage: AiUsage;
}

export interface AiProvider {
    readonly name: string;
    /**
     * 流式执行一轮模型调用。
     * 客户端断开时通过 `signal` 取消，实现应尽量返回已生成的部分内容。
     */
    streamTurn(
        input: AiProviderTurnInput,
        handlers: AiProviderHandlers,
        signal: AbortSignal
    ): Promise<AiProviderTurnResult>;
}
