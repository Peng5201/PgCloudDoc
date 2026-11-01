/**
 * manifest 是前后端和插件构建三方共用的契约，校验必须在这三个入口表现一致。
 * 这里覆盖最容易被写错的几个规则：默认值、命令引用、重复声明。
 */

import { describe, expect, it } from 'vitest';
import { parseManifest } from '@pgclouddoc/plugin-api';

const base = {
    manifestVersion: 1,
    id: 'com.example.demo',
    name: 'Demo 插件',
    version: '1.0.0',
    entry: 'dist/main.js',
    engines: { pgclouddoc: '>=1.0.0 <2.0.0', pluginApi: '1' },
};

describe('插件 manifest 校验', () => {
    it('合法清单补全默认值', () => {
        const manifest = parseManifest(base);
        expect(manifest.permissions).toEqual([]);
        expect(manifest.activationEvents).toEqual([]);
        expect(manifest.settings).toEqual([]);
    });

    it('拒绝未声明的工具栏命令', () => {
        expect(() =>
            parseManifest({
                ...base,
                contributes: {
                    toolbar: [{ slot: 'sheet.toolbar.end', command: 'demo.run' }],
                },
            })
        ).toThrow(/未在 contributes\.commands 中声明/);
    });

    it('接受声明完整的工具栏命令', () => {
        const manifest = parseManifest({
            ...base,
            activationEvents: ['onCommand:demo.run'],
            contributes: {
                commands: [{ id: 'demo.run', title: '运行' }],
                toolbar: [{ slot: 'sheet.toolbar.end', command: 'demo.run' }],
            },
        });
        expect(manifest.contributes?.toolbar).toHaveLength(1);
    });

    it('拒绝非法 id 与版本', () => {
        expect(() => parseManifest({ ...base, id: 'Demo Plugin' })).toThrow(/反向域名/);
        expect(() => parseManifest({ ...base, version: '1.0' })).toThrow(/semver/);
    });

    it('拒绝重复的设置 key', () => {
        expect(() =>
            parseManifest({
                ...base,
                settings: [
                    { key: 'delimiter', type: 'string', title: '分隔符' },
                    { key: 'delimiter', type: 'number', title: '重复' },
                ],
            })
        ).toThrow(/重复声明/);
    });
});
