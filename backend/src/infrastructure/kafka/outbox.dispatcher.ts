/**
 * 发件箱投递器（Outbox Dispatcher）。
 *
 * 周期性从 `outbox_events` 认领 PENDING 记录并投递到 Kafka。
 *
 * 关键点：
 *   1. **多实例安全**：用 `FOR UPDATE SKIP LOCKED` 认领，天然不会重复领取；
 *      认领后把 `available_at` 推后 60s 当租约，进程崩溃也能在租约过期后重投。
 *   2. **顺序**：同一批按 `created_at` 顺序串行发送，配合 Kafka key 保证同文档有序。
 *   3. **退避**：失败按指数退避重排，超过上限标记 FAILED（人工介入/告警）。
 *   4. **Kafka 恢复后自动接上**：每轮先 `ensureConnected()`。
 */

import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KafkaService } from './kafka.service';

const POLL_INTERVAL_MS = 1_000;
const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 10;

interface ClaimedRow {
    id: string;
    topic: string;
    event_key: string | null;
    payload: unknown;
    attempts: number;
}

@Injectable()
export class OutboxDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(OutboxDispatcher.name);
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private stopped = false;
    /** 连续失败次数：基础设施抖动时退避，避免每秒重试 + 刷日志 */
    private consecutiveFailures = 0;
    private nextAttemptAt = 0;

    constructor(
        private readonly prisma: PrismaService,
        private readonly kafka: KafkaService
    ) {}

    onApplicationBootstrap(): void {
        this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
        this.logger.log(`发件箱投递器已启动（轮询 ${POLL_INTERVAL_MS}ms）`);
    }

    onModuleDestroy(): void {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async tick(): Promise<void> {
        if (this.running || this.stopped || Date.now() < this.nextAttemptAt) return;
        this.running = true;
        try {
            if (!(await this.kafka.ensureConnected())) return;
            await this.dispatchBatch();
            this.consecutiveFailures = 0;
        } catch (err) {
            this.consecutiveFailures += 1;
            const backoff = Math.min(2 ** this.consecutiveFailures * 1_000, 30_000);
            this.nextAttemptAt = Date.now() + backoff;

            // 首次失败和每 10 次提示一次，避免基础设施抖动时刷屏
            if (this.consecutiveFailures === 1 || this.consecutiveFailures % 10 === 0) {
                this.logger.warn(
                    `发件箱投递异常（连续 ${this.consecutiveFailures} 次），${backoff}ms 后重试：${
                        err instanceof Error ? err.message : String(err)
                    }`
                );
            }
        } finally {
            this.running = false;
        }
    }

    private async dispatchBatch(): Promise<void> {
        // 认领：把 available_at 推后当租约，崩溃后租约到期自动重新可领
        const rows = await this.prisma.$queryRaw<ClaimedRow[]>`
            UPDATE "outbox_events"
               SET "available_at" = now() + interval '60 seconds'
             WHERE "id" IN (
               SELECT "id"
                 FROM "outbox_events"
                WHERE "status" = 'PENDING'
                  AND "available_at" <= now()
                ORDER BY "created_at"
                LIMIT 20
                  FOR UPDATE SKIP LOCKED
             )
            RETURNING "id", "topic", "event_key", "payload", "attempts"
        `;

        for (const row of rows) {
            if (this.stopped) break;
            try {
                await this.kafka.sendRaw(row.topic, row.payload, row.event_key ?? undefined);
                await this.prisma.outboxEvent.update({
                    where: { id: row.id },
                    data: {
                        status: 'PUBLISHED',
                        publishedAt: new Date(),
                        attempts: row.attempts + 1,
                        lastError: null,
                    },
                });
            } catch (err) {
                const attempts = row.attempts + 1;
                const failed = attempts >= MAX_ATTEMPTS;
                const backoffMs = Math.min(2 ** attempts * 500, 60_000);
                const message = err instanceof Error ? err.message : String(err);

                await this.prisma.outboxEvent
                    .update({
                        where: { id: row.id },
                        data: {
                            status: failed ? 'FAILED' : 'PENDING',
                            attempts,
                            lastError: message.slice(0, 1000),
                            availableAt: new Date(Date.now() + backoffMs),
                        },
                    })
                    .catch(() => undefined);

                if (failed) {
                    this.logger.error(
                        `发件箱投递失败已达上限，标记 FAILED：${row.topic} ${row.id} / ${message}`
                    );
                } else {
                    this.logger.warn(
                        `发件箱投递失败（${attempts}/${MAX_ATTEMPTS}）：${row.topic} ${row.id}，${backoffMs}ms 后重试`
                    );
                }
                // 同一轮里连续失败通常是 Kafka 抽风，停手等下一轮
                break;
            }
        }

        if (rows.length === BATCH_SIZE) {
            // 可能还有积压，下一轮继续
            this.logger.debug(`发件箱本批已满（${BATCH_SIZE} 条）`);
        }
    }
}
