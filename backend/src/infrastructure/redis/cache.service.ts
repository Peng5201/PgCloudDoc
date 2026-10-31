/**
 * Cache-Aside 缓存，把「穿透 / 击穿 / 雪崩」三个经典问题一起处理掉。
 *
 * 穿透（查不存在的 id）：空值也缓存一小段时间（nullTtlMs），下次不再打到 DB
 * 击穿（热点 key 过期瞬间）：load 前抢分布式锁，抢不到的请求短轮询读缓存
 * 雪崩（大批 key 同时到期）：TTL 加 ±20% 随机抖动
 *
 * 另外两条原则：
 *   1. loader 抛错**不缓存**，直接往上抛 —— 不能把一次数据库抖动缓存成 10 分钟故障
 *   2. 写操作后主动失效（invalidate），不依赖 TTL 到期
 */

import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';
import { LockService } from './lock.service';

export interface CacheOptions {
    /** 正常值 TTL（毫秒） */
    ttlMs: number;
    /** 空值 TTL，防穿透。默认 60s */
    nullTtlMs?: number;
    /** 关闭 TTL 抖动（用于需要精确过期的场景） */
    noJitter?: boolean;
    /** 不加互斥锁（小 key 不值得抢锁） */
    noMutex?: boolean;
    /** 抢不到锁时的等待上限 */
    lockWaitMs?: number;
}

/** 内部哨兵：区分「缓存了空值」和「真的没缓存」 */
const NULL_SENTINEL = '__NULL__';

@Injectable()
export class CacheService {
    private readonly logger = new Logger(CacheService.name);

    constructor(
        private readonly redis: RedisService,
        private readonly lock: LockService
    ) {}

    /** TTL 抖动 ±20%，打散同一时刻的大批过期 */
    private withJitter(ttlMs: number, disabled?: boolean): number {
        if (disabled) return ttlMs;
        const jitter = ttlMs * 0.2;
        return Math.round(ttlMs - jitter + Math.random() * jitter * 2);
    }

    async get<T>(key: string): Promise<T | undefined> {
        const raw = await this.redis.get(key);
        if (raw === null) return undefined;
        if (raw === NULL_SENTINEL) return undefined;
        try {
            return JSON.parse(raw) as T;
        } catch {
            this.logger.warn(`缓存值不是合法 JSON，已丢弃：${key}`);
            await this.redis.del(key);
            return undefined;
        }
    }

    async set<T>(key: string, value: T, ttlMs: number, noJitter?: boolean): Promise<void> {
        const ttl = this.withJitter(ttlMs, noJitter);
        await this.redis.set(key, JSON.stringify(value), ttl);
    }

    /** 写后失效。多个 key 一起删，避免删漏 */
    async invalidate(...keys: string[]): Promise<void> {
        await this.redis.del(...keys);
    }

    /** 按前缀批量失效（需要 SCAN，量大时慎用） */
    async invalidatePattern(pattern: string, limit = 500): Promise<void> {
        await this.redis.safe(async (c) => {
            let cursor = '0';
            let removed = 0;
            do {
                const [next, keys] = await c.scan(
                    cursor,
                    'MATCH',
                    pattern,
                    'COUNT',
                    100
                );
                cursor = next;
                if (keys.length > 0) {
                    await c.del(...keys);
                    removed += keys.length;
                }
            } while (cursor !== '0' && removed < limit);
            return removed;
        }, 0);
    }

    /**
     * 读穿 + 穿透/击穿/雪崩三重防护。
     *
     * @param key       缓存 key
     * @param loader    回源加载（一般是 Repository 查询）
     * @param options   TTL 等
     */
    async getOrSet<T>(
        key: string,
        loader: () => Promise<T>,
        options: CacheOptions
    ): Promise<T> {
        const cached = await this.get<T>(key);
        if (cached !== undefined) return cached;

        const loadAndStore = async (): Promise<T> => {
            // 抢到锁后再看一次：等锁期间别人可能已经把缓存填好了
            const again = await this.get<T>(key);
            if (again !== undefined) return again;

            const value = await loader();
            const nullTtl = options.nullTtlMs ?? 60_000;

            if (value === null || value === undefined) {
                await this.redis.set(
                    key,
                    NULL_SENTINEL,
                    this.withJitter(nullTtl, options.noJitter)
                );
                return value;
            }

            await this.set(key, value, options.ttlMs, options.noJitter);
            return value;
        };

        if (options.noMutex) {
            return loadAndStore();
        }

        const lockHandle = await this.lock.acquire(`cache:${key}`, 5_000);
        if (lockHandle) {
            try {
                return await loadAndStore();
            } finally {
                await lockHandle.release();
            }
        }

        // 别人在重建：短轮询读缓存，读到就返回；等不到就自己兜底 load
        const deadline = Date.now() + (options.lockWaitMs ?? 2_000);
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            const value = await this.get<T>(key);
            if (value !== undefined) return value;
        }

        this.logger.debug(`等缓存重建超时，直接回源：${key}`);
        return loader();
    }
}
