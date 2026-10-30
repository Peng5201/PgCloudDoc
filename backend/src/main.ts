/**
 * 应用启动。
 *
 * 中间件顺序是有讲究的（Express 里按 use 的先后跑）：
 *
 *   1. helmet        安全响应头 —— 最早，任何响应都要带
 *   2. compression   压缩 —— 在业务响应产生前生效
 *   3. cookie-parser 解析 cookie —— refresh token 从这里读
 *   4. body parser   JSON / raw，各有各的大小限制
 *   5. cors          跨域 —— 必须在路由前，且带 credentials
 *   6. (RequestIdMiddleware 在 AppModule.configure 里挂)
 *   7. Nest 路由 + Guard + Interceptor + Filter
 *
 * 顺序错一个就会有奇怪的问题：比如 CORS 放在路由后面，
 * 预检请求根本走不到 CORS 中间件，浏览器直接报跨域。
 */

import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { AppError } from './common/errors/app-error';
import { CollabServer } from './modules/collab/collab.server';

async function bootstrap(): Promise<void> {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
        // 关掉 Nest 自带的日志，交给 pino —— 否则每条请求会有两行日志
        bufferLogs: true,
    });

    const config = app.get(AppConfigService);

    // ── 反向代理 ──
    // 生产环境 nginx 在前面，必须信任一跳代理，否则 req.ip 全是 nginx 容器的地址，
    // 限流会把所有用户算成同一个人（第一个撞上限的人拖累所有人），审计日志也会失真。
    // 只在显式配置时开启 —— 直连部署信任 X-Forwarded-For 等于允许客户端伪造 IP。
    if (config.http.trustProxy > 0) {
        app.set('trust proxy', config.http.trustProxy);
    }

    // ── 日志 ──
    app.useLogger(app.get(PinoLogger));

    // ── 安全响应头 ──
    // CSP 关掉：服务端只出 JSON，前端是独立站点，CSP 由前端自己管。
    // 这里保留其余所有防护头（X-Frame-Options / X-Content-Type-Options / HSTS…）
    app.use(
        helmet({
            contentSecurityPolicy: false,
            crossOriginResourcePolicy: { policy: 'same-site' },
        })
    );

    // ── 压缩 ──
    // 阈值以下的响应不压：小 body 压缩的收益抵不过 CPU 开销
    app.use(
        compression({
            threshold: config.http.compressionThreshold,
            // 二进制（快照已经是 gzip 过的）不重复压缩
            filter: (req, res) => {
                if (req.headers['x-no-compression']) return false;
                return compression.filter(req, res);
            },
        })
    );

    // ── cookie ──
    app.use(cookieParser());

    // ── body 解析 ──
    // JSON 走默认路由；raw 专门给将来传 Yjs update 二进制用，限制放宽
    app.use(express.json({ limit: config.http.jsonLimit }));
    app.use(
        express.raw({
            type: 'application/octet-stream',
            limit: config.http.rawLimit,
        })
    );
    app.use(express.urlencoded({ extended: true, limit: config.http.jsonLimit }));

    // ── CORS ──
    // 必须带 credentials，否则浏览器不会带上 httpOnly cookie
    app.enableCors({
        origin: (origin, callback) => {
            // 同源请求（curl / SSR / 服务间调用）没有 Origin 头，放行
            if (!origin) return callback(null, true);
            if (config.http.corsOrigins.includes(origin)) return callback(null, true);
            return callback(new Error(`跨域被拒绝：${origin}`), false);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'If-None-Match'],
        exposedHeaders: [
            'X-Request-Id',
            'ETag',
            'X-RateLimit-Limit',
            'X-RateLimit-Remaining',
            'Retry-After',
        ],
        maxAge: 86400, // 预检结果缓存一天
    });

    // ── 入参校验 ──
    app.useGlobalPipes(
        new ValidationPipe({
            // 白名单：DTO 里没声明的字段一律丢掉，防参数污染
            whitelist: true,
            // 多传字段直接报错而不是默默丢掉 —— 静默丢弃会让客户端以为写进去了
            forbidNonWhitelisted: true,
            transform: true,
            transformOptions: {
                // query 里的 limit=20 自动转成 number
                enableImplicitConversion: true,
            },
            validationError: { target: false, value: false },
            // 默认的 ValidationPipe 抛 BadRequestException(400)，
            // 但入参不合法是「语义错误」不是「请求格式错误」，按本项目的
            // 错误码表应该是 VALIDATION_FAILED(422)。统一到 AppError 上，
            // 客户端才能按 code 分支而不是按 status 猜。
            exceptionFactory: (errors) => {
                const details = errors.flatMap((e) =>
                    Object.entries(e.constraints ?? {}).map(([rule, message]) => ({
                        field: e.property,
                        rule,
                        message,
                    }))
                );
                return AppError.validation('入参校验失败', details);
            },
        })
    );

    // ── 优雅关闭 ──
    // 等在途请求处理完再退出，否则部署时会有一批 502
    app.enableShutdownHooks();

    // ── 协同 WebSocket ──
    // 挂到同一个 HTTP server 上，共用端口（走 HTTP Upgrade）
    const httpServer = app.getHttpServer() as unknown as import('node:http').Server;
    app.get(CollabServer).attach(httpServer);

    await app.listen(config.port);

    const logger = new Logger('Bootstrap');
    logger.log(`服务已启动：http://localhost:${config.port}`);
    logger.log(`健康检查：http://localhost:${config.port}/health/ready`);
    logger.log(`协同入口：ws://localhost:${config.port}/collab/:documentId`);
}

void bootstrap();
