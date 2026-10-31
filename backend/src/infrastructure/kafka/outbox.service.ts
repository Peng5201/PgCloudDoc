/**
 * 事务性发件箱（Outbox）写入端。
 *
 * 业务代码不再直接调 Kafka：先把事件写进 `outbox_events`（可与业务写库同事务），
 * 再由 `OutboxDispatcher` 异步投递。好处：
 *
 *   1. **不丢事件**：Kafka 不可用时消息留在表里，恢复后自动补发
 *   2. **与业务写库同事务**：业务提交成功则事件一定留下（传 `tx` 即可）
 *   3. **削峰**：请求路径只做一次 INSERT，不等 Kafka 往返
 *
 * 注意：发件箱保证 at-least-once，消费端必须幂等（见 ConsumerManagerService）。
 */

import { Injectable } from '@nestjs/common';
import type { Prisma } from '../prisma/generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../../config/app-config.service';
import { RequestContextStore } from '../../shared/context/request-context';
import { buildEventEnvelope, type EventByTopic } from './events';

/** 可以传入事务客户端，让事件与业务写库原子提交 */
export type OutboxClient = Prisma.TransactionClient | PrismaService;

@Injectable()
export class OutboxService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly config: AppConfigService
    ) {}

    /**
     * 把事件写进发件箱。
     *
     * @param tx 传入业务事务时，事件与业务数据同生共死
     * @returns 事件 id（也就是 outbox 行 id）
     */
    async enqueue<K extends keyof EventByTopic>(
        topic: K,
        event: Omit<EventByTopic[K], 'id' | 'occurredAt' | 'topic' | 'schemaVersion'> & {
            id?: string;
            schemaVersion?: number;
        },
        key?: string,
        tx?: OutboxClient
    ): Promise<string> {
        const requestId = RequestContextStore.getRequestId();
        const envelope = buildEventEnvelope<EventByTopic[K]>(
            topic,
            event as unknown as Record<string, unknown>,
            `${this.config.kafka.clientId}@${process.pid}`,
            requestId === '-' ? undefined : requestId
        );

        const client = tx ?? this.prisma;
        // JSON 序列化一遍：去掉 undefined 字段，避免 Prisma Json 写入报错
        const payload = JSON.parse(JSON.stringify(envelope)) as Prisma.InputJsonValue;

        await client.outboxEvent.create({
            data: {
                id: envelope.id,
                topic,
                eventKey: key ?? null,
                payload,
            },
        });

        return envelope.id;
    }
}
