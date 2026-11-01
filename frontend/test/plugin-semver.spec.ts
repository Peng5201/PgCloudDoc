/**
 * engines.pgclouddoc 的范围判断。
 * 这里只覆盖 manifest 实际会用到的写法，非法范围必须一律 false（宁可不加载）。
 */

import { describe, expect, it } from 'vitest';
import { satisfiesVersionRange } from '@pgclouddoc/plugin-api/semver';

describe('插件宿主版本范围', () => {
    it('支持比较器组合', () => {
        expect(satisfiesVersionRange('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
        expect(satisfiesVersionRange('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
        expect(satisfiesVersionRange('0.9.9', '>=1.0.0 <2.0.0')).toBe(false);
    });

    it('支持 ^ 与 ~', () => {
        expect(satisfiesVersionRange('1.9.0', '^1.4.0')).toBe(true);
        expect(satisfiesVersionRange('2.0.0', '^1.4.0')).toBe(false);
        expect(satisfiesVersionRange('1.4.9', '~1.4.0')).toBe(true);
        expect(satisfiesVersionRange('1.5.0', '~1.4.0')).toBe(false);
    });

    it('支持 || 与通配', () => {
        expect(satisfiesVersionRange('1.2.0', '1.2.0 || 2.0.0')).toBe(true);
        expect(satisfiesVersionRange('3.0.0', '1.2.0 || 2.0.0')).toBe(false);
        expect(satisfiesVersionRange('9.9.9', '*')).toBe(true);
    });

    it('非法输入返回 false', () => {
        expect(satisfiesVersionRange('abc', '>=1.0.0')).toBe(false);
        expect(satisfiesVersionRange('1.0.0', 'not-a-range')).toBe(false);
    });
});
