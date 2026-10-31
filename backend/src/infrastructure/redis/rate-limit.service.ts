/**
 * 滑动窗口限流。
 *
 * 为什么不用固定窗口：固定窗口在窗口边界会放行 2 倍流量
 * （前一窗口最后 1 秒 + 后一窗口第 1 秒）。滑动窗口用 ZSet 存每次请求的时间戳，
 * 统计 [now-window, now] 内的成员数，边界问题自然消失。
 *
 * Lua 脚本保证「删旧 + 加新 + 计数」三步原子 —— 否则并发下计数会漂。
 */

import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call("ZREMRANGEBYSCORE", key, 0, now - window)
local count = redis.call("ZCARD", key)
if count < limit then
  redis.call("ZADD", key, now, member)
  redis.call("PEXPIRE", key, window)
  return { 1, limit - count - 1 }
end
return { 0, 0 }
`;

export interface RateLimitResult {
    /** 是否放行 */
    allowed: boolean;
    /** 剩余可用次数 */
    remaining: number;
    /** 需要等待多久才能再次请求（毫秒），allowed=true 时为 0 */
    retryAfterMs: number;
}

@Injectable()
export class RateLimitService {
    constructor(private readonly redis: RedisService) {}

    /**
     * @param bucket  限流桶名，如 `auth:login`
     * @param subject 限流主体，一般是 userId 或 IP
     */
    async consume(
        bucket: string,
        subject: string,
        limit: number,
        windowMs: number
    ): Promise<RateLimitResult> {
        const key = `rl:${bucket}:${subject}`;
        const now = Date.now();

        const raw = (await this.redis.safe(
            (c) =>
                c.eval(
                    SLIDING_WINDOW_SCRIPT,
                    1,
                    key,
                    String(now),
                    String(windowMs),
                    String(limit),
                    `${now}-${Math.random().toString(36).slice(2, 10)}`
                ) as Promise<[number, number]>,
            // Redis 挂了：放行。限流是保护手段，不该变成可用性杀手
            [1, limit] as [number, number]
        )) as [number, number];

        const [allowed, remaining] = raw;
        return {
            allowed: allowed === 1,
            remaining: Number(remaining),
            retryAfterMs: allowed === 1 ? 0 : Math.ceil(windowMs / 2),
        };
    }

    /** 只看不占配额 */
    async peek(bucket: string, subject: string, windowMs: number): Promise<number> {
        const key = `rl:${bucket}:${subject}`;
        return this.redis.safe(async (c) => {
            const now = Date.now();
            await c.zremrangebyscore(key, 0, now - windowMs);
            return c.zcount(key, 0, now);
        }, 0);
    }

    /** 撤销一次计数（比如登录失败后重试成功了） */
    async refund(bucket: string, subject: string): Promise<void> {
        await this.redis.safe(async (c) => {
            const key = `rl:${bucket}:${subject}`;
            const members = await c.zrangebyscore(key, 0, Date.now());
            if (members.length > 0) {
                await c.zrem(key, members[members.length - 1]);
            }
            return true;
        }, false);
    }
}
