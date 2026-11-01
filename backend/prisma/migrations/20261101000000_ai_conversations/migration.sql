-- AI 助手：会话与消息。
-- 密钥不落库，只保存在服务端环境变量；这里只有对话内容与用量。

CREATE TYPE "AiMessageRole" AS ENUM ('USER', 'ASSISTANT');
CREATE TYPE "AiMessageStatus" AS ENUM ('COMPLETE', 'STREAMING', 'CANCELLED', 'ERROR', 'INTERRUPTED');

CREATE TABLE "ai_conversations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "document_id" TEXT,
    "title" TEXT NOT NULL DEFAULT '新对话',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_conversations_user_id_updated_at_idx" ON "ai_conversations"("user_id", "updated_at" DESC);
CREATE INDEX "ai_conversations_document_id_idx" ON "ai_conversations"("document_id");

CREATE TABLE "ai_messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" "AiMessageRole" NOT NULL,
    "content" JSONB NOT NULL,
    "status" "AiMessageStatus" NOT NULL DEFAULT 'COMPLETE',
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cached_tokens" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_messages_conversation_id_seq_key" ON "ai_messages"("conversation_id", "seq");
CREATE INDEX "ai_messages_conversation_id_created_at_idx" ON "ai_messages"("conversation_id", "created_at");

ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
