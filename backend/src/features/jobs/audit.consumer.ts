/**
 * 审计 Worker —— 把 Kafka 上的用户行为事件落进 audit_logs 表。
 *
 * 为什么走消息队列而不是直接写库：审计是「一定要记，但不着急」的数据。
 * 直接写会把每一次登录/改密码都变成一个同步的 INSERT，
 * 而走队列可以让主流程立刻返回，审计异步落库（还自带重试）。
 *
 * 审计记录本身不可篡改 —— 只插不改不删，用户注销后 userId 置空但记录保留。
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumerManagerService } from '../../infrastructure/kafka/consumer-manager.service';
import { KafkaTopic } from '../../infrastructure/kafka/topics';
import { AuditUserActivityEvent } from '../../infrastructure/kafka/events';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class AuditConsumer implements OnModuleInit {
    private readonly logger = new Logger(AuditConsumer.name);

    constructor(
        private readonly consumers: ConsumerManagerService,
        private readonly prisma: PrismaService
    ) {}

    onModuleInit(): void {
        this.consumers.registerHandler<AuditUserActivityEvent>(
            KafkaTopic.AuditUserActivity,
            (event) => this.handle(event)
        );
    }

    private async handle(event: AuditUserActivityEvent): Promise<void> {
        // 用事件 id 做幂等：at-least-once 下重复投递只落一条
        await this.prisma.auditLog.createMany({
            data: [
                {
                    eventId: event.id,
                    userId: event.userId ?? null,
                    action: event.action,
                    resourceType: event.resourceType ?? null,
                    resourceId: event.resourceId ?? null,
                    ip: event.ip ?? null,
                    userAgent: event.userAgent ? event.userAgent.slice(0, 512) : null,
                    metadata: (event.metadata ?? {}) as object,
                },
            ],
            skipDuplicates: true,
        });
        this.logger.debug(`审计落库 ${event.action}`);
    }
}
