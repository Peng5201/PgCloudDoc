-- 系统级角色：区分普通用户和管理员（管理后台 / 配置中心）
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- 默认普通用户。管理员通过 ADMIN_EMAILS 环境变量在启动时引导，
-- 之后可以在管理后台里调整。
ALTER TABLE "users" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER';
