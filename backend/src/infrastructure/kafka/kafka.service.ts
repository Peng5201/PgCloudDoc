/**
 * Kafka 生产端 + topic 管理。
 *
 * 只做三件事：建 topic、发消息、探活。消费逻辑在 ConsumerManagerService。
 */

import {
    Inject,
    Injectable,
    Logger,
    OnApplicationShutdown,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { Admin, Kafka, KafkaConfig, logLevel, Producer } from 'kafkajs';
import { AppConfigService } from '../../config/app-config.service';
import { ALL_TOPICS, TOPIC_CONFIG } from './topics';
import { buildEventEnvelope, type EventByTopic } from './events';

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
    private readonly logger = new Logger(KafkaService.name);
    private readonly kafka: Kafka;
    private admin: Admin | null = null;
    private producer: Producer | null = null;
    private connected = false;
    /** 正在连接中的 Promise，避免并发调用重复建连 */
    private connecting: Promise<boolean> | null = null;

    constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {
        const { kafka } = config;
        const kafkaConfig: KafkaConfig = {
            clientId: kafka.clientId,
            brokers: kafka.brokers,
            logLevel: config.isProduction ? logLevel.WARN : logLevel.INFO,
            retry: {
                initialRetryTime: 300,
                retries: 8,
                maxRetryTime: 30_000,
            },
            connectionTimeout: 10_000,
            requestTimeout: 30_000,
        };
        this.kafka = new Kafka(kafkaConfig);
    }

    get client(): Kafka {
        return this.kafka;
    }

    get isReady(): boolean {
        return this.connected;
    }

    async onModuleInit(): Promise<void> {
        await this.ensureConnected();
    }

    async onModuleDestroy(): Promise<void> {
        await this.disconnect();
    }

    async onApplicationShutdown(): Promise<void> {
        await this.disconnect();
    }

    /**
     * 确保已连接（幂等）。
     *
     * 启动时 Kafka 可能还没起来 —— 不能因此让整个应用永久失去异步能力。
     * 发件箱 dispatcher / 消费者会周期性调用它，Kafka 恢复后自动接上。
     */
    ensureConnected(): Promise<boolean> {
        if (this.connected) return Promise.resolve(true);
        if (this.connecting) return this.connecting;

        this.connecting = this.connect()
            .catch((err: unknown) => {
                this.connected = false;
                this.logger.warn(
                    `Kafka 连接失败（异步任务暂不可用，稍后重试）：${
                        err instanceof Error ? err.message : String(err)
                    }`
                );
                return false;
            })
            .finally(() => {
                this.connecting = null;
            });

        return this.connecting;
    }

    private async connect(): Promise<boolean> {
        // 上一次可能残留在半连接状态，先释放再重建
        await Promise.allSettled([this.producer?.disconnect(), this.admin?.disconnect()]);

        this.admin = this.kafka.admin();
        this.producer = this.kafka.producer({
            // 同一个 key 的消息落同一个分区，保证同一文档的事件有序
            allowAutoTopicCreation: true,
            // 幂等生产者：重试不会在分区内产生重复消息
            idempotent: true,
            maxInFlightRequests: 1,
        });

        await this.admin.connect();
        await this.producer.connect();
        await this.ensureTopics();
        this.connected = true;
        this.logger.log(`Kafka 已连接：${this.config.kafka.brokers.join(',')}`);
        return true;
    }

    private async disconnect(): Promise<void> {
        await Promise.allSettled([
            this.producer?.disconnect(),
            this.admin?.disconnect(),
        ]);
        this.connected = false;
    }

    /** 声明式建 topic，幂等 */
    private async ensureTopics(): Promise<void> {
        if (!this.admin) return;
        const existing = new Set(await this.admin.listTopics());
        const toCreate = ALL_TOPICS.filter((t) => !existing.has(t)).map((topic) => ({
            topic,
            numPartitions: TOPIC_CONFIG[topic]?.numPartitions ?? 3,
            replicationFactor: TOPIC_CONFIG[topic]?.replicationFactor ?? 1,
        }));

        if (toCreate.length === 0) return;
        await this.admin.createTopics({ topics: toCreate, waitForLeaders: true });
        this.logger.log(`已创建 topic：${toCreate.map((t) => t.topic).join(', ')}`);
    }

    /**
     * 发消息。key 用业务主键（documentId / userId），
     * 保证同一实体的事件落同一分区 —— 分区内有序是消息队列最容易被忽略的约束。
     *
     * 泛型按 topic 推导 payload 类型：字段写错在编译期就报错。
     */
    async publish<K extends keyof EventByTopic>(
        topic: K,
        event: Omit<EventByTopic[K], 'id' | 'occurredAt' | 'topic' | 'schemaVersion'> & { id?: string },
        key?: string
    ): Promise<void> {
        const envelope = buildEventEnvelope<EventByTopic[K]>(
            topic,
            event as unknown as Record<string, unknown>,
            `${this.config.kafka.clientId}@${process.pid}`
        );
        await this.sendRaw(topic, envelope, key);
    }

    /**
     * 直接发送一条已构造好的消息（发件箱 dispatcher 用）。
     *
     * 未连接时**抛错**而不是静默丢弃 —— 调用方据此保留消息、稍后重试。
     */
    async sendRaw(topic: string, payload: unknown, key?: string): Promise<void> {
        if (!this.connected || !this.producer) {
            throw new Error(`Kafka 未连接，无法发送 ${topic}`);
        }

        try {
            await this.producer.send({
                topic,
                acks: -1, // 等所有 ISR 确认
                messages: [
                    {
                        key,
                        value: JSON.stringify(payload),
                        headers: {
                            'event-id': (payload as { id?: string }).id ?? '',
                            'event-type': topic,
                        },
                    },
                ],
            });
        } catch (err) {
            this.logger.error(
                `发送 Kafka 消息失败 ${topic}：${err instanceof Error ? err.message : String(err)}`
            );
            throw err;
        }
    }

    async ping(): Promise<boolean> {
        if (!this.connected || !this.admin) return false;
        try {
            await this.admin.describeCluster();
            return true;
        } catch {
            return false;
        }
    }
}
