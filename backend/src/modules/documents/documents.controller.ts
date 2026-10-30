/**
 * 文档接口。
 *
 * 缓存策略分三档（见 common/interceptors/http-cache）：
 *   列表    —— no-cache，每次都协商，因为变化频繁且体积小
 *   详情    —— private + must-revalidate，靠 ETag 省掉重复响应体
 *   快照    —— 最值钱的一处：几 MB 的 JSON，命中 304 时一个字节都不传
 */

import {
    Body,
    Controller,
    DefaultValuePipe,
    Delete,
    Get,
    HttpCode,
    Param,
    ParseIntPipe,
    Patch,
    Post,
    Query,
    Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { DocumentService } from './document.service';
import {
    AccessRequestDto,
    ApproveAccessRequestDto,
    CreateDocumentDto,
    DocumentDetail,
    DocumentSummary,
    DocumentVersionDto,
    ListDocumentsDto,
    MemberDto,
    UpdateDocumentDto,
} from './dto/document.dto';
import { CurrentUser, type AuthUser } from '../../common/decorators/auth.decorators';
import { PageResult } from '../../common/dto/pagination.dto';
import { HttpCache, ETAG_LOCAL } from '../../common/interceptors/http-cache.interceptor';
import { SkipWrap } from '../../common/interceptors/response.interceptor';
import type { SnapshotWorkbook } from '../../infra/yjs/ydoc.types';

@Controller('api/v1/documents')
export class DocumentsController {
    constructor(private readonly documents: DocumentService) {}

    @Get()
    list(
        @CurrentUser() user: AuthUser,
        @Query() query: ListDocumentsDto
    ): Promise<PageResult<DocumentSummary>> {
        return this.documents.list(user.id, query);
    }

    @Post()
    create(
        @CurrentUser() user: AuthUser,
        @Body() dto: CreateDocumentDto
    ): Promise<DocumentDetail> {
        return this.documents.create(user.id, dto);
    }

    @HttpCache({ etag: 'auto', maxAgeSeconds: 0, private: true, mustRevalidate: true })
    @Get(':id')
    detail(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string
    ): Promise<DocumentDetail> {
        return this.documents.detail(user.id, id);
    }

    @Patch(':id')
    update(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string,
        @Body() dto: UpdateDocumentDto
    ): Promise<DocumentDetail> {
        return this.documents.update(user.id, id, dto);
    }

    @Delete(':id')
    @HttpCode(200)
    async remove(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string
    ): Promise<{ deleted: true }> {
        await this.documents.remove(user.id, id);
        return { deleted: true };
    }

    @Post(':id/duplicate')
    duplicate(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string
    ): Promise<DocumentDetail> {
        return this.documents.duplicate(user.id, id);
    }

    // ─────────────────────── 快照 ───────────────────────

    /**
     * 取工作簿快照（前端 IWorkbookData）。
     *
     * 这里自己管响应体：返回的就是快照本身，不套 { success, data } 包装，
     * 否则前端要多解一层，而这份数据的契约本来就是「一个工作簿」。
     *
     * ETag 用 contentHash（内容哈希），内容没变就是同一个 ETag，
     * 客户端带 If-None-Match 回来直接 304。
     */
    @SkipWrap()
    @HttpCache({ etag: 'header', maxAgeSeconds: 0, private: true, mustRevalidate: true })
    @Get(':id/snapshot')
    async snapshot(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string,
        @Res({ passthrough: true }) res: Response
    ): Promise<SnapshotWorkbook> {
        const payload = await this.documents.getSnapshot(user.id, id);

        res.locals[ETAG_LOCAL] = `"${payload.contentHash}"`;
        // 快照是私有数据，绝不能进共享缓存
        res.setHeader('X-Snapshot-Size', String(payload.sizeBytes));

        return payload.workbook;
    }

    // ─────────────────────── 版本 / 归档 ───────────────────────

    @Post(':id/archive')
    @HttpCode(200)
    async archive(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string,
        @Body() body: { remark?: string }
    ): Promise<{ versionNo: number; created: boolean }> {
        await this.documents.getAccessibleRow(user.id, id, 'write');
        return this.documents.archive(id, user.id, body?.remark);
    }

    @Get(':id/versions')
    versions(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string
    ): Promise<DocumentVersionDto[]> {
        return this.documents.listVersions(user.id, id);
    }

    @Post(':id/versions/:versionNo/restore')
    @HttpCode(200)
    restore(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string,
        @Param('versionNo', ParseIntPipe) versionNo: number
    ): Promise<DocumentDetail> {
        return this.documents.restoreVersion(user.id, id, versionNo);
    }

    /**
     * 异步触发归档 —— 协同编辑结束后由前端调，或由服务端空闲检测触发。
     * 立刻 202，真正的归档走 Kafka。
     */
    @Post(':id/refresh-snapshot')
    @HttpCode(202)
    async requestArchive(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string,
        @Query('reason', new DefaultValuePipe('manual')) reason: string
    ): Promise<{ accepted: true }> {
        await this.documents.getAccessibleRow(user.id, id, 'write');
        await this.documents.requestArchive(id, user.id, reason);
        return { accepted: true };
    }

    // ─────────────────────── 权限协作 ───────────────────────

    @Get(':id/members')
    members(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string
    ): Promise<MemberDto[]> {
        return this.documents.listMembers(user.id, id);
    }

    @Patch(':id/members/:userId')
    @HttpCode(200)
    updateMemberRole(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string,
        @Param('userId') targetUserId: string,
        @Body() body: ApproveAccessRequestDto
    ): Promise<void> {
        return this.documents.updateMemberRole(user.id, id, targetUserId, body.role);
    }

    @Delete(':id/members/:userId')
    @HttpCode(200)
    removeMember(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string,
        @Param('userId') targetUserId: string
    ): Promise<void> {
        return this.documents.removeMember(user.id, id, targetUserId);
    }

    @Post(':id/access-requests')
    @HttpCode(201)
    requestAccess(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string
    ): Promise<void> {
        return this.documents.requestAccess(user.id, id);
    }

    @Get(':id/access-requests')
    accessRequests(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string
    ): Promise<AccessRequestDto[]> {
        return this.documents.listAccessRequests(user.id, id);
    }

    @Post(':id/access-requests/:requestId/approve')
    @HttpCode(200)
    approveAccessRequest(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string,
        @Param('requestId') requestId: string,
        @Body() body: ApproveAccessRequestDto
    ): Promise<void> {
        return this.documents.approveAccessRequest(user.id, id, requestId, body.role);
    }

    @Post(':id/access-requests/:requestId/reject')
    @HttpCode(200)
    rejectAccessRequest(
        @CurrentUser() user: AuthUser,
        @Param('id') id: string,
        @Param('requestId') requestId: string
    ): Promise<void> {
        return this.documents.rejectAccessRequest(user.id, id, requestId);
    }
}
