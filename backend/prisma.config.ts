/**
 * Prisma CLI 配置（Prisma 7 起替代 package.json#prisma）。
 *
 * 这里的 datasource.url 从 .env 读 —— 生产走真实连接串，
 * 本地用 docker-compose 里那套。
 */
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // 迁移前自动执行，给 e2e 单独的 schema 用
    seed: undefined,
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
