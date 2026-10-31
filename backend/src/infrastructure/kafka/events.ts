/**
 * 事件契约 —— Kafka 消息体。
 *
 * 原则：**消息体必须是可校验的 DTO**，不接受裸 JSON 直接进业务逻辑。
 * 消息队列的消费者跑在别的进程/别的时间点，出了错比同步调用难查一个数量级，
 * 所以入口处就要把非法消息挡掉并丢进死信。
 *
 * 所有事件共享一个信封：id / occurredAt / producer，方便幂等和溯源。
 */

import { randomUUID } from 'node:crypto';
import {
    IsEnum,
    IsInt,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    Min,
} from 'class-validator';
import type { KafkaTopic } from './topics';

/** 事件结构版本。破坏性变更时递增，消费者可据此兼容旧消息 */
export const EVENT_SCHEMA_VERSION = 1;

/** 所有事件的公共信封 */
export abstract class BaseEvent {
    /** 事件 id，幂等去重的 key */
    @IsUUID()
    @IsNotEmpty()
    id!: string;

    @IsString()
    @IsNotEmpty()
    topic!: KafkaTopic;

    /** 事件结构版本 */
    @IsInt()
    @Min(1)
    @IsOptional()
    schemaVersion?: number;

    /** ISO8601 */
    @IsString()
    @IsNotEmpty()
    occurredAt!: string;

    @IsString()
    @IsOptional()
    producer?: string;

    /** 链路追踪：HTTP 请求 id 会透传到事件，贯穿消费者日志 */
    @IsString()
    @IsOptional()
    correlationId?: string;
}

/**
 * 构造事件信封（id / topic / schemaVersion / occurredAt / producer / correlationId）。
 *
 * 生产者（发件箱 dispatcher、直接发送）都走这里，保证信封字段一致。
 */
export function buildEventEnvelope<T extends BaseEvent>(
    topic: string,
    payload: Partial<BaseEvent> & Record<string, unknown>,
    producer: string,
    correlationId?: string
): T {
    const envelope: Record<string, unknown> = { ...payload };
    envelope.id = typeof payload.id === 'string' && payload.id ? payload.id : randomUUID();
    envelope.topic = topic;
    envelope.schemaVersion =
        typeof payload.schemaVersion === 'number' ? payload.schemaVersion : EVENT_SCHEMA_VERSION;
    envelope.occurredAt = new Date().toISOString();
    envelope.producer = producer;

    const correlation = (payload.correlationId as string | undefined) ?? correlationId;
    if (correlation) envelope.correlationId = correlation;
    else delete envelope.correlationId;

    return envelope as unknown as T;
}

export class DocSnapshotRequestedEvent extends BaseEvent {
    @IsUUID()
    documentId!: string;

    @IsString()
    @IsOptional()
    userId?: string;

    /** 触发原因：idle / save / manual / restore */
    @IsEnum(['idle', 'save', 'manual', 'restore', 'compaction'])
    reason!: 'idle' | 'save' | 'manual' | 'restore' | 'compaction';

    @IsInt()
    @Min(0)
    @IsOptional()
    yjsUpdateCount?: number;
}

export class DocSnapshotCompletedEvent extends BaseEvent {
    @IsUUID()
    documentId!: string;

    @IsInt()
    @Min(0)
    versionNo!: number;

    @IsInt()
    @Min(0)
    sizeBytes!: number;

    @IsString()
    @IsOptional()
    contentHash?: string;

    @IsString()
    @IsOptional()
    userId?: string;
}

export class DocUpdatePersistedEvent extends BaseEvent {
    @IsUUID()
    documentId!: string;

    @IsInt()
    @Min(0)
    seq!: number;

    @IsString()
    @IsOptional()
    userId?: string;

    /** 本次 update 的字节数（不带 payload 本身 —— 二进制不该进消息体） */
    @IsInt()
    @Min(0)
    payloadSize!: number;
}

export class AuditUserActivityEvent extends BaseEvent {
    @IsUUID()
    @IsOptional()
    userId?: string;

    @IsString()
    @IsNotEmpty()
    action!: string;

    @IsString()
    @IsOptional()
    resourceType?: string;

    @IsString()
    @IsOptional()
    resourceId?: string;

    @IsString()
    @IsOptional()
    ip?: string;

    @IsString()
    @IsOptional()
    userAgent?: string;

    @IsObject()
    @IsOptional()
    metadata?: Record<string, unknown>;
}

export class DeadLetterEvent extends BaseEvent {
    @IsString()
    @IsNotEmpty()
    originalTopic!: string;

    @IsString()
    @IsNotEmpty()
    error!: string;

    @IsObject()
    @IsOptional()
    originalPayload?: Record<string, unknown>;

    @IsInt()
    @Min(0)
    attempts!: number;
}

/** topic → 事件类的映射，消费者据此做 DTO 校验 */
export const EVENT_CLASS_BY_TOPIC: Record<string, new () => BaseEvent> = {
    'doc.snapshot.requested': DocSnapshotRequestedEvent,
    'doc.snapshot.completed': DocSnapshotCompletedEvent,
    'doc.update.persisted': DocUpdatePersistedEvent,
    'audit.user.activity': AuditUserActivityEvent,
    'pgclouddoc.dead-letter': DeadLetterEvent,
};

/**
 * topic → 事件类型的映射。
 *
 * 给 `KafkaService.publish` 用：只传 topic 时 TS 就知道 payload 该长什么样，
 * 字段写错是编译错误，而不是到消费者那边才被 DTO 校验打回。
 */
export interface EventByTopic {
    'doc.snapshot.requested': DocSnapshotRequestedEvent;
    'doc.snapshot.completed': DocSnapshotCompletedEvent;
    'doc.update.persisted': DocUpdatePersistedEvent;
    'audit.user.activity': AuditUserActivityEvent;
    'pgclouddoc.dead-letter': DeadLetterEvent;
}
