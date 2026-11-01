/**
 * AI 助手接口。
 *
 * `turns` 是 SSE：只有它需要完全接管响应体（@SkipWrap + @Res）。
 * 其余接口走统一 JSON 信封。
 */

import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    Query,
    Req,
    Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
    AI_SSE,
    type AiConfigResponse,
    type AiConversationDetail,
    type AiConversationSummary,
} from '@pgclouddoc/ai-protocol';
import { CurrentUser, type AuthUser } from '../../shared/decorators/auth.decorators';
import { RateLimit } from '../../shared/guards/rate-limit.guard';
import { SkipWrap } from '../../shared/interceptors/response.interceptor';
import { toSseErrorPayload } from './ai.errors';
import { AiService } from './ai.service';
import {
    AiTurnRequestDto,
    CreateAiConversationDto,
    ListAiConversationsDto,
    UpdateAiConversationDto,
} from './dto/ai.dto';
import { createSseWriter } from './stream/sse';

@Controller('api/v1/ai')
export class AiController {
    constructor(private readonly ai: AiService) {}

    @Get('config')
    config(): AiConfigResponse {
        return this.ai.getConfig();
    }

    @Post('conversations')
    create(
        @CurrentUser() user: AuthUser,
        @Body() dto: CreateAiConversationDto
    ): Promise<AiConversationSummary> {
        return this.ai.createConversation(user.id, dto);
    }

    @Get('conversations')
    list(
        @CurrentUser() user: AuthUser,
        @Query() query: ListAiConversationsDto
    ): Promise<AiConversationSummary[]> {
        return this.ai.listConversations(user.id, query.documentId);
    }

    @Get('conversations/:id')
    detail(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string
    ): Promise<AiConversationDetail> {
        return this.ai.getConversation(user.id, id);
    }

    @Patch('conversations/:id')
    rename(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string,
        @Body() dto: UpdateAiConversationDto
    ): Promise<AiConversationSummary> {
        return this.ai.renameConversation(user.id, id, dto.title ?? '');
    }

    @Delete('conversations/:id')
    @HttpCode(200)
    async remove(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string
    ): Promise<{ ok: true }> {
        await this.ai.deleteConversation(user.id, id);
        return { ok: true };
    }

    /**
     * 推进一轮对话（SSE）。
     *
     * 前置校验（对话归属、文档权限、配额、入参）全部发生在写响应头之前，
     * 所以那些错误仍然返回标准 JSON 错误；一旦开始流式输出，
     * 后续问题统一通过 `event: error` 送达。
     */
    @Post('conversations/:id/turns')
    @RateLimit({ bucket: 'ai:turn', windowMs: 60_000, limit: 20 })
    @SkipWrap()
    async turn(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string,
        @Body() dto: AiTurnRequestDto,
        @Req() request: Request,
        @Res() response: Response
    ): Promise<void> {
        const writer = createSseWriter(response);
        const abort = new AbortController();
        const onClose = (): void => abort.abort();

        request.once('close', onClose);
        try {
            await this.ai.runTurn(user.id, id, dto, writer, abort.signal);
        } catch (err) {
            // 还没开始 SSE → 交给全局异常过滤器返回 JSON
            if (!response.headersSent) throw err;
            writer.send(AI_SSE.error, { ...toSseErrorPayload(err), retryable: false });
        } finally {
            request.off('close', onClose);
            writer.end();
        }
    }
}
