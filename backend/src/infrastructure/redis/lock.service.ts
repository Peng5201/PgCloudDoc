/**
 * 分布式锁 —— 基于 `SET NX PX` + Lua 保证原子性。
 *
 * 用在哪：
 *   - 缓存击穿时的互斥重建（CacheService）
 *   - 快照归档 / Yjs compaction 的互斥（同一文档同时只跑一个）
 *
 * 两个坑必须避开：
 *   1. **释放别人的锁**：A 的锁超时后 B 拿到，A 回来 DEL 就把 B 的删了
 *      → value 用随机 token，DEL 前用 Lua 比对 token
 *   2. **业务没跑完锁就过期**：长任务要主动续期（watchdog）
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from './redis.service';

/** 比对 token 后才 DEL，保证不误删别人的锁 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/** 比对 token 后才续期 */
const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

export interface LockHandle {
    /** 锁的 key */
    readonly key: string;
    /** 随机 token，释放/续期时用于身份比对 */
    readonly token: string;
    /** 释放锁（幂等，重复调用安全） */
    release(): Promise<void>;
    /** 续期；返回 false 表示锁已经不属于你了 */
    extend(ttlMs: number): Promise<boolean>;
}

@Injectable()
export class LockService {
    private readonly logger = new Logger(LockService.name);

    constructor(private readonly redis: RedisService) {}

    /**
     * 尝试拿锁，拿不到立刻返回 null（不阻塞）。
     * 需要阻塞重试的场景自己在外层循环。
     */
    async acquire(resource: string, ttlMs = 10_000): Promise<LockHandle | null> {
        const key = `lock:${resource}`;
        const token = randomUUID();

        const ok = await this.redis.safe(
            async (c) => (await c.set(key, token, 'PX', ttlMs, 'NX')) === 'OK',
            // Redis 挂了：默认放行。锁的目的是「省资源」，不是「保正确」，
            // 降级成并发执行比整体不可用好。需要强一致的地方用 strict 调用。
            true
        );

        if (!ok) return null;

        let released = false;
        return {
            key,
            token,
            release: async () => {
                if (released) return;
                released = true;
                await this.redis.safe(
                    (c) => c.eval(RELEASE_SCRIPT, 1, key, token) as Promise<number>,
                    0
                );
            },
            extend: async (extendTtl: number) => {
                const result = await this.redis.safe(
                    (c) => c.eval(EXTEND_SCRIPT, 1, key, token, String(extendTtl)) as Promise<number>,
                    1
                );
                return result === 1;
            },
        };
    }

    /** 跑一段必须独占的逻辑；拿不到锁就执行 fallback */
    async withLock<T>(
        resource: string,
        fn: () => Promise<T>,
        opts: { ttlMs?: number; fallback?: () => Promise<T> } = {}
    ): Promise<T> {
        const handle = await this.acquire(resource, opts.ttlMs ?? 10_000);
        if (!handle) {
            this.logger.debug(`锁被占用，走 fallback：${resource}`);
            return opts.fallback ? opts.fallback() : (undefined as T);
        }
        try {
            return await fn();
        } finally {
            await handle.release();
        }
    }
}
