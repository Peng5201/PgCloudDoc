/**
 * 站内消息服务。
 *
 * 消息一旦创建就持久化（离线也能回看），同时通过网关实时推送给在线用户。
 * 左下角弹框组件消费两份数据：REST 拉历史 + WebSocket 收增量。
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { NotificationGateway } from './notification.gateway';

export interface CreateNotificationInput {
    userId: string;
    type: string;
    title: string;
    body?: string;
    payload?: Record<string, unknown>;
}

/** 推给前端 / 返回给 REST 的序列化形态（Date → ISO 字符串） */
export interface NotificationDto {
    id: string;
    type: string;
    title: string;
    body: string | null;
    payload: unknown;
    read: boolean;
    createdAt: string;
}

@Injectable()
export class NotificationService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly gateway: NotificationGateway
    ) {}

    /** 创建一条消息：落库 + 实时推给在线连接 */
    async create(input: CreateNotificationInput): Promise<NotificationDto> {
        const row = await this.prisma.notification.create({
            data: {
                userId: input.userId,
                type: input.type,
                title: input.title,
                body: input.body ?? null,
                payload: (input.payload ?? undefined) as object,
            },
        });

        const dto = toDto(row);
        // 推送失败不影响主流程（消息已落库，用户刷新/下次进页面能拉到）
        void this.gateway.push(input.userId, dto).catch(() => undefined);
        return dto;
    }

    async list(userId: string, limit = 30): Promise<NotificationDto[]> {
        const rows = await this.prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
        return rows.map(toDto);
    }

    async unreadCount(userId: string): Promise<number> {
        return this.prisma.notification.count({
            where: { userId, readAt: null },
        });
    }

    /** 标记指定消息已读（只允许动自己的消息） */
    async markRead(userId: string, ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        await this.prisma.notification.updateMany({
            where: { id: { in: ids }, userId, readAt: null },
            data: { readAt: new Date() },
        });
    }

    async markAllRead(userId: string): Promise<void> {
        await this.prisma.notification.updateMany({
            where: { userId, readAt: null },
            data: { readAt: new Date() },
        });
    }
}

function toDto(row: {
    id: string;
    type: string;
    title: string;
    body: string | null;
    payload: unknown;
    readAt: Date | null;
    createdAt: Date;
}): NotificationDto {
    return {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        payload: row.payload,
        read: row.readAt !== null,
        createdAt: row.createdAt.toISOString(),
    };
}
