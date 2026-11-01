/**
 * 类型安全的配置访问入口。
 *
 * 为什么不直接用 ConfigService：`get('app.auth.accessTokenTtl')` 返回 `any`，
 * 字段改名编译期不会报错。包一层之后路径写错就是编译错误。
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from './configuration';

@Injectable()
export class AppConfigService {
    private readonly cached: AppConfig;

    constructor(configService: ConfigService) {
        const value = configService.get<AppConfig>('app');
        if (!value) {
            // registerAs('app') 没注册时才会走到这，属于装配错误，早死早超生
            throw new Error('配置未加载：请检查 ConfigModule 是否 registerAs("app") 了 configuration');
        }
        this.cached = value;
    }

    /** 顶层配置对象，等价于 buildConfig() 的返回 */
    get all(): AppConfig {
        return this.cached;
    }

    get nodeEnv(): string {
        return this.cached.nodeEnv;
    }

    get isProduction(): boolean {
        return this.cached.isProduction;
    }

    get isTest(): boolean {
        return this.cached.isTest;
    }

    get port(): number {
        return this.cached.port;
    }

    get database() {
        return this.cached.database;
    }

    get redis() {
        return this.cached.redis;
    }

    get kafka() {
        return this.cached.kafka;
    }

    get auth() {
        return this.cached.auth;
    }

    get oauth() {
        return this.cached.oauth;
    }

    get http() {
        return this.cached.http;
    }

    get log() {
        return this.cached.log;
    }

    get collab() {
        return this.cached.collab;
    }

    get etcd() {
        return this.cached.etcd;
    }

    get admin() {
        return this.cached.admin;
    }

    get plugins() {
        return this.cached.plugins;
    }

    get ai() {
        return this.cached.ai;
    }
}
