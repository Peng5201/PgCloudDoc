/**
 * AI 助手入参 DTO。
 *
 * `context` / `tools` / `results` 的内部结构由 @pgclouddoc/ai-protocol 定义，
 * 这里只做外层形状与体积的第一道校验；深层语义在 AiService 里按协议校验。
 */

import { Type } from 'class-transformer';
import {
    IsArray,
    IsIn,
    IsObject,
    IsOptional,
    IsString,
    MaxLength,
    ValidateNested,
} from 'class-validator';

export class CreateAiConversationDto {
    @IsOptional()
    @IsString()
    @MaxLength(128)
    documentId?: string;

    @IsOptional()
    @IsString()
    @MaxLength(200)
    title?: string;
}

export class UpdateAiConversationDto {
    @IsOptional()
    @IsString()
    @MaxLength(200)
    title?: string;
}

export class ListAiConversationsDto {
    @IsOptional()
    @IsString()
    @MaxLength(128)
    documentId?: string;
}

export class AiTurnInputDto {
    @IsIn(['user', 'tool_results'])
    type!: 'user' | 'tool_results';

    @IsOptional()
    @IsString()
    @MaxLength(32_000)
    text?: string;

    /** 工具结果数组；逐项校验在 AiService 里做 */
    @IsOptional()
    @IsArray()
    // 全局 ValidationPipe 开了 enableImplicitConversion；unknown[] 的元素类型
    // 推断不出来时会被 class-transformer 转成空数组。显式声明元素为 Object。
    @Type(() => Object)
    results?: Record<string, unknown>[];
}

export class AiTurnRequestDto {
    @IsString()
    @MaxLength(64)
    requestId!: string;

    @ValidateNested()
    @Type(() => AiTurnInputDto)
    input!: AiTurnInputDto;

    /** AiDocumentContext；序列化长度由服务端限制 */
    @IsObject()
    context!: Record<string, unknown>;

    /** AiToolDefinition[]；数量与总长度由服务端限制 */
    @IsArray()
    // 同上：不声明元素类型会被隐式转换成空数组
    @Type(() => Object)
    tools!: Record<string, unknown>[];

    @IsOptional()
    @IsString()
    @MaxLength(80)
    model?: string;
}
