/**
 * 前缀和累加器 —— 整个渲染引擎的心脏。
 *
 * 对照 Univer: packages/engine-render/src/components/sheets/sheet.render-skeleton.ts
 *              里 rowHeightAccumulation / columnWidthAccumulation 的用法
 *
 * 问题：给定行号 r，它在像素坐标系里的 y 是多少？
 *
 * 朴素做法：遍历 0..r-1 把行高加起来 —— O(r)。
 *   画 100 个格子就是 O(100 * r)，滚到第 5000 行时每帧都要算 50 万次加法。
 *
 * 前缀和做法：
 *   prefix[i] = 前 i 行的总高度（即第 0..i-1 行高度之和）
 *   第 r 行顶部 y = prefix[r]，行高 = prefix[r+1] - prefix[r] —— 都是 O(1)
 *   反过来像素 → 行号用二分 —— O(log n)
 *
 * 重建是 O(n)，但只在行高变化时做一次。这正是「布局计算」和「绘制」分离的收益：
 * 改一行高 → 重建一次累加数组 → 之后每一帧的定位都是 O(1)。
 */
export class Accumulator {
    /** prefix[i] = sizes[0..i-1] 的总和，长度 = sizes.length + 1 */
    private _prefix: number[] = [0];
    private _sizes: number[] = [];

    rebuild(sizes: number[]): void {
        this._sizes = sizes;
        const n = sizes.length;
        const prefix = new Array<number>(n + 1);
        prefix[0] = 0;
        for (let i = 0; i < n; i++) {
            prefix[i + 1] = (prefix[i] ?? 0) + (sizes[i] ?? 0);
        }
        this._prefix = prefix;
    }

    get length(): number {
        return this._sizes.length;
    }

    /** 总长度（所有行高的总和 / 所有列宽的总和） */
    get total(): number {
        return this._prefix[this._prefix.length - 1] ?? 0;
    }

    /** 第 index 项的起始像素位置 */
    start(index: number): number {
        return this._prefix[this._clampIndex(index)] ?? 0;
    }

    /** 第 index 项的结束像素位置（不含） */
    end(index: number): number {
        return this._prefix[Math.min(index + 1, this._prefix.length - 1)] ?? 0;
    }

    /** 第 index 项的长度（像素） */
    size(index: number): number {
        return this.end(index) - this.start(index);
    }

    /**
     * 像素 → 下标，二分查找。
     * 返回满足 `prefix[i] <= pixel < prefix[i+1]` 的 i。
     */
    locate(pixel: number): number {
        const last = this._prefix.length - 1;
        if (pixel <= 0) return 0;
        if (pixel >= (this._prefix[last] ?? 0)) return Math.max(0, this._sizes.length - 1);

        let lo = 0;
        let hi = last;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if ((this._prefix[mid] ?? 0) <= pixel) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        return Math.max(0, Math.min(lo, this._sizes.length - 1));
    }

    private _clampIndex(index: number): number {
        return Math.max(0, Math.min(index, this._prefix.length - 1));
    }
}
