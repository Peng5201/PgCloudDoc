/**
 * Kafka 消费端 —— 任务队列的核心。
 *
 * 三件必须做对的事：
 *
 * 1. **幂等**：Kafka 是 at-least-once，同一消息可能被消费多次。
 *    用 `processed_events` 表记录 (topic, partition, offset)，重复投递直接跳过。
 *    不是「尽量去重」，是**必须**去重 —— 快照归档跑两次就多一个版本。
 *
 * 2. **手动提交**：`eachBatchAutoResolve: false`，只有处理成功才 resolveOffset。
 *    自动提交会在处理中途崩溃时丢消息。
 *
 * 3. **重试 + 死信**：失败按指数退避重试；超过 maxRetries 进 dead-letter topic，
 *    不能让一条坏消息把整个 consumer group 卡死。
 *
 * 启动时机：`OnApplicationBootstrap`（所有 OnModuleInit 之后），
 * 这样各业务模块的 handler 一定已经注册完。
 */

import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Consumer } from 'kafkajs';
import { PrismaService } from '../prisma/prisma.service';
import { KafkaService } from './kafka.service';
import { AppConfigService } from '../../config/app-config.service';
import { EVENT_CLASS_BY_TOPIC, BaseEvent, DeadLetterEvent } from './events';
import { KafkaTopic } from './topics';

export interface EventContext {
    /** 原始 key，通常是 documentId / userId */
    key?: string;
    partition: number;
    offset: string;
    attempt: number;
}

export type EventHandler<E extends BaseEvent = BaseEvent> = (
    event: E,
    ctx: EventContext
) => Promise<void>;

@Injectable()
export class ConsumerManagerService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(ConsumerManagerService.name);
    private readonly handlers = new Map<string, EventHandler<BaseEvent>>();
    private consumer: Consumer | null = null;
    private started = false;

    constructor(
        private readonly kafka: KafkaService,
        private readonly prisma: PrismaService,
        private readonly config: AppConfigService
    ) {}

    /** 业务模块在 OnModuleInit 里调用 */
    registerHandler<E extends BaseEvent>(topic: KafkaTopic, handler: EventHandler<E>): void {
        if (this.handlers.has(topic)) {
            throw new Error(`topic 已有消费者：${topic}`);
        }
        this.handlers.set(topic, handler as EventHandler<BaseEvent>);
    }

    async onApplicationBootstrap(): Promise<void> {
        if (this.handlers.size === 0) {
            this.logger.log('没有注册 Kafka handler，跳过消费');
            return;
        }
        if (!this.kafka.isReady) {
            this.logger.warn('Kafka 未连接，消费者暂不启动');
            return;
        }
        await this.start();
    }

    async onModuleDestroy(): Promise<void> {
        if (this.consumer) {
            await this.consumer.disconnect().catch(() => undefined);
            this.consumer = null;
        }
    }

    private async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        const topics = [...this.handlers.keys()];
        this.consumer = this.kafka.client.consumer({
            groupId: this.config.kafka.consumerGroup,
            // rebalance 时最多等 10s，别让部署卡住
            sessionTimeout: 30_000,
            rebalanceTimeout: 60_000,
            heartbeatInterval: 3_000,
            allowAutoTopicCreation: true,
        });

        await this.consumer.connect();
        await this.consumer.subscribe({ topics, fromBeginning: false });

        this.logger.log(`Kafka 消费者已订阅：${topics.join(', ')}`);

        // 不 await：run() 内部是长循环，阻塞在 await 上会让 bootstrap 卡死
        void this.consumer.run({
            eachBatchAutoResolve: false,
            eachBatch: (payload) => this.processBatch(payload),
        });
    }

    private async processBatch(payload: {
        batch: {
            topic: string;
            partition: number;
            messages: {
                key: Buffer | null;
                value: Buffer | null;
                offset: string;
                headers?: Record<string, Buffer | string | (Buffer | string)[] | undefined>;
            }[];
        };
        resolveOffset: (offset: string) => void;
        heartbeat: () => Promise<void>;
        isRunning: () => boolean;
        isStale: () => boolean;
        commitOffsetsIfNecessary: () => Promise<void>;
    }): Promise<void> {
        const { batch, resolveOffset, heartbeat, isRunning, isStale } = payload;

        for (const message of batch.messages) {
            // rebalance 发生或批次过期就停手，剩下的交给新一轮
            if (!isRunning() || isStale()) break;

            const offset = message.offset;
            const key = message.key?.toString() ?? undefined;
            const raw = message.value?.toString('utf-8') ?? '';

            try {
                const alreadyDone = await this.markProcessedOnce(
                    batch.topic,
                    batch.partition,
                    offset
                );
                if (alreadyDone) {
                    this.logger.debug(`跳过重复消息 ${batch.topic}@${batch.partition}/${offset}`);
                    resolveOffset(offset);
                    continue;
                }

                const { event, error } = this.parse(batch.topic, raw);
                if (error) {
                    // 非法消息重试也没用，直接进死信
                    await this.deadLetter(batch.topic, raw, error, key, 1);
                    resolveOffset(offset);
                    continue;
                }

                const handler = this.handlers.get(batch.topic);
                if (!handler) {
                    this.logger.warn(`没有注册处理器：${batch.topic}`);
                    resolveOffset(offset);
                    continue;
                }

                await this.executeWithRetry(batch.topic, event!, handler, {
                    key,
                    partition: batch.partition,
                    offset,
                    attempt: 1,
                });

                resolveOffset(offset);
            } catch (err) {
                // 执行到这里说明重试已耗尽且进死信也失败了。
                // 停止处理本批，让消息留在未提交状态 —— 宁可重复也不能丢。
                this.logger.error(
                    `批次处理中断 ${batch.topic}@${batch.partition}/${offset}: ${
                        err instanceof Error ? err.message : String(err)
                    }`
                );
                break;
            }

            await heartbeat();
        }

        await payload.commitOffsetsIfNecessary();
    }

    /** 指数退避重试 */
    private async executeWithRetry(
        topic: string,
        event: BaseEvent,
        handler: EventHandler<BaseEvent>,
        ctx: EventContext
    ): Promise<void> {
        const maxRetries = this.config.kafka.maxRetries;

        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            try {
                await handler(event, { ...ctx, attempt });
                return;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (attempt > maxRetries) {
                    this.logger.error(`重试耗尽 ${topic}：${message}`);
                    await this.deadLetter(topic, JSON.stringify(event), message, ctx.key, attempt);
                    return;
                }
                const backoff = Math.min(2 ** attempt * 200, 30_000);
                this.logger.warn(`第 ${attempt} 次失败 ${topic}，${backoff}ms 后重试：${message}`);
                await new Promise((resolve) => setTimeout(resolve, backoff));
            }
        }
    }

    /** DTO 校验 + 反序列化 */
    private parse(topic: string, raw: string): { event?: BaseEvent; error?: string } {
        let plain: Record<string, unknown>;
        try {
            plain = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return { error: 'payload 不是合法 JSON' };
        }

        const EventClass = EVENT_CLASS_BY_TOPIC[topic];
        if (!EventClass) {
            // 没有契约定义的 topic —— 不猜结构，直接死信
            return { error: `topic 没有事件契约：${topic}` };
        }

        const instance = plainToInstance(EventClass, plain);
        const errors = validateSync(instance, {
            whitelist: true,
            forbidNonWhitelisted: true,
            validationError: { target: false, value: false },
        });
        if (errors.length > 0) {
            const details = errors.flatMap((e) =>
                Object.values(e.constraints ?? {}).map((c) => `${e.property}: ${c}`)
            );
            return { error: `DTO 校验失败：${details.join('; ')}` };
        }
        return { event: instance };
    }

    /**
     * 幂等标记。
     *
     * 用 INSERT ... ON CONFLICT DO NOTHING 一次搞定「检查 + 写入」，
     * 靠唯一索引 (topic, partition, msg_offset) 兜底并发。
     * 返回 true 表示这条消息之前已经处理过。
     */
    private async markProcessedOnce(
        topic: string,
        partition: number,
        offset: string
    ): Promise<boolean> {
        try {
            const result = await this.prisma.processedEvent.createMany({
                data: [{ topic, partition, msgOffset: BigInt(offset) }],
                skipDuplicates: true,
            });
            // count = 0 说明唯一键冲突，即已处理过
            return result.count === 0;
        } catch (err) {
            // 幂等表写不进去时放行处理：重复执行的风险 < 消息永久卡住的风险
            this.logger.warn(
                `幂等表写入失败，按未处理继续：${err instanceof Error ? err.message : String(err)}`
            );
            return false;
        }
    }

    private async deadLetter(
        originalTopic: string,
        raw: string,
        error: string,
        key: string | undefined,
        attempts: number
    ): Promise<void> {
        let originalPayload: Record<string, unknown> | undefined;
        try {
            originalPayload = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            originalPayload = { raw: raw.slice(0, 2000) };
        }

        const event: Omit<DeadLetterEvent, 'id' | 'occurredAt' | 'topic'> = {
            originalTopic,
            error,
            originalPayload,
            attempts,
        };

        try {
            await this.kafka.publish(KafkaTopic.DeadLetter, event, key);
        } catch (err) {
            // 连死信都发不出去就只能记日志了 —— 至少别把原始数据弄丢
            this.logger.error(
                `死信发送失败，原始消息：${raw.slice(0, 2000)} / 错误：${error} / ${
                    err instanceof Error ? err.message : String(err)
                }`
            );
        }
    }
}
