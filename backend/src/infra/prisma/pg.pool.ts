/**
 * pg 连接池 —— 「连接池」这一项的显式落点。
 *
 * Prisma 的 driver adapter 只负责把查询翻译成 SQL，底层连接还是 pg.Pool 拿的。
 * 把 Pool 单独注册成 provider，才能：
 *   1. 显式控制 max / idle / connectionTimeout / statement_timeout
 *   2. 在 health check 里直接探活
 *   3. 将来换 TiDB/分库分表时只换这个 provider
 */

import { Provider } from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfigService } from '../../config/app-config.service';

export const PG_POOL = Symbol('PG_POOL');

export const pgPoolProvider: Provider = {
    provide: PG_POOL,
    inject: [AppConfigService],
    useFactory: (config: AppConfigService) => {
        const { database } = config;
        const pool = new Pool({
            host: database.host,
            port: database.port,
            user: database.user,
            password: database.password,
            database: database.database,
            max: database.pool.max,
            min: database.pool.min,
            idleTimeoutMillis: database.pool.idleTimeoutMillis,
            connectionTimeoutMillis: database.pool.connectionTimeoutMillis,
            // statement_timeout 由 connection 事件设置（Pool 级的 options 会被连接复用忽略）
            application_name: 'pgclouddoc',
        });

        pool.on('connect', (client) => {
            // statement_timeout 必须每个连接设一次：连接会被复用，
            // Pool 级的 options 覆盖不到已经建好的连接
            void client
                .query(`SET statement_timeout = ${database.pool.statementTimeout}`)
                .catch((err: unknown) => {
                    console.error('[pg] 设置 statement_timeout 失败:', err);
                });
        });

        // 单个连接出错不应该把整个进程带走
        pool.on('error', (err) => {
            // eslint-disable-next-line no-console
            console.error('[pg] idle client error:', err.message);
        });

        return pool;
    },
};
