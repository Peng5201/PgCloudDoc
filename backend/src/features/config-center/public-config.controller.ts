/**
 * 浏览器首屏配置。
 *
 * **匿名可读**：首页在登录之前就要渲染，配置不能依赖登录态。
 * 所以这里只返回 client scope —— 服务端配置永远不会出现在这个响应里。
 *
 * 响应体很小（通常几百字节），由内存快照直接给出，不查 etcd：
 * 首屏路径上不能出现跨网 RPC。
 */

import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../shared/decorators/auth.decorators';
import { ConfigCenterService, type PublicConfig } from './config-center.service';

@Controller('api/v1/config')
export class PublicConfigController {
    constructor(private readonly configCenter: ConfigCenterService) {}

    @Public()
    @Get()
    async get(@Res({ passthrough: true }) res: Response): Promise<PublicConfig> {
        const config = await this.configCenter.getPublicConfig();
        // 配置随时可能在后台改掉：每次都要拿最新的，别让浏览器/代理缓存
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Config-Version', String(config.version));
        return config;
    }
}
