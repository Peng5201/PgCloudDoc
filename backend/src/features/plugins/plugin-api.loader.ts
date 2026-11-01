/**
 * 以动态 import 加载共享协议包。
 *
 * backend 编译为 CommonJS，而 @pgclouddoc/plugin-api 是纯 ESM（"type": "module"），
 * `require()` 会直接失败。动态 import() 是 Node 里 CJS 加载 ESM 的标准方式；
 * 模块只加载一次，后续调用复用同一个 Promise。
 */

import type * as PluginApi from '@pgclouddoc/plugin-api';

let cached: Promise<typeof PluginApi> | null = null;

export function loadPluginApi(): Promise<typeof PluginApi> {
    cached ??= import('@pgclouddoc/plugin-api');
    return cached;
}
