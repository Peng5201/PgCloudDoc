/**
 * 环境变量校验 —— 启动时一次性把 `.env` 解析并验证，
 * 配置错误在这里就炸，不要等到运行时才发现 JWT_SECRET 是空的。
 *
 * 用 zod 而不是 joi：类型可以直接从 schema 推出来，少写一份 interface。
 */

import { z } from 'zod';

/** 逗号分隔列表 → string[]，空串解析成 [] */
const csv = (fallback: string[] = []) =>
    z
        .string()
        .optional()
        .transform((v) =>
            v === undefined || v.trim() === ''
                ? fallback
                : v
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
        );

const int = (fallback: number, min = 0) =>
    z.coerce.number().int().min(min).optional().default(fallback);

const bool = (fallback: boolean) =>
    z
        .string()
        .optional()
        .transform((v) => {
            if (v === undefined || v === '') return fallback;
            return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
        });

export const envSchema = z.object({
    // ── 基础 ──
    NODE_ENV: z.enum(['development', 'test', 'production']).optional().default('development'),
    PORT: int(3000, 1),

    // ── PostgreSQL ──
    DATABASE_URL: z.string().min(1, 'DATABASE_URL 不能为空'),
    PG_HOST: z.string().optional().default('localhost'),
    PG_PORT: int(5432, 1),
    PG_USER: z.string().optional().default('pgclouddoc'),
    PG_PASSWORD: z.string().optional().default('pgclouddoc'),
    PG_DB: z.string().optional().default('pgclouddoc'),
    PG_POOL_MAX: int(20, 1),
    PG_POOL_MIN: int(0, 0),
    PG_IDLE_TIMEOUT_MS: int(30000, 1000),
    PG_CONNECT_TIMEOUT_MS: int(5000, 100),
    PG_STATEMENT_TIMEOUT_MS: int(15000, 100),

    // ── Redis ──
    REDIS_HOST: z.string().optional().default('localhost'),
    REDIS_PORT: int(6379, 1),
    REDIS_DB: int(0, 0),
    REDIS_PASSWORD: z.string().optional().default(''),
    REDIS_FAIL_OPEN: bool(true),
    REDIS_KEY_PREFIX: z.string().optional().default('pgclouddoc:'),

    // ── Kafka ──
    KAFKA_BROKERS: csv(['localhost:9092']),
    KAFKA_CLIENT_ID: z.string().optional().default('pgclouddoc'),
    KAFKA_CONSUMER_GROUP: z.string().optional().default('pgclouddoc-workers'),
    KAFKA_CONCURRENCY: int(4, 1),
    KAFKA_MAX_RETRIES: int(5, 0),

    // ── 认证 ──
    JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET 至少 16 位'),
    JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET 至少 16 位'),
    JWT_ACCESS_TTL: int(900, 30),
    JWT_REFRESH_TTL: int(2592000, 60),
    JWT_ISSUER: z.string().optional().default('pgclouddoc'),
    JWT_AUDIENCE: z.string().optional().default('pgclouddoc-client'),
    COOKIE_DOMAIN: z.string().optional().default(''),
    COOKIE_SECURE: bool(false),
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).optional().default('lax'),

    // ── OAuth2 ──
    OAUTH_GOOGLE_CLIENT_ID: z.string().optional().default(''),
    OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
    OAUTH_GOOGLE_REDIRECT_URI: z.string().optional().default(''),
    OIDC_ISSUER: z.string().optional().default(''),

    // ── HTTP ──
    CORS_ORIGINS: csv(['http://localhost:5173']),
    // 前面有几层反向代理可信（nginx 部署填 1，直连填 0）。
    // 不设置的话 req.ip 会是代理的地址，限流和审计会全部算到同一个 IP 上。
    TRUST_PROXY: int(0, 0),
    BODY_JSON_LIMIT: z.string().optional().default('1mb'),
    BODY_RAW_LIMIT: z.string().optional().default('8mb'),
    COMPRESSION_THRESHOLD: int(1024, 0),
    THROTTLE_TTL_MS: int(60000, 1000),
    THROTTLE_LIMIT: int(300, 1),

    // ── 日志 ──
    LOG_LEVEL: z
        .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
        .optional()
        .default('info'),
    LOG_PRETTY: bool(true),

    // ── 协同 / CRDT ──
    YJS_COMPACT_THRESHOLD: int(200, 10),
    COLLAB_IDLE_SNAPSHOT_MS: int(30000, 1000),
    COLLAB_MIN_SNAPSHOT_INTERVAL_MS: int(300000, 1000),
    COLLAB_PRESENCE_TTL_MS: int(30000, 1000),

    // ── 配置中心（etcd）──
    // 留空 = 不启用配置中心：/api/v1/config 返回空配置，后台接口 503。
    // 生产/开发都建议填上，例如 localhost:2379 或 etcd:2379
    ETCD_ENDPOINTS: csv([]),
    ETCD_USERNAME: z.string().optional().default(''),
    ETCD_PASSWORD: z.string().optional().default(''),
    /** 所有配置项的 key 前缀，按环境区分：/pgclouddoc/prod/config */
    ETCD_CONFIG_PREFIX: z.string().optional().default('/pgclouddoc/config'),

    // ── 管理后台 ──
    /** 启动时把这些邮箱提升为 ADMIN（逗号分隔）。之后可在数据库里继续调整 */
    ADMIN_EMAILS: csv([]),

    // ── 插件 ──
    /** 插件 zip 与解包产物的根目录。生产挂持久卷，开发放在 backend/var/plugins */
    PLUGIN_STORAGE_DIR: z.string().optional().default('./var/plugins'),
});

export type RawEnv = z.infer<typeof envSchema>;

/**
 * ConfigModule.validate 的入口。
 *
 * 注意：要返回 merge 后的对象 —— transform 出来的字段
 * （比如 csv 把 string 变成 string[]）只有回写进 config 才能被读到。
 */
export function validateEnv(config: Record<string, unknown>): RawEnv {
    return envSchema.parse(config);
}
