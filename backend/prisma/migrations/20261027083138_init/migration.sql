-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETED');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'EDITOR', 'VIEWER');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_identities" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_user_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "email" TEXT,
    "raw" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "replaced_by_id" TEXT,
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "snapshot" BYTEA,
    "snapshot_version" INTEGER NOT NULL DEFAULT 0,
    "content_hash" TEXT,
    "doc_size" INTEGER NOT NULL DEFAULT 0,
    "cell_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_members" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'VIEWER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_updates" (
    "id" BIGSERIAL NOT NULL,
    "document_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "payload" BYTEA NOT NULL,
    "actor_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "name" TEXT,
    "remark" TEXT,
    "snapshot" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "partition" INTEGER NOT NULL,
    "msg_offset" BIGINT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "auth_identities_user_id_idx" ON "auth_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_provider_provider_user_id_key" ON "auth_identities"("provider", "provider_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_revoked_at_idx" ON "refresh_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "documents_owner_id_status_updated_at_idx" ON "documents"("owner_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "documents_updated_at_idx" ON "documents"("updated_at");

-- CreateIndex
CREATE INDEX "document_members_user_id_idx" ON "document_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_members_document_id_user_id_key" ON "document_members"("document_id", "user_id");

-- CreateIndex
CREATE INDEX "document_updates_document_id_seq_idx" ON "document_updates"("document_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "document_updates_document_id_seq_key" ON "document_updates"("document_id", "seq");

-- CreateIndex
CREATE INDEX "document_versions_document_id_created_at_idx" ON "document_versions"("document_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_no_key" ON "document_versions"("document_id", "version_no");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_idx" ON "audit_logs"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "processed_events_topic_partition_msg_offset_key" ON "processed_events"("topic", "partition", "msg_offset");

-- AddForeignKey
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_members" ADD CONSTRAINT "document_members_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_members" ADD CONSTRAINT "document_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_updates" ADD CONSTRAINT "document_updates_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 原生 SQL 部分：Prisma 只管表结构，存储过程 / 视图必须手写
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 存储过程：归档一个文档版本
--
-- 为什么做成 PL/pgSQL 而不是应用层写三条 SQL：
--   「分配版本号 + 插版本表 + 更新文档快照」这三步必须原子。
--   应用层即便用 $transaction，版本号分配仍可能在高并发下撞唯一索引
--   （两个事务同时读到 MAX=5，都要写 6）。这里先 FOR UPDATE 锁文档行，
--   同一文档的归档自然串行化，版本号不会重复。
--
-- 返回值是分配到的版本号，方便调用方回写缓存/发消息。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION archive_document_version(
    p_document_id  TEXT,
    p_actor        TEXT,
    p_remark       TEXT,
    p_snapshot     BYTEA,
    p_size_bytes   INTEGER,
    p_content_hash TEXT,
    p_cell_count   INTEGER DEFAULT NULL
) RETURNS INTEGER AS $$
DECLARE
    v_version_no INTEGER;
BEGIN
    -- 1. 锁住文档行：同一文档的并发归档在此排队
    PERFORM 1 FROM documents WHERE id = p_document_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'document not found: %', p_document_id;
    END IF;

    -- 2. 分配版本号
    SELECT COALESCE(MAX(version_no), 0) + 1
      INTO v_version_no
      FROM document_versions
     WHERE document_id = p_document_id;

    -- 3. 写版本
    INSERT INTO document_versions
        (id, document_id, version_no, remark, snapshot, size_bytes, created_by, created_at)
    VALUES
        (gen_random_uuid()::text, p_document_id, v_version_no,
         p_remark, p_snapshot, p_size_bytes, p_actor, now());

    -- 4. 回写文档的「当前快照」
    UPDATE documents
       SET snapshot        = p_snapshot,
           snapshot_version = v_version_no,
           content_hash    = p_content_hash,
           doc_size        = p_size_bytes,
           cell_count      = COALESCE(p_cell_count, cell_count),
           updated_at      = now()
     WHERE id = p_document_id;

    RETURN v_version_no;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION archive_document_version IS
    '归档文档版本：原子地分配版本号 + 写 document_versions + 回写 documents.snapshot';

-- ----------------------------------------------------------------------------
-- 视图：文档列表
--
-- 列表页需要 owner 信息和版本数。做成视图而不是应用层 join 两个查询，
-- 是为了避免 N+1（拿 20 个文档再查 20 次版本数）。视图进 DB 优化器手里，
-- 将来加索引/改统计口径都不用动应用代码。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_document_list AS
SELECT
    d.id,
    d.owner_id,
    d.name,
    d.description,
    d.status,
    d.snapshot_version,
    d.content_hash,
    d.doc_size,
    d.cell_count,
    d.created_at,
    d.updated_at,
    u.username                         AS owner_username,
    COALESCE(u.display_name, u.username) AS owner_display_name,
    COALESCE(v.version_count, 0)       AS version_count
FROM documents d
JOIN users u
  ON u.id = d.owner_id
LEFT JOIN (
    SELECT document_id, COUNT(*) AS version_count
      FROM document_versions
     GROUP BY document_id
) v ON v.document_id = d.id
WHERE d.deleted_at IS NULL;

COMMENT ON VIEW v_document_list IS
    '文档列表：join owner + 版本数，规避 N+1。不含已软删除的文档';
