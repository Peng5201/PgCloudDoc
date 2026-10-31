/**
 * ioredis 客户端 —— 缓存层的底座。
 *
 * 两条连接：
 *   - client     ：普通命令（GET/SET/ZADD…）
 *   - subscriber ：SUBSCRIBE 专用。ioredis 的订阅连接会进 subscriber 模式，
 *                  不能再跑普通命令，所以必须分开
 *
 * 全部命令都套 `safe()`：
 *   缓存不是单点。Redis 挂了系统必须继续跑（降级直读 PG），
 *   所以任何缓存命令失败都吞掉并返回 fallback，只记日志不抛错。
 */

import {
    Injectable,
    Logger,
    OnApplicationShutdown,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';

/** Redis 不可用时的降级返回 */
export const REDIS_UNAVAILABLE = Symbol('REDIS_UNAVAILABLE');

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
    private readonly logger = new Logger(RedisService.name);
    private _client!: Redis;
    private _subscriber!: Redis;
    private available = true;

    constructor(private readonly config: AppConfigService) {}

    onModuleInit(): void {
        const { redis } = this.config;

        const base = {
            host: redis.host,
            port: redis.port,
            db: redis.db,
            password: redis.password,
            keyPrefix: redis.keyPrefix,
            // 单个命令最多重试 2 次，避免缓存命令把请求拖死
            maxRetriesPerRequest: 2,
            // 断线自动重连，指数退避
            retryStrategy: (times: number) => Math.min(times * 200, 5000),
            lazyConnect: true,
        };

        this._client = new Redis(base);
        this._subscriber = new Redis(base);

        for (const [name, conn] of [
            ['client', this._client],
            ['subscriber', this._subscriber],
        ] as const) {
            conn.on('ready', () => {
                if (!this.available) {
                    this.logger.log(`Redis(${name}) 已恢复`);
                }
                this.available = true;
            });
            conn.on('error', (err) => {
                if (this.available) {
                    this.logger.warn(`Redis(${name}) 不可用：${err.message}`);
                }
                this.available = false;
            });
        }

        // 连接失败不阻塞应用启动 —— 这正是 failOpen 的意义
        void this._client.connect().catch((err: Error) => {
            this.available = false;
            this.logger.warn(`Redis 初始连接失败（降级模式）：${err.message}`);
        });
        void this._subscriber.connect().catch(() => undefined);
    }

    async onModuleDestroy(): Promise<void> {
        await this.quit(this._client);
        await this.quit(this._subscriber);
    }

    async onApplicationShutdown(): Promise<void> {
        await this.quit(this._client).catch(() => undefined);
        await this.quit(this._subscriber).catch(() => undefined);
    }

    private async quit(conn: Redis | undefined): Promise<void> {
        if (!conn) return;
        try {
            await conn.quit();
        } catch {
            conn.disconnect();
        }
    }

    /** 普通命令连接 */
    get client(): Redis {
        return this._client;
    }

    /** 订阅连接 */
    get subscriber(): Redis {
        return this._subscriber;
    }

    get isAvailable(): boolean {
        return this.available;
    }

    /** 给 health check 用 */
    async ping(): Promise<boolean> {
        try {
            await this._client.ping();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 降级包装：命令失败时返回 fallback 而不是抛错。
     *
     * failOpen=false（严格模式）时原样抛出 —— 用于「缓存写失败就必须报错」的场景，
     * 比如 token 黑名单：写不进去就不能宣布登出成功。
     */
    async safe<T>(fn: (client: Redis) => Promise<T>, fallback: T, strict = false): Promise<T> {
        try {
            return await fn(this._client);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (strict || !this.config.redis.failOpen) {
                throw err;
            }
            if (this.available) {
                this.logger.warn(`Redis 命令失败，降级返回 fallback：${message}`);
            }
            return fallback;
        }
    }

    // ─────────────────────── 常用快捷方法 ───────────────────────

    async get(key: string): Promise<string | null> {
        return this.safe((c) => c.get(key), null);
    }

    async set(key: string, value: string, ttlMs?: number): Promise<void> {
        await this.safe(
            async (c) => {
                if (ttlMs) {
                    await c.set(key, value, 'PX', ttlMs);
                } else {
                    await c.set(key, value);
                }
            },
            undefined
        );
    }

    async del(...keys: string[]): Promise<void> {
        if (keys.length === 0) return;
        await this.safe((c) => c.del(...keys), undefined);
    }

    async exists(key: string): Promise<boolean> {
        return this.safe(async (c) => (await c.exists(key)) === 1, false);
    }

    async expire(key: string, ttlMs: number): Promise<void> {
        await this.safe((c) => c.pexpire(key, ttlMs), undefined);
    }

    async ttl(key: string): Promise<number> {
        return this.safe((c) => c.pttl(key), -2);
    }

    // ─────────────────────── Hash ───────────────────────

    async hget(key: string, field: string): Promise<string | null> {
        return this.safe((c) => c.hget(key, field), null);
    }

    async hset(key: string, data: Record<string, string>): Promise<void> {
        await this.safe((c) => c.hset(key, data), undefined);
    }

    async hgetall(key: string): Promise<Record<string, string>> {
        return this.safe((c) => c.hgetall(key), {});
    }

    // ─────────────────────── Set ───────────────────────

    async sadd(key: string, ...members: string[]): Promise<void> {
        if (members.length === 0) return;
        await this.safe((c) => c.sadd(key, ...members), undefined);
    }

    async srem(key: string, ...members: string[]): Promise<void> {
        if (members.length === 0) return;
        await this.safe((c) => c.srem(key, ...members), undefined);
    }

    async smembers(key: string): Promise<string[]> {
        return this.safe((c) => c.smembers(key), []);
    }

    // ─────────────────────── ZSet ───────────────────────

    async zadd(key: string, score: number, member: string): Promise<void> {
        await this.safe((c) => c.zadd(key, score, member), undefined);
    }

    async zrem(key: string, ...members: string[]): Promise<void> {
        await this.safe((c) => c.zrem(key, ...members), undefined);
    }

    async zremrangebyscore(key: string, min: number, max: number): Promise<void> {
        await this.safe((c) => c.zremrangebyscore(key, min, max), undefined);
    }

    async zcount(key: string, min: number, max: number): Promise<number> {
        return this.safe((c) => c.zcount(key, min, max), 0);
    }

    async zrangebyscore(
        key: string,
        min: number,
        max: number
    ): Promise<string[]> {
        return this.safe((c) => c.zrangebyscore(key, min, max), []);
    }

    // ─────────────────────── 计数 / Bitmap / Stream ───────────────────────

    async incr(key: string): Promise<number> {
        return this.safe((c) => c.incr(key), 0);
    }

    async setbit(key: string, offset: number, value: 0 | 1): Promise<void> {
        await this.safe((c) => c.setbit(key, offset, value), undefined);
    }

    async getbit(key: string, offset: number): Promise<number> {
        return this.safe((c) => c.getbit(key, offset), 0);
    }

    /** 变更流水（调试回放用），超出长度自动裁剪 */
    async xadd(key: string, maxlen: number, fields: Record<string, string>): Promise<void> {
        await this.safe(
            (c) => c.xadd(key, 'MAXLEN', '~', maxlen, '*', ...Object.entries(fields).flat()),
            undefined
        );
    }
}
