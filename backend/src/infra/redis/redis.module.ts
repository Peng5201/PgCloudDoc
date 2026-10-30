import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { CacheService } from './cache.service';
import { LockService } from './lock.service';
import { RateLimitService } from './rate-limit.service';
import { EventBusService } from './event-bus.service';

@Global()
@Module({
    providers: [RedisService, CacheService, LockService, RateLimitService, EventBusService],
    exports: [RedisService, CacheService, LockService, RateLimitService, EventBusService],
})
export class RedisModule {}
