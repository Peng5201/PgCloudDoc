/**
 * 客户端插件索引。
 *
 * 全局 JwtAuthGuard 默认拒绝匿名访问；登录用户在首次进入应用后拉取。
 * 这里只返回启用且已发布的插件，kill switch 走 etcd 的 client 配置。
 */

import { Controller, Get } from '@nestjs/common';
import type { PluginIndex } from '@pgclouddoc/plugin-api';
import { PluginService } from './plugin.service';

@Controller('api/v1/plugins')
export class PluginsController {
    constructor(private readonly plugins: PluginService) {}

    @Get('index')
    index(): Promise<PluginIndex> {
        return this.plugins.getIndex();
    }
}
