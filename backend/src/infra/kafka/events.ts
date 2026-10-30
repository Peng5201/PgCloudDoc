/**
 * 事件契约 —— Kafka 消息体。
 *
 * 原则：**消息体必须是可校验的 DTO**，不接受裸 JSON 直接进业务逻辑。
 * 消息队列的消费者跑在别的进程/别的时间点，出了错比同步调用难查一个数量级，
 * 所以入口处就要把非法消息挡掉并丢进死信。
 *
 * 所有事件共享一个信封：id / occurredAt / producer，方便幂等和溯源。
 */

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

/** 所有事件的公共信封 */
export abstract class BaseEvent {
    /** 事件 id，幂等去重的 key */
    @IsUUID()
    @IsNotEmpty()
    id!: string;

    @IsString()
    @IsNotEmpty()
    topic!: KafkaTopic;

    /** ISO8601 */
    @IsString()
    @IsNotEmpty()
    occurredAt!: string;

    @IsString()
    @IsOptional()
    producer?: string;

    @IsString()
    @IsOptional()
    correlationId?: string;
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
