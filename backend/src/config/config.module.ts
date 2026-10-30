import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './configuration';
import { validateEnv } from './env.validation';
import { AppConfigService } from './app-config.service';

/**
 * 全局配置模块。AppConfigService 在任何地方注入即可，不用重复 import。
 */
@Global()
@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            // 只在非测试环境读 .env，测试里全靠进程环境变量，避免读到开发配置
            envFilePath: process.env['NODE_ENV'] === 'test' ? [] : ['.env'],
            load: [configuration],
            validate: validateEnv,
        }),
    ],
    providers: [AppConfigService],
    exports: [AppConfigService],
})
export class AppConfigModule {}
