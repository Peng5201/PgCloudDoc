-- 事务性发件箱状态
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- 事务性发件箱：业务写库与 Kafka 发布解耦
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "event_key" TEXT,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");
CREATE INDEX "outbox_events_created_at_idx" ON "outbox_events"("created_at");

-- 审计幂等：同一条 Kafka 消息重复投递时只落一条
ALTER TABLE "audit_logs" ADD COLUMN "event_id" TEXT;
CREATE UNIQUE INDEX "audit_logs_event_id_key" ON "audit_logs"("event_id");
