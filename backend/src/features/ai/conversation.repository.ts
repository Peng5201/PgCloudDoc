/**
 * AI 会话仓储。
 *
 * 所有查询都以 userId 为第一过滤条件：会话是用户私有数据，
 * 文档绑定只影响上下文与访问校验，不改变归属。
 */

import { Injectable } from '@nestjs/common';
import type { AiContentBlock, AiUsage } from '@pgclouddoc/ai-protocol';
import {
    AiMessageStatus,
    Prisma,
    type AiConversation,
    type AiMessage,
} from '../../infrastructure/prisma/generated/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** 单次装配上下文 / 返回详情时的消息上限，防止超长会话拖垮请求 */
const MAX_MESSAGES = 200;

export interface AppendMessageInput {
    conversationId: string;
    role: 'USER' | 'ASSISTANT';
    blocks: AiContentBlock[];
    status: AiMessageStatus;
    usage?: AiUsage;
}

@Injectable()
export class AiConversationRepository {
    constructor(private readonly prisma: PrismaService) {}

    create(input: {
        userId: string;
        documentId: string | null;
        title: string;
        provider: string;
        model: string;
    }): Promise<AiConversation> {
        return this.prisma.aiConversation.create({
            data: {
                userId: input.userId,
                documentId: input.documentId,
                title: input.title,
                provider: input.provider,
                model: input.model,
            },
        });
    }

    findOwned(userId: string, id: string): Promise<AiConversation | null> {
        return this.prisma.aiConversation.findFirst({
            where: { id, userId, deletedAt: null },
        });
    }

    findOwnedWithMessages(
        userId: string,
        id: string
    ): Promise<(AiConversation & { messages: AiMessage[] }) | null> {
        return this.prisma.aiConversation.findFirst({
            where: { id, userId, deletedAt: null },
            include: {
                // 只取最近 N 条；按 seq 倒序取完再翻回来，避免大 offset
                messages: { orderBy: { seq: 'desc' }, take: MAX_MESSAGES },
            },
        });
    }

    list(userId: string, documentId?: string): Promise<AiConversation[]> {
        return this.prisma.aiConversation.findMany({
            where: {
                userId,
                deletedAt: null,
                ...(documentId ? { documentId } : {}),
            },
            orderBy: { updatedAt: 'desc' },
            take: 50,
        });
    }

    async rename(userId: string, id: string, title: string): Promise<boolean> {
        const result = await this.prisma.aiConversation.updateMany({
            where: { id, userId, deletedAt: null },
            data: { title },
        });
        return result.count > 0;
    }

    async softDelete(userId: string, id: string): Promise<boolean> {
        const result = await this.prisma.aiConversation.updateMany({
            where: { id, userId, deletedAt: null },
            data: { deletedAt: new Date() },
        });
        return result.count > 0;
    }

    /** 消息列表按 seq 升序；DB 里按倒序取最近 N 条后再翻转 */
    async recentMessages(conversationId: string): Promise<AiMessage[]> {
        const rows = await this.prisma.aiMessage.findMany({
            where: { conversationId },
            orderBy: { seq: 'desc' },
            take: MAX_MESSAGES,
        });
        return rows.reverse();
    }

    /**
     * 追加消息。
     *
     * seq 由 (max + 1) 计算；同一会话并发两轮时可能撞唯一索引，
     * 捕获 P2002 重算一次即可（客户端本身也会串行化工具循环）。
     */
    async appendMessage(input: AppendMessageInput): Promise<AiMessage> {
        for (let attempt = 0; attempt < 3; attempt++) {
            const max = await this.prisma.aiMessage.aggregate({
                where: { conversationId: input.conversationId },
                _max: { seq: true },
            });
            const seq = (max._max.seq ?? 0) + 1;

            try {
                const message = await this.prisma.aiMessage.create({
                    data: {
                        conversationId: input.conversationId,
                        seq,
                        role: input.role,
                        content: {
                            blocks: input.blocks,
                        } as unknown as Prisma.InputJsonValue,
                        status: input.status,
                        inputTokens: input.usage?.inputTokens,
                        outputTokens: input.usage?.outputTokens,
                        cachedTokens: input.usage?.cachedTokens,
                    },
                });
                await this.prisma.aiConversation.update({
                    where: { id: input.conversationId },
                    data: { updatedAt: new Date() },
                });
                return message;
            } catch (err) {
                if (isUniqueConflict(err) && attempt < 2) continue;
                throw err;
            }
        }
        // 三次都撞：属于异常并发，直接把错误抛给上层
        throw new Error('AI 消息序号分配失败');
    }
}

export function blocksOf(content: Prisma.JsonValue): AiContentBlock[] {
    if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
    const blocks = (content as { blocks?: unknown }).blocks;
    return Array.isArray(blocks) ? (blocks as AiContentBlock[]) : [];
}

function isUniqueConflict(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
