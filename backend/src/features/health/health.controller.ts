/**
 * 健康检查。
 *
 * 三个层次，用途完全不同：
 *
 *   /health          存活探针（liveness）—— 「进程还活着吗」。
 *                    只要进程能响应就返回 200，**不查依赖**。
 *                    给 K8s 用：依赖挂了不应该让 K8s 把 Pod 杀掉重启，
 *                    那只会雪上加霜。
 *
 *   /health/ready    就绪探针（readiness）—— 「现在能接流量吗」。
 *                    查 PG / Redis / Kafka。任何一个必需依赖挂了就返回 503，
 *                    让负载均衡把流量摘走。
 *
 *   /health/deps     依赖详情，给人看的运维面板用。
 *
 * Redis 判定是「降级可用」：缓存挂了系统要能继续跑（见 REDIS_FAIL_OPEN），
 * 所以 Redis 不健康只降级为 warning，不影响 ready。
 */

import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { KafkaService } from '../../infrastructure/kafka/kafka.service';
import { Public } from '../../shared/decorators/auth.decorators';
import { SkipWrap } from '../../shared/interceptors/response.interceptor';
import { YDocStore } from '../../infrastructure/yjs/ydoc-store';

interface DependencyStatus {
    name: string;
    status: 'up' | 'down' | 'degraded';
    /** 是否影响就绪 */
    critical: boolean;
    latencyMs?: number;
    detail?: string;
}

@Controller('health')
export class HealthController {
    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
        private readonly kafka: KafkaService,
        private readonly ydocStore: YDocStore
    ) {}

    /** 存活探针：不查任何依赖 */
    @Public()
    @Get()
    @SkipWrap()
    live(): { status: string; uptimeSeconds: number; timestamp: string } {
        return {
            status: 'ok',
            uptimeSeconds: Math.round(process.uptime()),
            timestamp: new Date().toISOString(),
        };
    }

    /** 就绪探针：依赖挂了返回 503 */
    @Public()
    @Get('ready')
    @SkipWrap()
    async ready(@Res({ passthrough: true }) res: Response) {
        const deps = await this.checkDependencies();
        const notReady = deps.filter((d) => d.critical && d.status === 'down');

        if (notReady.length > 0) {
            res.status(HttpStatus.SERVICE_UNAVAILABLE);
        }

        return {
            status: notReady.length === 0 ? 'ok' : 'degraded',
            checks: deps,
            timestamp: new Date().toISOString(),
        };
    }

    @Public()
    @Get('deps')
    @SkipWrap()
    async deps() {
        const checks = await this.checkDependencies();
        return {
            checks,
            cache: {
                ydocCachedCount: this.ydocStore.cachedSize(),
            },
            process: {
                pid: process.pid,
                uptimeSeconds: Math.round(process.uptime()),
                memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
                nodeVersion: process.version,
            },
        };
    }

    private async checkDependencies(): Promise<DependencyStatus[]> {
        const [pg, redis, kafka] = await Promise.all([
            this.timed('postgres', () => this.prisma.ping()),
            this.timed('redis', () => this.redis.ping()),
            this.timed('kafka', () => this.kafka.ping()),
        ]);

        return [
            {
                name: 'postgres',
                status: pg.ok ? 'up' : 'down',
                critical: true,
                latencyMs: pg.latencyMs,
                ...(pg.ok ? {} : { detail: pg.error }),
            },
            {
                // Redis 是缓存/限流层，挂了走降级直读 PG，不算致命
                name: 'redis',
                status: redis.ok ? 'up' : 'degraded',
                critical: false,
                latencyMs: redis.latencyMs,
                ...(redis.ok ? {} : { detail: redis.error }),
            },
            {
                // Kafka 只跑异步任务（归档/审计），挂了主流程照常
                name: 'kafka',
                status: kafka.ok ? 'up' : 'degraded',
                critical: false,
                latencyMs: kafka.latencyMs,
                ...(kafka.ok ? {} : { detail: kafka.error }),
            },
        ];
    }

    private async timed(
        name: string,
        fn: () => Promise<boolean>
    ): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
        const start = Date.now();
        try {
            const ok = await fn();
            return { ok, latencyMs: Date.now() - start };
        } catch (err) {
            return {
                ok: false,
                latencyMs: Date.now() - start,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
}
