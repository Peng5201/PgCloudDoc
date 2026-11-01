/**
 * AI 助手业务。
 *
 * 职责边界：
 *   - 会话 CRUD、文档访问校验、配额、消息持久化；
 *   - 把「一轮用户输入 + 历史」翻译成 Provider 请求；
 *   - 把 Provider 结果翻译成 SSE 与 AiMessage。
 *
 * 工具执行不在这里：它在浏览器插件里，通过文档 API 写入，
 * 这样撤销 / 协同 / 只读约束全部由宿主保证。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
    AI_MAX_TOOL_RESULT_CHARS,
    AI_MAX_TOOLS,
    AI_MAX_TOOLS_CHARS,
    AI_MAX_USER_TEXT_CHARS,
    AI_SSE,
    AI_TOOL_NAME_PATTERN,
    type AiConfigResponse,
    type AiContentBlock,
    type AiConversationDetail,
    type AiConversationSummary,
    type AiDocumentContext,
    type AiMessageDto,
    type AiMessageStatus as DtoMessageStatus,
    type AiToolDefinition,
    type AiToolResult,
    type AiTurnInput,
} from '@pgclouddoc/ai-protocol';
import { AppConfigService } from '../../config/app-config.service';
import {
    AiMessageStatus as DbMessageStatus,
    type AiConversation,
    type AiMessage,
} from '../../infrastructure/prisma/generated/client';
import { AppError, ErrorCode } from '../../shared/errors/app-error';
import { DocumentService } from '../documents/document.service';
import { AiConfigService } from './ai-config.service';
import { toSseErrorPayload } from './ai.errors';
import { buildSystemPrompt } from './ai.prompt';
import {
    AiConversationRepository,
    blocksOf,
} from './conversation.repository';
import type { AiTurnRequestDto } from './dto/ai.dto';
import { AI_PROVIDER_TOKEN } from './provider/provider.factory';
import type {
    AiProvider,
    AiProviderMessage,
    AiProviderTurnResult,
} from './provider/types';
import { AiQuotaService } from './quota.service';
import type { SseWriter } from './stream/sse';

const DEFAULT_TITLE = '新对话';
const MAX_TITLE_LENGTH = 200;
const MAX_TOOL_DESCRIPTION_LENGTH = 4_000;

const STATUS_TO_DTO: Record<DbMessageStatus, DtoMessageStatus> = {
    COMPLETE: 'complete',
    STREAMING: 'streaming',
    CANCELLED: 'cancelled',
    ERROR: 'error',
    INTERRUPTED: 'interrupted',
};

const FINISH_TO_STATUS: Record<string, DbMessageStatus> = {
    cancelled: DbMessageStatus.CANCELLED,
    error: DbMessageStatus.ERROR,
};

@Injectable()
export class AiService {
    private readonly logger = new Logger(AiService.name);

    constructor(
        private readonly appConfig: AppConfigService,
        private readonly aiConfig: AiConfigService,
        private readonly repository: AiConversationRepository,
        private readonly documents: DocumentService,
        private readonly quota: AiQuotaService,
        @Inject(AI_PROVIDER_TOKEN) private readonly provider: AiProvider
    ) {}

    // ─────────────────────────── 配置 ───────────────────────────

    getConfig(): AiConfigResponse {
        return this.aiConfig.toResponse();
    }

    // ─────────────────────────── 会话 ───────────────────────────

    async createConversation(
        userId: string,
        input: { documentId?: string; title?: string }
    ): Promise<AiConversationSummary> {
        this.aiConfig.assertEnabled();

        const documentId = input.documentId?.trim() || null;
        if (documentId) {
            await this.documents.getAccessibleRow(userId, documentId, 'read');
        }

        const title = normalizeTitle(input.title);
        const row = await this.repository.create({
            userId,
            documentId,
            title,
            provider: this.appConfig.ai.provider,
            model: this.aiConfig.defaultModel,
        });
        return toSummary(row);
    }

    async listConversations(
        userId: string,
        documentId?: string
    ): Promise<AiConversationSummary[]> {
        const rows = await this.repository.list(userId, documentId?.trim() || undefined);
        return rows.map(toSummary);
    }

    async getConversation(userId: string, id: string): Promise<AiConversationDetail> {
        const row = await this.repository.findOwnedWithMessages(userId, id);
        if (!row) throw AppError.notFound('对话不存在');
        if (row.documentId) await this.assertDocumentAccess(userId, row.documentId);

        // 仓储按 seq 倒序取最近 N 条，这里翻回时间顺序
        return {
            ...toSummary(row),
            messages: [...row.messages].reverse().map(toMessageDto),
        };
    }

    async renameConversation(userId: string, id: string, title: string): Promise<AiConversationSummary> {
        const normalized = normalizeTitle(title);
        const updated = await this.repository.rename(userId, id, normalized);
        if (!updated) throw AppError.notFound('对话不存在');

        const row = await this.repository.findOwned(userId, id);
        if (!row) throw AppError.notFound('对话不存在');
        return toSummary(row);
    }

    async deleteConversation(userId: string, id: string): Promise<void> {
        const removed = await this.repository.softDelete(userId, id);
        if (!removed) throw AppError.notFound('对话不存在');
    }

    // ─────────────────────────── 一轮对话 ───────────────────────────

    async runTurn(
        userId: string,
        conversationId: string,
        dto: AiTurnRequestDto,
        writer: SseWriter,
        clientSignal: AbortSignal
    ): Promise<void> {
        this.aiConfig.assertEnabled();

        const conversation = await this.repository.findOwned(userId, conversationId);
        if (!conversation) throw AppError.notFound('对话不存在');
        if (conversation.documentId) {
            await this.assertDocumentAccess(userId, conversation.documentId);
        }

        await this.quota.assertWithinLimit(userId);

        const input = normalizeTurnInput(dto.input, this.appConfig.ai.maxToolCallsPerTurn);
        const tools = normalizeTools(dto.tools);
        const context = normalizeContext(dto.context, this.appConfig.ai.contextMaxChars);
        this.assertContextMatches(conversation, context);
        const model = this.aiConfig.resolveModel(dto.model ?? conversation.model);

        const history = await this.repository.recentMessages(conversationId);
        const steps = countToolSteps(history);
        if (input.type === 'tool_results' && steps >= this.appConfig.ai.maxStepsPerConversation) {
            throw AppError.badRequest('工具调用步数超过上限，请重新提问');
        }

        // 1. 落用户输入（工具结果也作为一条 user 消息保存，便于恢复与审计）
        await this.repository.appendMessage({
            conversationId,
            role: 'USER',
            blocks: inputToBlocks(input),
            status: DbMessageStatus.COMPLETE,
        });

        // 首条用户消息顺便给会话起个可读标题（不阻塞失败）
        if (conversation.title === DEFAULT_TITLE && input.type === 'user') {
            await this.repository
                .rename(userId, conversationId, titleFromMessage(input.text))
                .catch(() => undefined);
        }

        const rows = await this.repository.recentMessages(conversationId);
        const providerMessages = sanitizeHistory(
            trimHistory(
                rows
                    .map(toProviderMessage)
                    .filter((message) => message.blocks.length > 0),
                this.appConfig.ai.historyMaxChars
            )
        );

        // 2. 开始 SSE。此前所有校验失败都会走统一 JSON 错误响应
        const turnId = randomUUID();
        writer.send(AI_SSE.turnStart, { turnId, model });

        const abort = new AbortController();
        const onClientAbort = (): void => abort.abort();
        if (clientSignal.aborted) abort.abort();
        else clientSignal.addEventListener('abort', onClientAbort, { once: true });

        let streamedText = '';

        try {
            const result = await this.provider.streamTurn(
                {
                    model,
                    system: buildSystemPrompt(context),
                    messages: providerMessages,
                    tools,
                    maxTokens: this.appConfig.ai.maxOutputTokens,
                },
                {
                    onText: (delta) => {
                        streamedText += delta;
                        writer.send(AI_SSE.textDelta, { delta });
                    },
                },
                abort.signal
            );

            const toolUseCount = result.blocks.filter(
                (block) => block.type === 'tool_use'
            ).length;
            if (toolUseCount > this.appConfig.ai.maxToolCallsPerTurn) {
                throw new AppError(
                    ErrorCode.DEPENDENCY_FAILED,
                    `模型一次请求了 ${toolUseCount} 个工具，超过上限 ${this.appConfig.ai.maxToolCallsPerTurn}`
                );
            }

            this.emitToolCalls(writer, result);
            if (result.usage.inputTokens > 0 || result.usage.outputTokens > 0) {
                writer.send(AI_SSE.usage, result.usage);
            }

            await this.repository.appendMessage({
                conversationId,
                role: 'ASSISTANT',
                blocks: result.blocks.length > 0 ? result.blocks : textBlocks(streamedText),
                status: FINISH_TO_STATUS[result.finishReason] ?? DbMessageStatus.COMPLETE,
                usage: result.usage,
            });
            await this.quota.record(userId, totalTokens(result.usage));

            writer.send(AI_SSE.turnEnd, { turnId, finishReason: result.finishReason });
        } catch (err) {
            this.logger.warn(
                `AI turn 失败（conversation=${conversationId}）：${
                    err instanceof Error ? err.message : String(err)
                }`
            );

            // 已生成的部分内容也要落库，刷新后用户还能看到
            await this.repository
                .appendMessage({
                    conversationId,
                    role: 'ASSISTANT',
                    blocks: textBlocks(streamedText),
                    status: DbMessageStatus.ERROR,
                })
                .catch(() => undefined);

            const payload = toSseErrorPayload(err);
            writer.send(AI_SSE.error, { ...payload, retryable: false });
            writer.send(AI_SSE.turnEnd, { turnId, finishReason: 'error' });
        } finally {
            clientSignal.removeEventListener('abort', onClientAbort);
        }
    }

    // ─────────────────────────── 内部 ───────────────────────────

    private async assertDocumentAccess(userId: string, documentId: string): Promise<void> {
        try {
            await this.documents.getAccessibleRow(userId, documentId, 'read');
        } catch (err) {
            if (err instanceof AppError && err.code === ErrorCode.NOT_FOUND) {
                throw AppError.forbidden('你已无法访问该文档，无法继续此对话');
            }
            throw err;
        }
    }

    private assertContextMatches(
        conversation: AiConversation,
        context: AiDocumentContext
    ): void {
        if (conversation.documentId && context.documentId !== conversation.documentId) {
            throw AppError.badRequest('文档上下文与对话不匹配');
        }
    }

    private emitToolCalls(writer: SseWriter, result: AiProviderTurnResult): void {
        for (const block of result.blocks) {
            if (block.type !== 'tool_use') continue;
            writer.send(AI_SSE.toolCall, {
                id: block.id,
                name: block.name,
                arguments: block.input,
            });
        }
    }
}

// ─────────────────────────── 输入校验 ───────────────────────────

function normalizeTitle(title: string | undefined): string {
    const normalized = title?.trim() || DEFAULT_TITLE;
    return normalized.slice(0, MAX_TITLE_LENGTH);
}

/** 用首条用户消息生成会话标题 */
function titleFromMessage(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.slice(0, 40) || DEFAULT_TITLE;
}

function normalizeTurnInput(
    input: AiTurnRequestDto['input'],
    maxToolCalls: number
): AiTurnInput {
    if (input.type === 'user') {
        const text = (input.text ?? '').trim();
        if (!text) throw AppError.validation('消息不能为空');
        if (text.length > AI_MAX_USER_TEXT_CHARS) {
            throw AppError.validation(`消息过长（最多 ${AI_MAX_USER_TEXT_CHARS} 字符）`);
        }
        return { type: 'user', text };
    }

    const results = input.results ?? [];
    if (results.length === 0) throw AppError.validation('工具结果不能为空');
    if (results.length > maxToolCalls) {
        throw AppError.validation(`单轮工具结果最多 ${maxToolCalls} 条`);
    }
    return { type: 'tool_results', results: results.map(normalizeToolResult) };
}

function normalizeToolResult(raw: unknown, index: number): AiToolResult {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw AppError.validation(`第 ${index + 1} 个工具结果格式不正确`);
    }
    const record = raw as Record<string, unknown>;
    const toolCallId = typeof record['toolCallId'] === 'string' ? record['toolCallId'] : '';
    const name = typeof record['name'] === 'string' ? record['name'] : '';

    if (!toolCallId || toolCallId.length > 128) {
        throw AppError.validation(`第 ${index + 1} 个工具结果缺少 toolCallId`);
    }
    if (!AI_TOOL_NAME_PATTERN.test(name)) {
        throw AppError.validation(`第 ${index + 1} 个工具结果的名字不合法`);
    }

    if (record['ok'] !== true) {
        const error = record['error'] as { code?: unknown; message?: unknown } | undefined;
        return {
            toolCallId,
            name,
            ok: false,
            error: {
                code: typeof error?.code === 'string' ? error.code.slice(0, 64) : 'TOOL_ERROR',
                message:
                    typeof error?.message === 'string'
                        ? error.message.slice(0, 2_000)
                        : '工具执行失败',
            },
        };
    }

    return {
        toolCallId,
        name,
        ok: true,
        result: truncateResult(record['result']),
    };
}

/** 工具结果过大时只保留一个可读预览，避免把上下文直接撑爆 */
function truncateResult(value: unknown): unknown {
    if (value === undefined) return null;
    let serialized: string | undefined;
    try {
        serialized = JSON.stringify(value);
    } catch {
        return { truncated: true, note: '结果不可序列化' };
    }
    if (!serialized) return null;
    if (serialized.length <= AI_MAX_TOOL_RESULT_CHARS) return value;
    return {
        truncated: true,
        note: '工具结果过大，已截断',
        preview: serialized.slice(0, AI_MAX_TOOL_RESULT_CHARS),
    };
}

function normalizeTools(raw: unknown[]): AiToolDefinition[] {
    if (raw.length > AI_MAX_TOOLS) {
        throw AppError.validation(`单轮最多携带 ${AI_MAX_TOOLS} 个工具`);
    }

    const names = new Set<string>();
    const tools: AiToolDefinition[] = [];

    for (const [index, item] of raw.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw AppError.validation(`第 ${index + 1} 个工具定义格式不正确`);
        }
        const record = item as Record<string, unknown>;
        const name = typeof record['name'] === 'string' ? record['name'] : '';
        const description = typeof record['description'] === 'string' ? record['description'] : '';
        const parameters = record['parameters'];

        if (!AI_TOOL_NAME_PATTERN.test(name)) {
            throw AppError.validation(`第 ${index + 1} 个工具名字不合法：${name}`);
        }
        if (names.has(name)) throw AppError.validation(`工具名重复：${name}`);
        if (description.length > MAX_TOOL_DESCRIPTION_LENGTH) {
            throw AppError.validation(`工具 ${name} 的描述过长`);
        }
        if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
            throw AppError.validation(`工具 ${name} 缺少 parameters`);
        }

        names.add(name);
        tools.push({ name, description, parameters: parameters as Record<string, unknown> });
    }

    if (JSON.stringify(tools).length > AI_MAX_TOOLS_CHARS) {
        throw AppError.validation('工具定义总长度超过上限');
    }
    return tools;
}

function normalizeContext(
    raw: Record<string, unknown>,
    maxChars: number
): AiDocumentContext {
    const serialized = JSON.stringify(raw);
    if (serialized.length > maxChars) {
        throw AppError.validation(`文档上下文超过上限（${maxChars} 字符）`);
    }
    if (typeof raw['documentId'] !== 'string' || !raw['documentId']) {
        throw AppError.validation('文档上下文缺少 documentId');
    }
    return raw as unknown as AiDocumentContext;
}

// ─────────────────────────── 历史装配 ───────────────────────────

function toProviderMessage(row: AiMessage): AiProviderMessage {
    return {
        role: row.role === 'ASSISTANT' ? 'assistant' : 'user',
        blocks: blocksOf(row.content),
    };
}

/**
 * 历史预算：从最新消息往前保留，超出 maxChars 就丢弃更早的。
 * 至少保留最后一条（本轮输入），否则这一轮没有用户消息可发。
 */
function trimHistory(
    messages: AiProviderMessage[],
    maxChars: number
): AiProviderMessage[] {
    let total = 0;
    const kept: AiProviderMessage[] = [];

    for (let index = messages.length - 1; index >= 0; index--) {
        const size = JSON.stringify(messages[index]).length;
        if (kept.length > 0 && total + size > maxChars) break;
        total += size;
        kept.unshift(messages[index]);
    }

    return kept;
}

/**
 * 清理不完整的历史。
 *
 * 客户端在「模型给出 tool_use 之后、工具结果回传之前」关闭面板时，
 * 会留下没有 tool_result 的 tool_use。Anthropic 协议不允许这种配对，
 * 直接发出去整轮都会 400，所以装配前把它们剔除。
 */
function sanitizeHistory(messages: AiProviderMessage[]): AiProviderMessage[] {
    const result: AiProviderMessage[] = [];

    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message.role === 'assistant') {
            const toolUses = message.blocks.filter(
                (block): block is Extract<AiContentBlock, { type: 'tool_use' }> =>
                    block.type === 'tool_use'
            );
            if (toolUses.length === 0) {
                result.push(message);
                continue;
            }

            const next = messages[index + 1];
            const available = new Set(
                next?.role === 'user'
                    ? next.blocks
                          .filter((block) => block.type === 'tool_result')
                          .map((block) => (block as { toolUseId: string }).toolUseId)
                    : []
            );

            const keptBlocks = message.blocks.filter(
                (block) => block.type !== 'tool_use' || available.has(block.id)
            );
            if (keptBlocks.some((block) => block.type !== 'text' || block.text.length > 0)) {
                result.push({ role: 'assistant', blocks: keptBlocks });
            }
            continue;
        }

        // user 消息：丢掉找不到对应 tool_use 的 tool_result
        if (message.blocks.some((block) => block.type === 'tool_result')) {
            const lastAssistant = [...result].reverse().find((item) => item.role === 'assistant');
            const allowed = new Set(
                lastAssistant?.blocks
                    .filter(
                        (block): block is Extract<AiContentBlock, { type: 'tool_use' }> =>
                            block.type === 'tool_use'
                    )
                    .map((block) => block.id) ?? []
            );
            const kept = message.blocks.filter(
                (block) => block.type !== 'tool_result' || allowed.has(block.toolUseId)
            );
            if (kept.length > 0) result.push({ role: 'user', blocks: kept });
            continue;
        }

        result.push(message);
    }

    // Anthropic 要求第一条是 user
    while (result.length > 0 && result[0].role === 'assistant') result.shift();
    return result;
}

function countToolSteps(messages: AiMessage[]): number {
    let steps = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
        const blocks = blocksOf(messages[index].content);
        const isToolResult =
            messages[index].role === 'USER' && blocks.some((block) => block.type === 'tool_result');
        if (!isToolResult) break;
        steps++;
    }
    return steps;
}

function inputToBlocks(input: AiTurnInput): AiContentBlock[] {
    if (input.type === 'user') return [{ type: 'text', text: input.text }];
    return input.results.map((result) => ({
        type: 'tool_result' as const,
        toolUseId: result.toolCallId,
        ok: result.ok,
        content: toolResultText(result),
    }));
}

function toolResultText(result: AiToolResult): string {
    const payload = result.ok
        ? { ok: true, result: result.result ?? null }
        : { ok: false, error: result.error ?? { code: 'TOOL_ERROR', message: '工具执行失败' } };

    const serialized = JSON.stringify(payload);
    return serialized.length <= AI_MAX_TOOL_RESULT_CHARS
        ? serialized
        : `${serialized.slice(0, AI_MAX_TOOL_RESULT_CHARS)}…`;
}

function textBlocks(text: string): AiContentBlock[] {
    return text ? [{ type: 'text', text }] : [];
}

// ─────────────────────────── 映射 ───────────────────────────

function toSummary(row: AiConversation): AiConversationSummary {
    return {
        id: row.id,
        title: row.title,
        documentId: row.documentId,
        model: row.model,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

function toMessageDto(row: AiMessage): AiMessageDto {
    const usage =
        row.inputTokens !== null || row.outputTokens !== null
            ? {
                  inputTokens: row.inputTokens ?? 0,
                  outputTokens: row.outputTokens ?? 0,
                  cachedTokens: row.cachedTokens ?? undefined,
              }
            : undefined;

    return {
        id: row.id,
        role: row.role === 'ASSISTANT' ? 'assistant' : 'user',
        blocks: blocksOf(row.content),
        status: STATUS_TO_DTO[row.status],
        createdAt: row.createdAt.toISOString(),
        usage,
    };
}

function totalTokens(usage: { inputTokens: number; outputTokens: number }): number {
    return usage.inputTokens + usage.outputTokens;
}
