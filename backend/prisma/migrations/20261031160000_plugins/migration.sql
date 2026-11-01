-- 插件注册表：版本、静态产物、启用关系。
-- 产物本身在文件系统（PLUGIN_STORAGE_DIR），这里只存元数据与哈希。

CREATE TYPE "PluginVersionStatus" AS ENUM ('UPLOADED', 'VALIDATED', 'REJECTED', 'PUBLISHED', 'DEPRECATED');
CREATE TYPE "PluginScope" AS ENUM ('GLOBAL', 'ROLE', 'USER');

CREATE TABLE "plugins" (
    "id" TEXT NOT NULL,
    "plugin_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "author" TEXT,
    "homepage" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugins_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plugins_plugin_key_key" ON "plugins"("plugin_key");

CREATE TABLE "plugin_versions" (
    "id" TEXT NOT NULL,
    "plugin_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "entry" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "zip_bytes" INTEGER NOT NULL,
    "assets_bytes" INTEGER NOT NULL,
    "file_count" INTEGER NOT NULL,
    "status" "PluginVersionStatus" NOT NULL DEFAULT 'VALIDATED',
    "plugin_api" TEXT NOT NULL,
    "host_range" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "reviewed_by" TEXT,
    "review_note" TEXT,

    CONSTRAINT "plugin_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plugin_versions_plugin_id_version_key" ON "plugin_versions"("plugin_id", "version");
CREATE INDEX "plugin_versions_status_published_at_idx" ON "plugin_versions"("status", "published_at");

CREATE TABLE "plugin_installations" (
    "id" TEXT NOT NULL,
    "plugin_id" TEXT NOT NULL,
    "plugin_version_id" TEXT NOT NULL,
    "scope" "PluginScope" NOT NULL DEFAULT 'GLOBAL',
    "scope_value" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plugin_installations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plugin_installations_plugin_id_scope_scope_value_key"
    ON "plugin_installations"("plugin_id", "scope", "scope_value");

ALTER TABLE "plugin_versions"
    ADD CONSTRAINT "plugin_versions_plugin_id_fkey"
    FOREIGN KEY ("plugin_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "plugin_installations"
    ADD CONSTRAINT "plugin_installations_plugin_id_fkey"
    FOREIGN KEY ("plugin_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "plugin_installations"
    ADD CONSTRAINT "plugin_installations_plugin_version_id_fkey"
    FOREIGN KEY ("plugin_version_id") REFERENCES "plugin_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
