/**
 * 配置中心入参。
 *
 * value 用 unknown 接收任意 JSON —— 配置值本来就没有固定形状，
 * 具体语义由前端/后端在使用处约定。这里只保证：
 *   - 必须显式给出（不能省字段）
 *   - 整个值是 JSON 可序列化的（序列化在 service 里做，失败返回 422）
 */

import { IsDefined, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpsertConfigDto {
    @IsDefined({ message: 'value 不能为空' })
    value!: unknown;

    @IsOptional()
    @IsString()
    @MaxLength(200)
    description?: string;

    /**
     * 乐观并发：提交时带上列表里看到的 revision，
     * 期间被别人改过就返回 409，而不是覆盖。
     */
    @IsOptional()
    @IsInt()
    @Min(1)
    expectedRevision?: number;
}

export class RollbackConfigDto {
    @IsInt()
    @Min(1)
    revision!: number;
}
