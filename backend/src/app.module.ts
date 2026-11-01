import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AppConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { KafkaModule } from './infrastructure/kafka/kafka.module';
import { YjsModule } from './infrastructure/yjs/yjs.module';
import { EtcdModule } from './infrastructure/etcd/etcd.module';

import { RequestIdMiddleware } from './shared/middleware/request-id.middleware';
import { AllExceptionsFilter } from './shared/filters/all-exceptions.filter';
import { ResponseInterceptor } from './shared/interceptors/response.interceptor';
import { HttpCacheInterceptor } from './shared/interceptors/http-cache.interceptor';
import { RateLimitGuard } from './shared/guards/rate-limit.guard';

import { AuthModule } from './features/auth/auth.module';
import { JwtAuthGuard } from './features/auth/jwt-auth.guard';
import { UsersModule } from './features/users/users.module';
import { DocumentsModule } from './features/documents/documents.module';
import { CollabModule } from './features/collab/collab.module';
import { JobsModule } from './features/jobs/jobs.module';
import { HealthModule } from './features/health/health.module';
import { NotificationsModule } from './features/notifications/notifications.module';
import { ConfigCenterModule } from './features/config-center/config-center.module';
import { PluginsModule } from './features/plugins/plugins.module';
import { AiModule } from './features/ai/ai.module';

@Module({
    imports: [
        // 日志最先注册，这样其它模块启动时的输出也是结构化的
        LoggerModule.forRootAsync({
            inject: [AppConfigService],
            useFactory: (config: AppConfigService) => ({
                pinoHttp: {
                    level: config.log.level,
                    // 开发用彩色单行，生产用 JSON（方便 ELK/Loki 采集）
                    ...(config.log.pretty && !config.isProduction
                        ? {
                              transport: {
                                  target: 'pino-pretty',
                                  options: {
                                      colorize: true,
                                      singleLine: true,
                                      translateTime: 'SYS:HH:MM:ss.l',
                                      ignore: 'pid,hostname,req.headers',
                                  },
                              },
                          }
                        : {}),
                    // 敏感字段脱敏：日志里绝不能出现明文 token / 密码
                    redact: {
                        paths: [
                            'req.headers.authorization',
                            'req.headers.cookie',
                            'req.headers["set-cookie"]',
                            'req.body.password',
                            'req.body.currentPassword',
                            'req.body.newPassword',
                            'req.body.refreshToken',
                            'res.headers["set-cookie"]',
                        ],
                        censor: '[REDACTED]',
                    },
                    // 快照接口的 body 可能几 MB，不能进日志
                    serializers: {
                        req: (req: {
                            method: string;
                            url: string;
                            id?: string;
                            ip?: string;
                        }) => ({
                            method: req.method,
                            url: req.url,
                            id: req.id,
                            ip: req.ip,
                        }),
                        res: (res: { statusCode: number }) => ({
                            statusCode: res.statusCode,
                        }),
                    },
                    autoLogging: {
                        ignore: (req: { url?: string }) => req.url?.startsWith('/health') ?? false,
                    },
                },
            }),
        }),

        AppConfigModule,
        PrismaModule,
        RedisModule,
        KafkaModule,
        YjsModule,
        EtcdModule,

        // 全局限流（Redis 滑动窗口）。个别接口用 @RateLimit 收紧
        ThrottlerModule.forRootAsync({
            inject: [AppConfigService],
            useFactory: (config: AppConfigService) => ({
                throttlers: [
                    {
                        name: 'global',
                        ttl: config.http.throttle.ttl,
                        limit: config.http.throttle.limit,
                    },
                ],
            }),
        }),

        AuthModule,
        UsersModule,
        DocumentsModule,
        CollabModule,
        JobsModule,
        HealthModule,
        NotificationsModule,
        ConfigCenterModule,
        PluginsModule,
        AiModule,
    ],
    controllers: [],
    providers: [
        // 全局异常过滤器 —— 最后一道兜底
        { provide: APP_FILTER, useClass: AllExceptionsFilter },

        // 响应包装在前，缓存拦截在后：
        // 缓存要拿「最终 body」算 ETag，包装后的内容才是客户端真正收到的
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
        { provide: APP_INTERCEPTOR, useClass: HttpCacheInterceptor },

        // Guard 顺序有意义：先认证拿到 user，限流才能按 userId 计数
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
    ],
})
export class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        // requestId 要跑在一切之前（异常过滤器要用它）
        consumer.apply(RequestIdMiddleware).forRoutes('*');
    }
}
