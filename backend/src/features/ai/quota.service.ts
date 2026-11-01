/**
 * 每日 token 配额。
 *
 * 计数放 Redis（按用户 + UTC 日期），失败降级为放行：
 * 配额是成本控制手段，不是安全边界，不能用它把整个功能打成不可用。
 */

import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AppError } from '../../shared/errors/app-error';

const KEY_PREFIX = 'ai:usage:';
/** 存活 2 天：跨时区/跨日边界时旧 key 能自然过期 */
const KEY_TTL_MS = 2 * 24 * 60 * 60 * 1000;

@Injectable()
export class AiQuotaService {
    private readonly logger = new Logger(AiQuotaService.name);

    constructor(
        private readonly redis: RedisService,
        private readonly config: AppConfigService
    ) {}

    private limit(): number {
        return this.config.ai.dailyTokenLimit;
    }

    private key(userId: string, date = new Date()): string {
        return `${KEY_PREFIX}${userId}:${date.toISOString().slice(0, 10)}`;
    }

    async assertWithinLimit(userId: string): Promise<void> {
        const limit = this.limit();
        if (limit <= 0) return;

        const raw = await this.redis.get(this.key(userId));
        const used = raw ? Number(raw) : 0;
        if (Number.isFinite(used) && used >= limit) {
            throw AppError.rateLimited(
                `今日 AI 用量已达上限（${limit} tokens），请明天再试`
            );
        }
    }

    async record(userId: string, tokens: number): Promise<void> {
        if (tokens <= 0 || this.limit() <= 0) return;

        await this.redis.safe(
            async (client) => {
                const key = this.key(userId);
                const next = await client.incrby(key, tokens);
                if (next === tokens) await client.pexpire(key, KEY_TTL_MS);
            },
            undefined
        );

        if (!this.redis.isAvailable) {
            this.logger.warn('Redis 不可用，AI token 用量未计入配额');
        }
    }
}
