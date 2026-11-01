/**
 * 插件网络 API 的宿主实现。
 *
 * 不做权限拦截：同 realm 插件本来就能直接 `fetch`，这里只是把「登录态」做对。
 * 关键点：
 *   - 复用宿主客户端的 Authorization 注入；
 *   - 401 时走宿主的单飞刷新，避免插件自己刷新把 refresh token 顶掉；
 *   - 返回原生 `Response`，插件可以自己消费 SSE 流。
 */

import type { NetApi, NetRequestInit } from '@pgclouddoc/plugin-api';
import { PluginApiError } from '@pgclouddoc/plugin-api/errors';
import {
  getAccessToken,
  refreshAccessToken,
  request,
  type RequestOptions,
} from '../../api/client';

type RequestFn = (path: string, options?: RequestOptions) => Promise<Response>;

export interface PluginNetDeps {
  /** 测试注入；默认用宿主 api/client 的 request */
  request?: RequestFn;
  getAccessToken?: () => string | null;
  refreshAccessToken?: () => Promise<boolean>;
}

export function createPluginNet(deps: PluginNetDeps = {}): NetApi {
  const send: RequestFn =
    deps.request ?? ((path, options) => request<Response>(path, options));
  const readToken = deps.getAccessToken ?? getAccessToken;
  const refresh = deps.refreshAccessToken ?? refreshAccessToken;

  return {
    async fetch(path: string, init: NetRequestInit = {}): Promise<Response> {
      assertSameOriginPath(path);

      const options: RequestOptions = {
        method: init.method ?? 'GET',
        headers: init.headers,
        body: init.body,
        signal: init.signal,
        // raw：不解析宿主的 { success, data } 信封，把 Response 原样交给插件
        raw: true,
      };

      let response = await send(path, options);
      if (response.status === 401 && readToken()) {
        const refreshed = await refresh();
        if (refreshed) {
          response = await send(path, { ...options, skipAuthRefresh: true });
        }
      }
      return response;
    },
  };
}

function assertSameOriginPath(path: string): void {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    !path.startsWith('/') ||
    path.startsWith('//')
  ) {
    throw new PluginApiError(
      'E_PLUGIN_INVALID_INPUT',
      `net.fetch 只接受同源相对路径（以 / 开头）：${String(path)}`
    );
  }
}
