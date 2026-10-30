/**
 * 文档 DTO。
 *
 * 出参分两档：
 *   DocumentSummary —— 列表页用，**不带快照**。快照动辄几 MB，
 *                      列表页返回 20 个快照等于一次 50MB 的响应，是明显的性能事故。
 *   DocumentDetail  —— 详情页用，带元信息但同样不带快照（快照走单独接口）。
 */

import {
    IsInt,
    IsNotEmpty,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto';

export class CreateDocumentDto {
    @IsString()
    @IsNotEmpty({ message: '文档名不能为空' })
    @MinLength(1, { message: '文档名不能为空' })
    @MaxLength(128, { message: '文档名最多 128 字' })
    name!: string;

    @IsOptional()
    @IsString()
    @MaxLength(1024)
    description?: string;

    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(10000)
    rowCount?: number;

    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(1024)
    columnCount?: number;
}

export class UpdateDocumentDto {
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(128)
    name?: string;

    @IsOptional()
    @IsString()
    @MaxLength(1024)
    description?: string;

    @IsOptional()
    @IsString()
    @MaxLength(64)
    status?: 'ACTIVE' | 'ARCHIVED';
}

export class ListDocumentsDto extends PageQueryDto {
    @IsOptional()
    @IsString()
    @MaxLength(128)
    keyword?: string;

    @IsOptional()
    @IsString()
    status?: 'ACTIVE' | 'ARCHIVED' | 'DELETED';
}

export interface DocumentSummary {
    id: string;
    name: string;
    description: string | null;
    status: string;
    ownerId: string;
    ownerName: string;
    snapshotVersion: number;
    versionCount: number;
    docSize: number;
    cellCount: number;
    createdAt: string;
    updatedAt: string;
}

export interface DocumentDetail extends DocumentSummary {
    contentHash: string | null;
    deletedAt: string | null;
}

export interface DocumentVersionDto {
    id: string;
    versionNo: number;
    name: string | null;
    remark: string | null;
    sizeBytes: number;
    createdAt: string;
}
