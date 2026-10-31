/**
 * TokenService —— 给 Nest DI 用的薄包装，逻辑全在 `./token` 的 TokenIssuer 里。
 *
 * 为什么不直接把 `@Injectable()` 打在 TokenIssuer 上：
 *   Nest 12 发布的是纯 ESM 包（package.json 里 `type: module`），jest 30 在
 *   Node 22 上的 require() 实现不支持 `require(esm)`，连 `@Injectable` 都装不进来。
 *   把核心逻辑抽成无依赖的 `TokenIssuer` 之后，签发/验签/哈希都能脱离容器单测，
 *   这层包装只负责把配置塞进去。
 */

import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { TokenIssuer } from './token';

@Injectable()
export class TokenService extends TokenIssuer {
    constructor(config: AppConfigService) {
        // AppConfig.auth 的结构满足 TokenConfig（多一个 cookie 字段不影响）
        super(config.auth);
    }
}

export * from './token';
