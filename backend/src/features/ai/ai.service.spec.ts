/**
 * AiService 的一轮流程：用户消息落库 → 调 Provider → SSE 事件 → 助手消息落库。
 *
 * 不依赖数据库/Redis：仓储、配额、文档服务都用最小 fake。
 */

import type { AiToolDefinition } from '@pgclouddoc/ai-protocol';
import type { AppConfigService } from '../../config/app-config.service';

// Nest 12 是纯 ESM，jest 30 / Node 22 的 require 装不进来；
// 这里只用到装饰器元数据，stub 掉即可。真正的装配由 smoke 测试覆盖。
jest.mock('@nestjs/common', () => ({
    Injectable: () => (target: unknown) => target,
    Inject: () => () => undefined,
    Logger: class {
        warn(): void {}
        log(): void {}
        error(): void {}
        debug(): void {}
    },
}));

// 生成代码是 NodeNext 的 .js 后缀导入，测试里不需要真的连 Prisma
jest.mock('../../infrastructure/prisma/generated/client', () => ({
    AiMessageStatus: {
        COMPLETE: 'COMPLETE',
        STREAMING: 'STREAMING',
        CANCELLED: 'CANCELLED',
        ERROR: 'ERROR',
        INTERRUPTED: 'INTERRUPTED',
    },
}));

// 协议包是纯 ESM（exports 只有 import），jest 编译成 CJS 后 require 不进去。
// 测试只需要其中几个常量。
jest.mock(
    '@pgclouddoc/ai-protocol',
    () => ({
        AI_SSE: {
            turnStart: 'turn_start',
            textDelta: 'text_delta',
            toolCall: 'tool_call',
            usage: 'usage',
            turnEnd: 'turn_end',
            error: 'error',
        },
        AI_TOOL_NAME_PATTERN: /^[a-z][a-z0-9_]{0,63}$/,
        AI_MAX_TOOL_RESULT_CHARS: 32_768,
        AI_MAX_TOOLS: 32,
        AI_MAX_TOOLS_CHARS: 65_536,
        AI_MAX_USER_TEXT_CHARS: 32_000,
    }),
    { virtual: true }
);

jest.mock('./conversation.repository', () => ({
    AiConversationRepository: class {},
    blocksOf: (content: unknown): unknown[] => {
        const value = content as { blocks?: unknown } | null;
        return value && typeof value === 'object' && Array.isArray(value.blocks)
            ? value.blocks
            : [];
    },
}));

// emitDecoratorMetadata 会把构造参数类型也带进运行时，
// 这几个模块只是为了元数据存在，测试里不需要加载它们的真实依赖。
jest.mock('../../config/app-config.service', () => ({ AppConfigService: class {} }));
jest.mock('../documents/document.service', () => ({ DocumentService: class {} }));
jest.mock('./quota.service', () => ({ AiQuotaService: class {} }));

import {
    AiMessageStatus,
    type AiConversation,
    type AiMessage,
} from '../../infrastructure/prisma/generated/client';
import { AiConfigService } from './ai-config.service';
import { AiService } from './ai.service';
import type {
    AiConversationRepository,
    AppendMessageInput,
} from './conversation.repository';
import type { AiTurnRequestDto } from './dto/ai.dto';
import type { DocumentService } from '../documents/document.service';
import type { AiProvider, AiProviderTurnInput } from './provider/types';
import type { AiQuotaService } from './quota.service';
import type { SseWriter } from './stream/sse';

class FakeRepository {
    messages: AiMessage[] = [];
    private nextId = 0;

    async findOwned(): Promise<AiConversation> {
        return {
            id: 'conv-1',
            userId: 'user-1',
            documentId: null,
            title: '测试对话',
            provider: 'mock',
            model: 'deepseek-v4-flash',
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
        };
    }

    async appendMessage(input: AppendMessageInput): Promise<AiMessage> {
        this.nextId += 1;
        const message = {
            id: `msg-${this.nextId}`,
            conversationId: input.conversationId,
            seq: this.nextId,
            role: input.role,
            content: { blocks: input.blocks },
            status: input.status,
            inputTokens: input.usage?.inputTokens ?? null,
            outputTokens: input.usage?.outputTokens ?? null,
            cachedTokens: input.usage?.cachedTokens ?? null,
            createdAt: new Date(),
        } as unknown as AiMessage;
        this.messages.push(message);
        return message;
    }

    async recentMessages(): Promise<AiMessage[]> {
        return [...this.messages];
    }

    async rename(): Promise<boolean> {
        return true;
    }
}

class FakeWriter implements SseWriter {
    started = false;
    closed = false;
    readonly events: Array<{ event: string; data: unknown }> = [];

    send(event: string, data: unknown): void {
        this.started = true;
        this.events.push({ event, data });
    }

    comment(): void {
        // no-op
    }

    end(): void {
        this.closed = true;
    }
}

function createAppConfig(): AppConfigService {
    return {
        ai: {
            enabled: true,
            provider: 'mock',
            baseUrl: '',
            apiKey: '',
            model: 'deepseek-v4-flash',
            models: ['deepseek-v4-flash'],
            maxOutputTokens: 2_048,
            requestTimeoutMs: 5_000,
            dailyTokenLimit: 0,
            maxToolCallsPerTurn: 8,
            maxStepsPerConversation: 20,
            contextMaxChars: 60_000,
            historyMaxChars: 240_000,
            conversationTtlDays: 30,
        },
    } as unknown as AppConfigService;
}

function createDocuments(): DocumentService {
    return {
        getAccessibleRow: async () => ({ row: {}, role: 'OWNER' }),
    } as unknown as DocumentService;
}

function createQuota(): AiQuotaService {
    return {
        assertWithinLimit: async () => undefined,
        record: async () => undefined,
    } as unknown as AiQuotaService;
}

describe('AiService.runTurn', () => {
    it('把输入与模型输出落库，并按顺序发出 SSE 事件', async () => {
        const repository = new FakeRepository();
        const writer = new FakeWriter();
        const config = createAppConfig();

        const inputs: AiProviderTurnInput[] = [];
        const provider: AiProvider = {
            name: 'mock',
            async streamTurn(input, handlers) {
                inputs.push(input);
                handlers.onText('你好');
                return {
                    blocks: [
                        { type: 'text', text: '你好' },
                        {
                            type: 'tool_use',
                            id: 'call-1',
                            name: 'read_range',
                            input: { range: 'A1' },
                        },
                    ],
                    finishReason: 'tool_calls',
                    usage: { inputTokens: 3, outputTokens: 2 },
                };
            },
        };

        const service = new AiService(
            config,
            new AiConfigService(config),
            repository as unknown as AiConversationRepository,
            createDocuments(),
            createQuota(),
            provider
        );

        const dto = {
            requestId: 'req-1',
            input: { type: 'user', text: 'hi' },
            context: { documentId: 'doc-1', title: '测试' },
            tools: [] as AiToolDefinition[],
        } as unknown as AiTurnRequestDto;

        await service.runTurn(
            'user-1',
            'conv-1',
            dto,
            writer,
            new AbortController().signal
        );

        expect(writer.events.map((event) => event.event)).toEqual([
            'turn_start',
            'text_delta',
            'tool_call',
            'usage',
            'turn_end',
        ]);
        expect(writer.events.find((event) => event.event === 'tool_call')?.data).toEqual({
            id: 'call-1',
            name: 'read_range',
            arguments: { range: 'A1' },
        });

        expect(repository.messages).toHaveLength(2);
        expect(repository.messages[0]?.role).toBe('USER');
        expect(repository.messages[1]?.role).toBe('ASSISTANT');
        expect(repository.messages[1]?.status).toBe(AiMessageStatus.COMPLETE);

        // Provider 收到的是「系统提示词 + 刚写入的用户消息」
        expect(inputs[0]?.system).toContain('<document_context>');
        expect(inputs[0]?.messages[0]?.blocks).toEqual([{ type: 'text', text: 'hi' }]);
        expect(inputs[0]?.model).toBe('deepseek-v4-flash');
    });

    it('Provider 抛错时发出 error + turn_end，并把助手消息标记为 ERROR', async () => {
        const repository = new FakeRepository();
        const writer = new FakeWriter();
        const config = createAppConfig();

        const provider: AiProvider = {
            name: 'mock',
            async streamTurn(_input, handlers) {
                handlers.onText('部分输出');
                throw new Error('upstream down');
            },
        };

        const service = new AiService(
            config,
            new AiConfigService(config),
            repository as unknown as AiConversationRepository,
            createDocuments(),
            createQuota(),
            provider
        );

        await service.runTurn(
            'user-1',
            'conv-1',
            {
                requestId: 'req-2',
                input: { type: 'user', text: 'hi' },
                context: { documentId: 'doc-1' },
                tools: [],
            } as unknown as AiTurnRequestDto,
            writer,
            new AbortController().signal
        );

        expect(writer.events.map((event) => event.event)).toEqual([
            'turn_start',
            'text_delta',
            'error',
            'turn_end',
        ]);
        expect(repository.messages[1]?.status).toBe(AiMessageStatus.ERROR);
        expect(repository.messages[1]?.content).toEqual({
            blocks: [{ type: 'text', text: '部分输出' }],
        });
    });
});
