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
import { randomUUID } from 'node:crypto';
import { Admin, Kafka, KafkaConfig, logLevel, Producer } from 'kafkajs';
import { AppConfigService } from '../../config/app-config.service';
import { ALL_TOPICS, TOPIC_CONFIG } from './topics';
import type { EventByTopic } from './events';

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
    private readonly logger = new Logger(KafkaService.name);
    private readonly kafka: Kafka;
    private admin!: Admin;
    private producer!: Producer;
    private connected = false;

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
        this.admin = this.kafka.admin();
        this.producer = this.kafka.producer({
            // 同一个 key 的消息落同一个分区，保证同一文档的事件有序
            allowAutoTopicCreation: true,
        });

        try {
            await this.admin.connect();
            await this.producer.connect();
            await this.ensureTopics();
            this.connected = true;
            this.logger.log(`Kafka 已连接：${this.config.kafka.brokers.join(',')}`);
        } catch (err) {
            // Kafka 不可用不该让整个应用起不来 —— 归档/审计只是异步支线
            this.connected = false;
            this.logger.warn(
                `Kafka 连接失败（异步任务暂不可用）：${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    async onModuleDestroy(): Promise<void> {
        await this.disconnect();
    }

    async onApplicationShutdown(): Promise<void> {
        await this.disconnect();
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
        event: Omit<EventByTopic[K], 'id' | 'occurredAt' | 'topic'> & { id?: string },
        key?: string
    ): Promise<void> {
        const envelope = {
            ...event,
            id: event.id ?? randomUUID(),
            topic,
            occurredAt: new Date().toISOString(),
            producer: `${this.config.kafka.clientId}@${process.pid}`,
        };

        if (!this.connected) {
            this.logger.warn(`Kafka 未连接，事件丢弃：${topic}`);
            return;
        }

        try {
            await this.producer.send({
                topic,
                acks: -1, // 等所有 ISR 确认，本地单副本等价于 leader 确认
                messages: [
                    {
                        key,
                        value: JSON.stringify(envelope),
                        headers: {
                            'event-id': envelope.id,
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
        if (!this.connected) return false;
        try {
            await this.admin.describeCluster();
            return true;
        } catch {
            return false;
        }
    }
}
