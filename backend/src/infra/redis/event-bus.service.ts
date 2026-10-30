/**
 * 事件总线抽象 —— 把「本机广播」和「跨实例广播」统一到一套 API。
 *
 * 为什么要有这层：本地开发时 WS 网关只有一个进程，直接内存分发最快；
 * 但一旦多实例部署（水平扩容），同一个文档的连接会落在不同进程上，
 * 必须靠 Redis Pub/Sub 才能互相看见。如果业务代码直接写内存广播，
 * 扩容那天就要改一圈业务逻辑 —— 所以从一开始就走接口。
 *
 * 生产里更大的变更广播走 Kafka（见 infra/kafka），这里只管**低延迟的在线态**：
 *   - WS awareness/光标（要求 <50ms）
 *   - 文档变更的实时提醒
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { RedisService } from './redis.service';

export type EventHandler<T = unknown> = (payload: T) => void;

interface Subscription {
    topic: string;
    handler: EventHandler;
}

@Injectable()
export class EventBusService implements OnModuleDestroy {
    private readonly logger = new Logger(EventBusService.name);
    /** 本机订阅表 */
    private readonly local = new EventEmitter();
    /** topic → 订阅数，用来决定要不要向 Redis 订阅 */
    private readonly refCount = new Map<string, number>();
    private readonly subscriptions = new Map<Subscription, true>();
    /** 跨实例消息回环保护：自己发出去的不要再当收到的处理一次 */
    private readonly nodeId = `${process.pid}-${Date.now().toString(36)}`;
    private subscribed = false;

    constructor(private readonly redis: RedisService) {
        // 单个事件的所有 handler 都要跑到
        this.local.setMaxListeners(100);
    }

    async onModuleDestroy(): Promise<void> {
        for (const sub of this.subscriptions.keys()) {
            this.local.off(sub.topic, sub.handler as never);
        }
        this.subscriptions.clear();
    }

    /**
     * 订阅。返回退订函数。
     *
     * 首个订阅者会触发 Redis SUBSCRIBE，最后一个退订时才 UNSUBSCRIBE ——
     * 避免为没人听的频道维持连接状态。
     */
    subscribe<T = unknown>(topic: string, handler: EventHandler<T>): () => void {
        const sub: Subscription = { topic, handler: handler as EventHandler };
        this.local.on(topic, handler as never);
        this.subscriptions.set(sub, true);

        const count = (this.refCount.get(topic) ?? 0) + 1;
        this.refCount.set(topic, count);

        if (count === 1) {
            void this.ensureRedisSubscription(topic);
        }

        return () => {
            if (!this.subscriptions.has(sub)) return;
            this.subscriptions.delete(sub);
            this.local.off(topic, handler as never);

            const next = (this.refCount.get(topic) ?? 1) - 1;
            if (next <= 0) {
                this.refCount.delete(topic);
                void this.unsubscribeRedis(topic);
            } else {
                this.refCount.set(topic, next);
            }
        };
    }

    /** 广播：本机立刻收到，跨实例走 Redis Pub/Sub */
    publish<T = unknown>(topic: string, payload: T): void {
        this.local.emit(topic, payload);

        void this.redis.safe(
            (c) =>
                c.publish(
                    topic,
                    JSON.stringify({ __node: this.nodeId, payload })
                ),
            0
        );
    }

    private async ensureRedisSubscription(topic: string): Promise<void> {
        const subscriber = this.redis.subscriber;
        if (!this.subscribed) {
            await this.redis.safe(async () => {
                // ioredis 的 message 事件是全局的，只挂一次
                subscriber.on('message', (channel: string, raw: string) => {
                    this.onRedisMessage(channel, raw);
                });
                return true;
            }, false);
            this.subscribed = true;
        }
        await this.redis.safe(() => subscriber.subscribe(topic), 0);
    }

    private async unsubscribeRedis(topic: string): Promise<void> {
        await this.redis.safe(() => this.redis.subscriber.unsubscribe(topic), 0);
    }

    private onRedisMessage(channel: string, raw: string): void {
        let envelope: { __node?: string; payload?: unknown };
        try {
            envelope = JSON.parse(raw) as { __node?: string; payload?: unknown };
        } catch {
            this.logger.warn(`收到非法广播消息，已丢弃：${channel}`);
            return;
        }
        // 本机已经处理过一次了，跨实例回环要跳过
        if (envelope.__node === this.nodeId) return;
        this.local.emit(channel, envelope.payload);
    }
}
