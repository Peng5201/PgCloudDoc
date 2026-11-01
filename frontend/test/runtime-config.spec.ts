/**
 * 运行时配置的反序列化。
 *
 * 首屏配置来自 etcd（经 /api/v1/config 代理），必须能容忍脏数据：
 * 值缺失、类型不对、后端临时返回空对象，都不能把页面搞崩。
 */

import { describe, expect, it } from 'vitest';
import {
    DEFAULT_RUNTIME_CONFIG,
    deserializeRuntimeConfig,
} from '../src/app/config/runtime-config';

describe('运行时配置反序列化', () => {
    it('空值回退到默认配置', () => {
        const config = deserializeRuntimeConfig(null);
        expect(config.appName).toBe(DEFAULT_RUNTIME_CONFIG.appName);
        expect(config.maintenance.enabled).toBe(false);
        expect(config.features).toEqual({});
        expect(config.values).toEqual({});
        expect(config.version).toBe(0);
    });

    it('解析已知字段，并把 features.* 归并成开关表', () => {
        const config = deserializeRuntimeConfig({
            version: 42,
            updatedAt: '2026-10-31T00:00:00.000Z',
            values: {
                'app.name': '示例文档',
                'maintenance.enabled': true,
                'maintenance.message': '今晚 22:00 维护',
                'features.adminConsole': true,
                'features.deepLink': false,
                'features.bad': 'yes',
                'ui.theme': 'dark',
            },
        });

        expect(config.appName).toBe('示例文档');
        expect(config.maintenance).toEqual({ enabled: true, message: '今晚 22:00 维护' });
        // 非布尔值不能当成开
        expect(config.features).toEqual({ adminConsole: true, deepLink: false });
        // 未知 key 原样保留，给后续功能消费
        expect(config.values['ui.theme']).toBe('dark');
        expect(config.version).toBe(42);
        expect(config.updatedAt).toBe('2026-10-31T00:00:00.000Z');
        expect(config.source).toBe('server');
    });

    it('类型不对的已知字段退回默认值', () => {
        const config = deserializeRuntimeConfig({
            values: {
                'app.name': 123,
                'maintenance.enabled': 'true',
                'maintenance.message': '',
            },
        });

        expect(config.appName).toBe(DEFAULT_RUNTIME_CONFIG.appName);
        expect(config.maintenance.enabled).toBe(false);
        expect(config.maintenance.message).toBe(DEFAULT_RUNTIME_CONFIG.maintenance.message);
    });

    it('values 不是对象时也安全', () => {
        const config = deserializeRuntimeConfig({ values: ['a', 'b'] });
        expect(config.values).toEqual({});
        expect(config.appName).toBe(DEFAULT_RUNTIME_CONFIG.appName);
    });
});
