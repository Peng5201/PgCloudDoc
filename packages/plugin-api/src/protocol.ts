/**
 * 客户端插件索引。
 *
 * 服务端只下发渲染和加载入口所需的字段，完整 manifest 走详情接口。
 * 字段定义见 plugins/plugin-system-design.md 4.6。
 */

import type { PluginPermission } from './constants.js';
import type { PluginContributions } from './manifest.js';

export interface PluginIndexEntry {
  id: string;
  version: string;
  /** 静态资源根，必须以 / 结尾 */
  baseUrl: string;
  entry: string;
  style?: string;
  /** 主文件 SHA-256，用于展示/审计 */
  sha256?: string;
  engines: {
    pgclouddoc: string;
    pluginApi: string;
  };
  activationEvents: string[];
  contributes?: PluginContributions;
  permissions: PluginPermission[];
  /** 插件设置值（manifest 默认值 + 管理端覆盖），只有 client scope */
  settings: Record<string, unknown>;
}

export interface PluginIndex {
  revision: number;
  hostApiVersion: string;
  /** 全局 kill switch：为 true 时客户端不加载任何插件 */
  killSwitch: boolean;
  plugins: PluginIndexEntry[];
}
