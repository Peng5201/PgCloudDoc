/**
 * topic 契约。所有 topic 名集中在这里，禁止在业务代码里写裸字符串 ——
 * topic 名就是服务间的接口，改名是 breaking change，要能一眼看全。
 */

export enum KafkaTopic {
    /** 请求把文档的 Y.Doc materialize 成快照 */
    DocSnapshotRequested = 'doc.snapshot.requested',
    /** 快照归档完成 */
    DocSnapshotCompleted = 'doc.snapshot.completed',
    /** Yjs update 落库（审计用） */
    DocUpdatePersisted = 'doc.update.persisted',
    /** 用户行为审计 */
    AuditUserActivity = 'audit.user.activity',
    /** 重试耗尽的事件进这里，人工排查 */
    DeadLetter = 'pgclouddoc.dead-letter',
}

/** topic → 分区数 / 副本数。单节点开发一律 1 副本 */
export const TOPIC_CONFIG: Record<string, { numPartitions: number; replicationFactor: number }> = {
    [KafkaTopic.DocSnapshotRequested]: { numPartitions: 3, replicationFactor: 1 },
    [KafkaTopic.DocSnapshotCompleted]: { numPartitions: 3, replicationFactor: 1 },
    [KafkaTopic.DocUpdatePersisted]: { numPartitions: 6, replicationFactor: 1 },
    [KafkaTopic.AuditUserActivity]: { numPartitions: 3, replicationFactor: 1 },
    [KafkaTopic.DeadLetter]: { numPartitions: 1, replicationFactor: 1 },
};

export const ALL_TOPICS = Object.keys(TOPIC_CONFIG);
