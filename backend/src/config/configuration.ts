/**
 * 分层配置 —— 把扁平的环境变量整理成有语义的配置对象。
 *
 * ConfigModule.forRoot({ load: [configuration] }) 之后，
 * `configService.get('app.auth.accessTokenTtl')` 就能按路径取到；
 * 业务代码统一走 `AppConfigService`，不直接摸 ConfigService。
 */

import 'dotenv/config';
import { registerAs } from '@nestjs/config';
import { envSchema } from './env.validation';

/**
 * 这里必须**惰性**解析：模块顶层直接 parse 的话，执行时机比 ConfigModule
 * 读 .env 还早，所有环境变量都是 undefined，启动就炸。
 */
export function buildConfig() {
    const env = envSchema.parse(process.env);

    return {
        nodeEnv: env.NODE_ENV,
        isProduction: env.NODE_ENV === 'production',
        isTest: env.NODE_ENV === 'test',
        port: env.PORT,

        database: {
            url: env.DATABASE_URL,
            host: env.PG_HOST,
            port: env.PG_PORT,
            user: env.PG_USER,
            password: env.PG_PASSWORD,
            database: env.PG_DB,
            pool: {
                max: env.PG_POOL_MAX,
                min: env.PG_POOL_MIN,
                idleTimeoutMillis: env.PG_IDLE_TIMEOUT_MS,
                connectionTimeoutMillis: env.PG_CONNECT_TIMEOUT_MS,
                statementTimeout: env.PG_STATEMENT_TIMEOUT_MS,
            },
        },

        redis: {
            host: env.REDIS_HOST,
            port: env.REDIS_PORT,
            db: env.REDIS_DB,
            password: env.REDIS_PASSWORD || undefined,
            keyPrefix: env.REDIS_KEY_PREFIX,
            /** 挂掉时是否降级直读 PG */
            failOpen: env.REDIS_FAIL_OPEN,
        },

        kafka: {
            brokers: env.KAFKA_BROKERS,
            clientId: env.KAFKA_CLIENT_ID,
            consumerGroup: env.KAFKA_CONSUMER_GROUP,
            concurrency: env.KAFKA_CONCURRENCY,
            maxRetries: env.KAFKA_MAX_RETRIES,
        },

        auth: {
            accessSecret: env.JWT_ACCESS_SECRET,
            refreshSecret: env.JWT_REFRESH_SECRET,
            accessTokenTtl: env.JWT_ACCESS_TTL,
            refreshTokenTtl: env.JWT_REFRESH_TTL,
            issuer: env.JWT_ISSUER,
            audience: env.JWT_AUDIENCE,
            cookie: {
                domain: env.COOKIE_DOMAIN || undefined,
                secure: env.COOKIE_SECURE,
                sameSite: env.COOKIE_SAMESITE as 'lax' | 'strict' | 'none',
            },
        },

        oauth: {
            google: {
                clientId: env.OAUTH_GOOGLE_CLIENT_ID,
                clientSecret: env.OAUTH_GOOGLE_CLIENT_SECRET,
                redirectUri: env.OAUTH_GOOGLE_REDIRECT_URI,
                enabled: Boolean(
                    env.OAUTH_GOOGLE_CLIENT_ID && env.OAUTH_GOOGLE_CLIENT_SECRET
                ),
            },
            oidcIssuer: env.OIDC_ISSUER || undefined,
        },

        http: {
            corsOrigins: env.CORS_ORIGINS,
            trustProxy: env.TRUST_PROXY,
            jsonLimit: env.BODY_JSON_LIMIT,
            rawLimit: env.BODY_RAW_LIMIT,
            compressionThreshold: env.COMPRESSION_THRESHOLD,
            throttle: {
                ttl: env.THROTTLE_TTL_MS,
                limit: env.THROTTLE_LIMIT,
            },
        },

        log: {
            level: env.LOG_LEVEL,
            pretty: env.LOG_PRETTY,
        },

        collab: {
            compactThreshold: env.YJS_COMPACT_THRESHOLD,
            idleSnapshotMs: env.COLLAB_IDLE_SNAPSHOT_MS,
            minSnapshotIntervalMs: env.COLLAB_MIN_SNAPSHOT_INTERVAL_MS,
            presenceTtlMs: env.COLLAB_PRESENCE_TTL_MS,
        },

        etcd: {
            /** 空数组 = 关闭配置中心 */
            endpoints: env.ETCD_ENDPOINTS,
            username: env.ETCD_USERNAME || undefined,
            password: env.ETCD_PASSWORD || undefined,
            configPrefix: env.ETCD_CONFIG_PREFIX.replace(/\/+$/, ''),
        },

        admin: {
            bootstrapEmails: env.ADMIN_EMAILS.map((email) => email.toLowerCase()),
        },

        plugins: {
            storageDir: env.PLUGIN_STORAGE_DIR,
        },
    };
}

export type AppConfig = ReturnType<typeof buildConfig>;

export default registerAs('app', buildConfig);
