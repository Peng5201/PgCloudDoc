/**
 * 游标分页。
 *
 * 为什么不用 offset 分页：文档列表按 updated_at 倒序，
 * offset 在插入/删除时会漏项或重复；游标锚定在「上一页最后一条的排序键」上，
 * 翻页结果稳定，而且走索引比 OFFSET N 快得多。
 */

import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class PageQueryDto {
    @IsOptional()
    @IsString()
    /** 上一页返回的 cursor；不传表示取第一页 */
    cursor?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit = 20;
}

export interface PageResult<T> {
    items: T[];
    /** 下一页游标；null 表示没有更多 */
    nextCursor: string | null;
    /** 是否还有下一页 */
    hasMore: boolean;
}

/**
 * 把一组记录按游标格式切出来。
 *
 * `hasMore` 的判断技巧：多查一条（limit+1），有就说明还有下一页，
 * 然后把多的那条丢掉。比 `SELECT COUNT(*)` 便宜太多。
 */
export function toPage<T>(
    rows: T[],
    limit: number,
    getCursor: (row: T) => string
): PageResult<T> {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
        items,
        nextCursor: hasMore && items.length > 0 ? getCursor(items[items.length - 1]) : null,
        hasMore,
    };
}
