/**
 * 死信消费者 —— 把重试耗尽的事件落到 `audit_logs` 里，方便排查和补发。
 *
 * 死信 topic 之前没有消费者：消息发出去就没人看，等于黑洞。
 * 这里用审计表承载（不需要新表），用事件 id 做幂等。
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumerManagerService } from '../../infrastructure/kafka/consumer-manager.service';
import { KafkaTopic } from '../../infrastructure/kafka/topics';
import { DeadLetterEvent } from '../../infrastructure/kafka/events';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class DeadLetterConsumer implements OnModuleInit {
    private readonly logger = new Logger(DeadLetterConsumer.name);

    constructor(
        private readonly consumers: ConsumerManagerService,
        private readonly prisma: PrismaService
    ) {}

    onModuleInit(): void {
        this.consumers.registerHandler<DeadLetterEvent>(KafkaTopic.DeadLetter, (event) =>
            this.handle(event)
        );
    }

    private async handle(event: DeadLetterEvent): Promise<void> {
        this.logger.error(
            `收到死信：${event.originalTopic} attempts=${event.attempts} error=${event.error}`
        );

        await this.prisma.auditLog.createMany({
            data: [
                {
                    eventId: event.id,
                    userId: null,
                    action: 'kafka.dead_letter',
                    resourceType: event.originalTopic,
                    metadata: {
                        error: event.error,
                        attempts: event.attempts,
                        correlationId: event.correlationId ?? null,
                        payload: event.originalPayload ?? null,
                    } as object,
                },
            ],
            skipDuplicates: true,
        });
    }
}
