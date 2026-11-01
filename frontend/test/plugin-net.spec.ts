/**
 * 插件网络 API：路径校验、登录态注入、401 单飞刷新。
 */

import { describe, expect, it, vi } from 'vitest';
import { createPluginNet } from '../src/app/plugins/api/net';

function makeResponse(status: number): Response {
    return new Response(null, { status });
}

describe('插件网络 API', () => {
    it('拒绝绝对路径与协议相对路径', async () => {
        const net = createPluginNet();

        await expect(net.fetch('https://example.com/api')).rejects.toMatchObject({
            code: 'E_PLUGIN_INVALID_INPUT',
        });
        await expect(net.fetch('//example.com/api')).rejects.toMatchObject({
            code: 'E_PLUGIN_INVALID_INPUT',
        });
        await expect(net.fetch('api/v1/ai/config')).rejects.toMatchObject({
            code: 'E_PLUGIN_INVALID_INPUT',
        });
    });

    it('401 时走宿主单飞刷新，并只重试一次', async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce(makeResponse(401))
            .mockResolvedValueOnce(makeResponse(200));
        const refreshAccessToken = vi.fn(async () => true);

        const net = createPluginNet({
            request,
            getAccessToken: () => 'access-token',
            refreshAccessToken,
        });

        const response = await net.fetch('/api/v1/ai/config', {
            method: 'POST',
            headers: { Accept: 'application/json' },
            body: { hello: 'world' },
        });

        expect(response.status).toBe(200);
        expect(refreshAccessToken).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledTimes(2);
        expect(request.mock.calls[0]?.[1]).toMatchObject({
            method: 'POST',
            headers: { Accept: 'application/json' },
            body: { hello: 'world' },
            raw: true,
        });
        expect(request.mock.calls[1]?.[1]).toMatchObject({
            skipAuthRefresh: true,
            raw: true,
        });
    });

    it('没有 access token 时不尝试刷新', async () => {
        const request = vi.fn(async () => makeResponse(401));
        const refreshAccessToken = vi.fn(async () => true);

        const net = createPluginNet({
            request,
            getAccessToken: () => null,
            refreshAccessToken,
        });

        const response = await net.fetch('/api/v1/ai/config');

        expect(response.status).toBe(401);
        expect(refreshAccessToken).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('刷新失败时返回原始 401，不无限重试', async () => {
        const request = vi.fn(async () => makeResponse(401));
        const refreshAccessToken = vi.fn(async () => false);

        const net = createPluginNet({
            request,
            getAccessToken: () => 'expired',
            refreshAccessToken,
        });

        const response = await net.fetch('/api/v1/ai/config');

        expect(response.status).toBe(401);
        expect(refreshAccessToken).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledTimes(1);
    });
});
