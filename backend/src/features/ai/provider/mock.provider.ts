/**
 * Mock Provider —— 不依赖任何外部服务。
 *
 * 用途：
 *   - 本地开发 / CI 跑通「面板 → SSE → 工具循环」全链路；
 *   - 前端联调时不需要真实 API Key；
 *   - 集成测试里给出确定性的工具调用。
 *
 * 规则：
 *   - 用户消息包含「读」「工具」「表」→ 返回一次 read_range 工具调用；
 *   - 收到 tool_results → 返回一句完成文本；
 *   - 其他情况 → 原样回显用户内容。
 */

import type { AiContentBlock } from '@pgclouddoc/ai-protocol';
import type {
    AiProvider,
    AiProviderHandlers,
    AiProviderTurnInput,
    AiProviderTurnResult,
} from './types';

export class MockProvider implements AiProvider {
    readonly name = 'mock';

    async streamTurn(
        input: AiProviderTurnInput,
        handlers: AiProviderHandlers,
        signal: AbortSignal
    ): Promise<AiProviderTurnResult> {
        if (signal.aborted) {
            return { blocks: [], finishReason: 'cancelled', usage: emptyUsage() };
        }

        const last = [...input.messages].reverse().find((message) => message.role === 'user');
        const blocks = last?.blocks ?? [];
        const hasToolResult = blocks.some((block) => block.type === 'tool_result');
        const text = blocks
            .filter((block): block is Extract<AiContentBlock, { type: 'text' }> => block.type === 'text')
            .map((block) => block.text)
            .join(' ')
            .trim();

        if (hasToolResult) {
            return respond('（mock）已根据工具结果完成。', handlers, signal);
        }

        if (/读|工具|表格|选区/.test(text)) {
            const lead = '我来读取一下当前选区。';
            if (!signal.aborted) handlers.onText(lead);
            return {
                blocks: [
                    { type: 'text', text: lead },
                    {
                        type: 'tool_use',
                        id: `mock_${Date.now()}`,
                        name: 'read_range',
                        input: { range: 'A1:C10' },
                    },
                ],
                finishReason: 'tool_calls',
                usage: { inputTokens: 12, outputTokens: 8 },
            };
        }

        return respond(`（mock）收到：${text.slice(0, 120) || '空消息'}`, handlers, signal);
    }
}

function respond(
    text: string,
    handlers: AiProviderHandlers,
    signal: AbortSignal
): AiProviderTurnResult {
    if (!signal.aborted) handlers.onText(text);
    return {
        blocks: [{ type: 'text', text }],
        finishReason: 'stop',
        usage: { inputTokens: 12, outputTokens: Math.max(1, text.length) },
    };
}

function emptyUsage() {
    return { inputTokens: 0, outputTokens: 0 };
}
