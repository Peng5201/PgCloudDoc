/**
 * 定时任务 —— 那些「不值得做成接口、但必须有人干」的活。
 *
 * 三件事：
 *   1. 清理过期刷新令牌（否则表会无限膨胀）
 *   2. 清理 Kafka 幂等表的旧记录（只在重试窗口内有意义）
 *   3. 巡检 update 日志，把过长的文档压缩掉（compaction）
 *
 * 全部带分布式锁：多实例部署时同一时刻只有一个实例在跑，
 * 否则 N 个实例同时清理，DB 连接被打满。
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RefreshTokenRepository } from '../auth/refresh-token.repository';
import { YDocStore } from '../../infrastructure/yjs/ydoc-store';
import { LockService } from '../../infrastructure/redis/lock.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AppConfigService } from '../../config/app-config.service';

@Injectable()
export class CleanupTask {
    private readonly logger = new Logger(CleanupTask.name);

    constructor(
        private readonly refreshTokens: RefreshTokenRepository,
        private readonly ydocStore: YDocStore,
        private readonly prisma: PrismaService,
        private readonly lock: LockService,
        private readonly config: AppConfigService
    ) {}

    /** 每小时清一次过期的刷新令牌 */
    @Cron(CronExpression.EVERY_HOUR)
    async purgeExpiredTokens(): Promise<void> {
        await this.lock.withLock('cron:purge-tokens', async () => {
            const removed = await this.refreshTokens.deleteExpired(new Date());
            if (removed > 0) {
                this.logger.log(`清理过期刷新令牌 ${removed} 条`);
            }
        });
    }

    /** 每天清一次 Kafka 幂等表（只保留 7 天） */
    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async purgeProcessedEvents(): Promise<void> {
        await this.lock.withLock('cron:purge-events', async () => {
            const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const result = await this.prisma.processedEvent.deleteMany({
                where: { processedAt: { lt: cutoff } },
            });
            if (result.count > 0) {
                this.logger.log(`清理幂等表记录 ${result.count} 条`);
            }
        });
    }

    /**
     * 每天清一次发件箱：
     *   - 已投递的保留 7 天（排查窗口）
     *   - 失败的保留 30 天（留给人工补发/告警）
     */
    @Cron(CronExpression.EVERY_DAY_AT_4AM)
    async purgeOutbox(): Promise<void> {
        await this.lock.withLock('cron:purge-outbox', async () => {
            const publishedCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const failedCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

            const [published, failed] = await Promise.all([
                this.prisma.outboxEvent.deleteMany({
                    where: { status: 'PUBLISHED', createdAt: { lt: publishedCutoff } },
                }),
                this.prisma.outboxEvent.deleteMany({
                    where: { status: 'FAILED', createdAt: { lt: failedCutoff } },
                }),
            ]);

            const removed = published.count + failed.count;
            if (removed > 0) {
                this.logger.log(`清理发件箱记录 ${removed} 条`);
            }
        });
    }

    /** 每 6 小时巡检一次 update 日志，压缩过长的文档 */
    @Cron(CronExpression.EVERY_6_HOURS)
    async compactLongHistories(): Promise<void> {
        await this.lock.withLock('cron:compact', async () => {
            const threshold = this.config.collab.compactThreshold;

            const rows = await this.prisma.$queryRaw<{ document_id: string; cnt: bigint }[]>`
                SELECT document_id, COUNT(*) AS cnt
                  FROM document_updates
                 GROUP BY document_id
                HAVING COUNT(*) > ${threshold}
                 ORDER BY cnt DESC
                 LIMIT 50
            `;

            if (rows.length === 0) return;

            this.logger.log(`发现 ${rows.length} 个文档需要 compaction`);
            for (const row of rows) {
                const result = await this.ydocStore
                    .compact(row.document_id)
                    .catch((err: unknown) => {
                        this.logger.warn(`compaction 失败 ${row.document_id}：${String(err)}`);
                        return null;
                    });
                if (result && result.before > result.after) {
                    this.logger.log(
                        `compaction ${row.document_id}: ${result.before} → ${result.after}`
                    );
                }
            }
        });
    }
}
