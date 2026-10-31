/**
 * 快照归档 Worker —— Kafka 消费者。
 *
 * 「存档」是重活（物化整个工作簿 + gzip + 写库），
 * 放在请求路径上会把接口拖慢几十毫秒。
 * 所以接口只发个事件就返回，归档由这里异步做 —— 这就是消息队列在本项目里的实际用途。
 *
 * 幂等由 ConsumerManagerService 的 processed_events 表保证：
 * 同一个归档请求被投递两次也不会多出一个版本。
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumerManagerService } from '../../infrastructure/kafka/consumer-manager.service';
import { KafkaTopic } from '../../infrastructure/kafka/topics';
import { DocSnapshotRequestedEvent } from '../../infrastructure/kafka/events';
import { DocumentService } from '../documents/document.service';
import { CollabServer } from '../collab/collab.server';
import { LockService } from '../../infrastructure/redis/lock.service';

@Injectable()
export class SnapshotWorker implements OnModuleInit {
    private readonly logger = new Logger(SnapshotWorker.name);

    constructor(
        private readonly consumers: ConsumerManagerService,
        private readonly documents: DocumentService,
        private readonly collab: CollabServer,
        private readonly lock: LockService
    ) {}

    onModuleInit(): void {
        this.consumers.registerHandler<DocSnapshotRequestedEvent>(
            KafkaTopic.DocSnapshotRequested,
            (event, ctx) => this.handle(event, ctx)
        );
    }

    private async handle(
        event: DocSnapshotRequestedEvent,
        ctx: { attempt: number }
    ): Promise<void> {
        // 自动触发（空闲 / 断线）只刷新快照元数据，不产生版本 ——
        // 版本只由用户显式「保存为版本」创建
        if (event.reason === 'idle') {
            await this.documents.refreshSnapshotMeta(event.documentId);
            this.logger.debug(`文档 ${event.documentId} 已刷新快照（不产生版本）`);
            return;
        }

        this.logger.log(
            `归档文档 ${event.documentId} reason=${event.reason} attempt=${ctx.attempt}`
        );

        // 同一文档的归档串行：并发跑会写出两个只差几毫秒的版本，纯属噪音
        await this.lock.withLock(`archive:${event.documentId}`, async () => {
            const { versionNo, created } = await this.documents.archive(
                event.documentId,
                event.userId,
                `自动归档（${event.reason}）`
            );

            if (!created) {
                // 和上一版内容一致：不新增版本，也不打扰在线用户
                this.logger.debug(`文档 ${event.documentId} 内容未变，跳过归档`);
                return;
            }

            this.logger.log(`文档 ${event.documentId} 归档到版本 ${versionNo}`);
            this.collab.notifySnapshotSaved(event.documentId, versionNo);
        });
    }
}
