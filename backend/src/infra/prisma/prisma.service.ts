/**
 * Prisma 服务 —— DAO 层的基座。
 *
 * Prisma 7 起查询引擎不再带 Rust 二进制，连接走 driver adapter（@prisma/adapter-pg），
 * 所以 PrismaClient 的构造必须传 adapter —— 这也是「连接池」能被我们显式接管的原因。
 *
 * 职责边界：
 *   - 这里只有连接生命周期 + 事务模板，**不写任何业务查询**
 *   - 业务查询一律放各模块的 *.repository.ts
 */

import {
    Inject,
    Injectable,
    Logger,
    OnApplicationShutdown,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';
import { PG_POOL } from './pg.pool';
import { AppConfigService } from '../../config/app-config.service';

@Injectable()
export class PrismaService
    extends PrismaClient
    implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown
{
    private readonly logger = new Logger(PrismaService.name);

    constructor(
        @Inject(PG_POOL) private readonly pool: Pool,
        config: AppConfigService
    ) {
        super({
            adapter: new PrismaPg(pool),
            log:
                config.isProduction
                    ? ['warn', 'error']
                    : // 开发下把慢查询打出来，慢 SQL 不看日志是发现不了的
                      ['warn', 'error', { emit: 'event', level: 'query' }],
        });
    }

    async onModuleInit(): Promise<void> {
        await this.$connect();
        this.logger.log(
            `Prisma 已连接，连接池 max=${this.pool.options.max ?? 'default'}`
        );
    }

    async onModuleDestroy(): Promise<void> {
        await this.$disconnect();
    }

    async onApplicationShutdown(): Promise<void> {
        // 兜底：异常路径下 $disconnect 可能没跑，pg 连接不关进程退不干净
        await this.pool.end().catch(() => undefined);
    }

    /**
     * 事务模板。所有多表写入都走这里，不在业务代码里散落 $transaction。
     *
     * 交互式事务（回调式）而不是批量式：批量式传 PrismaPromise，
     * 中途没法做条件判断，对「先查再写」的场景（版本号分配）不够用。
     */
    async withTransaction<T>(
        fn: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
        opts?: { maxWaitMs?: number; timeoutMs?: number }
    ): Promise<T> {
        return this.$transaction(fn, {
            maxWait: opts?.maxWaitMs ?? 5000,
            timeout: opts?.timeoutMs ?? 15000,
        });
    }

    /** 探活用，不要在业务里调 */
    async ping(): Promise<boolean> {
        try {
            await this.$queryRaw`SELECT 1`;
            return true;
        } catch {
            return false;
        }
    }
}
