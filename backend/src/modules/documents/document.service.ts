/**
 * 文档业务逻辑。
 *
 * ## 行级安全
 *
 * 每个文档都挂在 ownerId 上，Service 的每个入口第一件事都是 `assertAccess`。
 * 越权访问返回 **404 而不是 403**：
 * 403 等于告诉攻击者「这个 id 存在，只是不是你的」，凭 id 可以枚举出别人有哪些文档。
 * 404 则让「不存在」和「不是你的」在外部看来完全一样。
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { DocumentRepository, type DocumentListRow } from './document.repository';
import { MemberRole } from '../../infra/prisma/generated/client';
import { NotificationService } from '../notifications/notification.service';
import { YDocStore } from '../../infra/yjs/ydoc-store';
import { materialize, applySnapshot } from '../../infra/yjs/ydoc';
import type { SnapshotWorkbook } from '../../infra/yjs/ydoc.types';
import { CacheService } from '../../infra/redis/cache.service';
import { KafkaService } from '../../infra/kafka/kafka.service';
import { KafkaTopic } from '../../infra/kafka/topics';
import type { DocSnapshotRequestedEvent } from '../../infra/kafka/events';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import {
    readWorkbook,
    writeWorkbook,
    defaultFormat,
    extensionOf,
    UnsupportedFormatError,
    CellLimitExceededError,
} from './formats';
import { PageResult, toPage } from '../../common/dto/pagination.dto';
import {
    AccessRequestDto,
    CreateDocumentDto,
    DocumentDetail,
    DocumentSummary,
    DocumentVersionDto,
    ListDocumentsDto,
    MemberDto,
    UpdateDocumentDto,
} from './dto/document.dto';

export interface SnapshotPayload {
    workbook: SnapshotWorkbook;
    contentHash: string;
    sizeBytes: number;
    updatedAt: Date;
}

/** 操作所需的权限级别：read=任何人可读 / write=owner+编辑 / own=仅 owner */
type AccessLevel = 'read' | 'write' | 'own';

/** 导入单元格上限：超过直接拒绝，提示拆分（更大体量应走异步队列） */
const MAX_IMPORT_CELLS = 2_000_000;

@Injectable()
export class DocumentService {
    private readonly logger = new Logger(DocumentService.name);

    constructor(
        private readonly documents: DocumentRepository,
        private readonly ydocStore: YDocStore,
        private readonly cache: CacheService,
        private readonly kafka: KafkaService,
        private readonly notifications: NotificationService
    ) {}

    // ─────────────────────────── 创建 ───────────────────────────

    async create(ownerId: string, dto: CreateDocumentDto): Promise<DocumentDetail> {
        const id = randomUUID();

        // 1. 建记录
        await this.documents.create({
            id,
            ownerId,
            name: dto.name,
            description: dto.description ?? null,
            rowCount: dto.rowCount ?? 200,
            columnCount: dto.columnCount ?? 26,
        });

        // 2. 初始化 Y.Doc。load() 会写入一份空工作簿作为 base，
        //    再把用户指定的名字/行列数盖上去（触发一次 update → 自动落库）
        const { doc } = await this.ydocStore.load(id);
        doc.transact(() => {
            const meta = doc.getMap('meta');
            meta.set('name', dto.name);
            if (dto.rowCount) meta.set('rowCount', dto.rowCount);
            if (dto.columnCount) meta.set('columnCount', dto.columnCount);

            const sheets = doc.getArray<Y.Map<unknown>>('sheets');
            const first = sheets.get(0);
            if (first) {
                if (dto.rowCount) first.set('rowCount', dto.rowCount);
                if (dto.columnCount) first.set('columnCount', dto.columnCount);
            }
        });

        // 3. 归档一个初始版本 —— 让「版本历史」从第一刻就完整
        await this.archive(id, ownerId, '初始版本');

        return this.detail(ownerId, id);
    }

    // ─────────────────────────── 列表 ───────────────────────────

    async list(
        ownerId: string,
        query: ListDocumentsDto
    ): Promise<PageResult<DocumentSummary>> {
        const decoded = decodeCursor(query.cursor);

        const rows = await this.documents.findManyForList({
            ownerId,
            status: query.status,
            keyword: query.keyword,
            cursorUpdatedAt: decoded?.updatedAt,
            cursorId: decoded?.id,
            // 多查一条用来判断 hasMore
            limit: query.limit + 1,
        });

        return toPage(rows.map((row) => toSummary(row, ownerId)), query.limit, (row) =>
            encodeCursor(row.updatedAt, row.id)
        );
    }

    // ─────────────────────────── 详情 ───────────────────────────

    async detail(userId: string, documentId: string): Promise<DocumentDetail> {
        // ⚠️ 鉴权必须在缓存**之前**。
        // 缓存命中时 loader 根本不会执行 —— 把鉴权写进 loader，
        // 等于「命中缓存就跳过鉴权」，任何人拿到一个合法 docId 就能读别人的数据。
        // 缓存的是「文档内容」，而「谁能看」是每次请求都要判的，两者不能混在一起。
        await this.getAccessibleRow(userId, documentId);

        // 列表/详情是读多写少的路径，用 Redis 挡一层
        return this.cache.getOrSet<DocumentDetail>(
            `doc:meta:${documentId}`,
            async () => {
                const row = await this.documents.findByIdFromView(documentId);
                if (!row) throw AppError.notFound('文档不存在');
                return toDetail(row);
            },
            { ttlMs: 10 * 60 * 1000, nullTtlMs: 30_000 }
        );
    }

    // ─────────────────────────── 改 ───────────────────────────

    async update(
        userId: string,
        documentId: string,
        dto: UpdateDocumentDto
    ): Promise<DocumentDetail> {
        const { role } = await this.getAccessibleRow(userId, documentId, 'write');

        // 文件名只有创建者能改；描述 / 状态仍按「编辑」权限放行
        if (dto.name !== undefined && role !== MemberRole.OWNER) {
            throw AppError.forbidden('只有创建者可以修改文档名');
        }

        await this.documents.update(documentId, {
            name: dto.name,
            description: dto.description,
            status: dto.status,
        });

        // 名字也在 Y.Doc 的 meta 里，两边要同步，否则协同用户看到的还是旧名字
        if (dto.name !== undefined) {
            const { doc } = await this.ydocStore.load(documentId);
            doc.transact(() => {
                doc.getMap('meta').set('name', dto.name);
            });
        }

        await this.invalidateMeta(documentId);
        return this.detail(userId, documentId);
    }

    /** 软删除 */
    async remove(userId: string, documentId: string): Promise<void> {
        await this.getAccessibleRow(userId, documentId, 'own');
        await this.documents.softDelete(documentId);
        await this.invalidateMeta(documentId);
        this.ydocStore.evict(documentId);
    }

    /** 复制一份，内容跟着走 */
    async duplicate(userId: string, documentId: string): Promise<DocumentDetail> {
        const { row } = await this.getAccessibleRow(userId, documentId);
        const snapshot = await this.getSnapshot(userId, documentId);

        const newId = randomUUID();
        await this.documents.create({
            id: newId,
            ownerId: userId,
            name: `${row.name} 副本`,
            description: row.description,
            rowCount: 200,
            columnCount: 26,
        });

        // 把快照灌进新文档的 Y.Doc
        const { doc } = await this.ydocStore.load(newId);
        applySnapshot(doc, {
            ...snapshot.workbook,
            id: newId,
            name: `${row.name} 副本`,
        });

        await this.archive(newId, userId, '复制生成');
        return this.detail(userId, newId);
    }

    // ─────────────────────────── 导入 / 导出 ───────────────────────────

    /**
     * 从工作簿文件导入成一份**新文档**。
     *
     * 解析失败不会影响任何现有文档 —— 这是「导入 = 新建」相对「覆盖」的核心优势。
     * 格式由 `formats/` 注册表按扩展名分发（目前支持 xlsx）。
     */
    async importDocument(
        ownerId: string,
        file: { buffer: Buffer; originalname: string }
    ): Promise<DocumentDetail> {
        const name = fileBaseName(file.originalname);

        let parsed;
        try {
            parsed = await readWorkbook(file.buffer, file.originalname, {
                name,
                maxCells: MAX_IMPORT_CELLS,
            });
        } catch (err) {
            if (err instanceof CellLimitExceededError) {
                throw new AppError(ErrorCode.PAYLOAD_TOO_LARGE, err.message);
            }
            if (err instanceof UnsupportedFormatError) {
                throw AppError.badRequest('不支持的文件格式');
            }
            this.logger.warn(`解析工作簿失败（${file.originalname}）：${String(err)}`);
            throw AppError.badRequest('无法解析该文件，请确认格式正确');
        }

        if (parsed.warnings.length > 0) {
            this.logger.log(`导入 ${file.originalname} 的降级项：${parsed.warnings.join('；')}`);
        }

        const id = randomUUID();
        const firstSheet = parsed.workbook.sheets[parsed.workbook.sheetOrder[0]];
        await this.documents.create({
            id,
            ownerId,
            name,
            description: null,
            rowCount: firstSheet?.rowCount ?? 200,
            columnCount: firstSheet?.columnCount ?? 26,
            cellCount: parsed.cellCount,
        });

        // 把解析结果灌进 Y.Doc —— 和 duplicate 用的是同一套写入逻辑
        const { doc } = await this.ydocStore.load(id);
        applySnapshot(doc, { ...parsed.workbook, id, name });

        // 从第一刻起版本历史就是完整的
        await this.archive(id, ownerId, '导入文件');
        return this.detail(ownerId, id);
    }

    /**
     * 导出为工作簿文件（默认 xlsx）。
     *
     * 以服务端 Y.Doc 为准 —— 客户端手里的数据可能落后于别人的实时编辑。
     */
    async exportDocument(
        userId: string,
        documentId: string
    ): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
        const { row } = await this.getAccessibleRow(userId, documentId, 'read');
        const { doc } = await this.ydocStore.load(documentId);
        const workbook = materialize(doc, documentId);
        const buffer = await writeWorkbook(workbook);
        return {
            buffer,
            filename: `${safeFilename(row.name || '工作簿')}${defaultFormat.extensions[0]}`,
            contentType: defaultFormat.contentType,
        };
    }

    // ─────────────────────────── 快照 ───────────────────────────

    /**
     * 取快照。返回 contentHash 给上层做 ETag，
     * 命中协商缓存时整个 body 都不用传 —— 这是云文档最值钱的一次优化。
     */
    async getSnapshot(userId: string, documentId: string): Promise<SnapshotPayload> {
        await this.getAccessibleRow(userId, documentId);

        const { doc } = await this.ydocStore.load(documentId);
        const workbook = materialize(doc, documentId);
        const encoded = this.ydocStore.encodeSnapshot(workbook);

        return {
            workbook,
            contentHash: encoded.contentHash,
            sizeBytes: encoded.sizeBytes,
            updatedAt: new Date(),
        };
    }

    /**
     * 归档（存一个版本）。
     *
     * 手动「保存为版本」和自动归档（空闲 / 断线）都走这里。
     * **内容与上一版完全一致时不新增版本** —— 否则只要有人在编辑，
     * 自动归档就会不停堆积一堆内容相同的版本。
     */
    async archive(
        documentId: string,
        userId: string | undefined,
        remark?: string
    ): Promise<{ versionNo: number; created: boolean }> {
        const { snapshot, contentHash, sizeBytes, cellCount } =
            await this.ydocStore.buildSnapshot(documentId);

        // documents.content_hash 是最近一次归档的内容哈希（由存储过程回写），
        // 直接比对它，命中就复用当前版本号
        const current = await this.documents.findByIdFromView(documentId);
        if (current && current.content_hash === contentHash) {
            return {
                versionNo: Number(current.snapshot_version),
                created: false,
            };
        }

        const versionNo = await this.documents.archiveVersion({
            documentId,
            actorId: userId,
            remark: remark ?? null,
            snapshot,
            sizeBytes,
            contentHash,
            cellCount,
        });

        await this.invalidateMeta(documentId);

        await this.kafka
            .publish(
                KafkaTopic.DocSnapshotCompleted,
                {
                    documentId,
                    versionNo,
                    sizeBytes,
                    contentHash,
                    userId,
                },
                documentId
            )
            .catch((err: unknown) => this.logger.warn(`快照事件发送失败：${String(err)}`));

        return { versionNo, created: true };
    }

    /**
     * 刷新文档的当前快照与统计，**不产生版本**。
     *
     * 自动归档（空闲 / 断线）走这里：只让列表里的体积、统计、更新时间保持最新，
     * 版本只由用户显式「保存为版本」产生，避免自动堆积。
     */
    async refreshSnapshotMeta(documentId: string): Promise<void> {
        const { snapshot, sizeBytes, cellCount } =
            await this.ydocStore.buildSnapshot(documentId);

        await this.documents.refreshSnapshot({
            documentId,
            snapshot,
            sizeBytes,
            cellCount,
        });
        await this.invalidateMeta(documentId);
    }

    /**
     * 异步归档：发个事件让 worker 去做，接口立刻返回。
     * reason=idle 时 worker 只刷新快照元数据，不新建版本。
     */
    async requestArchive(
        documentId: string,
        userId: string | undefined,
        reason: string
    ): Promise<void> {
        const event: Omit<DocSnapshotRequestedEvent, 'id' | 'occurredAt' | 'topic'> = {
            documentId,
            userId,
            reason: reason as DocSnapshotRequestedEvent['reason'],
        };
        await this.kafka.publish(KafkaTopic.DocSnapshotRequested, event, documentId);
    }

    // ─────────────────────────── 版本 ───────────────────────────

    async listVersions(userId: string, documentId: string): Promise<DocumentVersionDto[]> {
        await this.getAccessibleRow(userId, documentId);
        const rows = await this.documents.listVersions(documentId);
        return rows.map((r) => ({
            id: String(r.id),
            versionNo: Number(r.version_no),
            name: r.name,
            remark: r.remark,
            sizeBytes: Number(r.size_bytes),
            createdAt: r.created_at.toISOString(),
        }));
    }

    /** 回滚到某个版本 —— 破坏性覆盖当前内容 */
    async restoreVersion(
        userId: string,
        documentId: string,
        versionNo: number
    ): Promise<DocumentDetail> {
        await this.getAccessibleRow(userId, documentId, 'write');

        const version = await this.documents.findVersion(documentId, versionNo);
        if (!version) throw AppError.notFound(`版本 ${versionNo} 不存在`);

        const workbook = this.ydocStore.decodeSnapshot(Buffer.from(version.snapshot));
        const { doc } = await this.ydocStore.load(documentId);
        applySnapshot(doc, workbook);

        // 回滚本身也要留痕 —— 否则回滚错了没法再回滚回去
        await this.archive(documentId, userId, `回滚到版本 ${versionNo}`);

        return this.detail(userId, documentId);
    }

    // ─────────────────────────── 访问控制 ───────────────────────────

    /**
     * 取文档行并校验访问权，返回当前用户在该文档的角色。
     *
     * 两级错误语义：
     *   - 完全不可见（非 owner 且无成员记录）→ 404，防凭 id 枚举
     *   - 可见但角色不足 → 403，明确告知「权限不够」
     */
    async getAccessibleRow(
        userId: string,
        documentId: string,
        required: AccessLevel = 'read'
    ): Promise<{ row: DocumentListRow; role: MemberRole }> {
        const row = await this.documents.findByIdFromView(documentId);
        if (!row) throw AppError.notFound('文档不存在');

        let role: MemberRole;
        if (row.owner_id === userId) {
            role = MemberRole.OWNER;
        } else {
            const member = await this.documents.findMember(documentId, userId);
            if (!member) throw AppError.notFound('文档不存在');
            role = member.role as MemberRole;
        }

        if (!this.roleMeets(role, required)) {
            throw AppError.forbidden('没有权限执行此操作');
        }
        return { row, role };
    }

    private roleMeets(role: MemberRole, required: AccessLevel): boolean {
        if (required === 'read') return true;
        if (required === 'write') {
            return role === MemberRole.OWNER || role === MemberRole.EDITOR;
        }
        if (required === 'own') return role === MemberRole.OWNER;
        return false;
    }

    // ─────────────────────────── 成员管理 ───────────────────────────

    /** 成员列表（含 owner 自己）。任何可读角色都能查看 */
    async listMembers(userId: string, documentId: string): Promise<MemberDto[]> {
        const { row } = await this.getAccessibleRow(userId, documentId);
        const members = await this.documents.listMembers(documentId);
        const owner = await this.documents.findUser(row.owner_id);

        return [
            {
                userId: row.owner_id,
                role: 'OWNER' as const,
                email: owner?.email ?? '',
                username: owner?.username ?? row.owner_username,
                displayName: owner?.displayName ?? row.owner_display_name,
            },
            ...members.map((m) => ({
                userId: m.user_id,
                role: m.role as 'EDITOR' | 'VIEWER',
                email: m.email,
                username: m.username,
                displayName: m.display_name,
            })),
        ];
    }

    /** 改成员角色（owner only） */
    async updateMemberRole(
        userId: string,
        documentId: string,
        targetUserId: string,
        role: 'EDITOR' | 'VIEWER'
    ): Promise<void> {
        await this.getAccessibleRow(userId, documentId, 'own');
        await this.documents.upsertMember(documentId, targetUserId, role);
    }

    /** 移除成员（owner only） */
    async removeMember(
        userId: string,
        documentId: string,
        targetUserId: string
    ): Promise<void> {
        await this.getAccessibleRow(userId, documentId, 'own');
        await this.documents.removeMember(documentId, targetUserId);
    }

    // ─────────────────────────── 访问申请 ───────────────────────────

    /**
     * 申请访问（无权限用户）。
     * 幂等：已经是 owner/成员、或已有 pending 申请，都直接返回。
     */
    async requestAccess(userId: string, documentId: string): Promise<void> {
        const doc = await this.documents.findRaw(documentId);
        if (!doc || doc.status === 'DELETED') {
            throw AppError.notFound('文档不存在');
        }

        // 已经有权限，无需申请
        if (doc.ownerId === userId) return;
        const member = await this.documents.findMember(documentId, userId);
        if (member) return;

        // 已有待处理申请，幂等返回，不重复刷
        const pending = await this.documents.findPendingRequest(documentId, userId);
        if (pending) return;

        await this.documents.createAccessRequest(documentId, userId);

        const requester = await this.documents.findUser(userId);
        await this.notifications.create({
            userId: doc.ownerId,
            type: 'access-request',
            title: '新的访问申请',
            body: `${requester?.displayName ?? requester?.username ?? '有人'} 申请访问「${doc.name}」`,
            payload: { documentId, documentName: doc.name },
        });
    }

    /** 该文档的申请列表（owner only） */
    async listAccessRequests(
        userId: string,
        documentId: string
    ): Promise<AccessRequestDto[]> {
        await this.getAccessibleRow(userId, documentId, 'own');
        const rows = await this.documents.listAccessRequests(documentId);
        return rows.map((r) => ({
            id: r.id,
            requesterId: r.requester_id,
            requesterEmail: r.requester_email,
            requesterUsername: r.requester_username,
            requesterDisplayName: r.requester_display_name,
            status: r.status as AccessRequestDto['status'],
            decidedRole: (r.decided_role ?? null) as AccessRequestDto['decidedRole'],
            createdAt: r.created_at.toISOString(),
            decidedAt: r.decided_at?.toISOString() ?? null,
        }));
    }

    /** 同意申请：授予角色（审批时选择只读/编辑） */
    async approveAccessRequest(
        userId: string,
        documentId: string,
        requestId: string,
        role: 'EDITOR' | 'VIEWER'
    ): Promise<void> {
        await this.getAccessibleRow(userId, documentId, 'own');

        const request = await this.documents.findAccessRequest(requestId);
        if (
            !request ||
            request.documentId !== documentId ||
            request.status !== 'PENDING'
        ) {
            throw AppError.notFound('申请不存在或已处理');
        }

        await this.documents.decideAccessRequest(requestId, 'APPROVED', userId, role);
        await this.documents.upsertMember(documentId, request.requesterId, role);

        const doc = await this.documents.findRaw(documentId);
        await this.notifications.create({
            userId: request.requesterId,
            type: 'access-approved',
            title: '访问申请已通过',
            body: `你对「${doc?.name ?? '文档'}」的申请已通过，角色：${
                role === 'EDITOR' ? '可编辑' : '只读'
            }`,
            payload: { documentId, role },
        });
    }

    /** 拒绝申请 */
    async rejectAccessRequest(
        userId: string,
        documentId: string,
        requestId: string
    ): Promise<void> {
        await this.getAccessibleRow(userId, documentId, 'own');

        const request = await this.documents.findAccessRequest(requestId);
        if (
            !request ||
            request.documentId !== documentId ||
            request.status !== 'PENDING'
        ) {
            throw AppError.notFound('申请不存在或已处理');
        }

        await this.documents.decideAccessRequest(requestId, 'REJECTED', userId, null);

        const doc = await this.documents.findRaw(documentId);
        await this.notifications.create({
            userId: request.requesterId,
            type: 'access-rejected',
            title: '访问申请被拒绝',
            body: `你对「${doc?.name ?? '文档'}」的申请被拒绝`,
            payload: { documentId },
        });
    }

    private async invalidateMeta(documentId: string): Promise<void> {
        await this.cache.invalidate(`doc:meta:${documentId}`);
    }
}

// ─────────────────────────── 映射 / 游标 ───────────────────────────

function toSummary(row: DocumentListRow, viewerId: string): DocumentSummary {
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        ownerId: row.owner_id,
        ownerName: row.owner_display_name ?? row.owner_username,
        snapshotVersion: Number(row.snapshot_version),
        versionCount: Number(row.version_count),
        docSize: Number(row.doc_size),
        cellCount: Number(row.cell_count),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        // owner 不在 members 表里，靠 owner_id 判断；成员走 member_role
        role: (row.owner_id === viewerId
            ? 'OWNER'
            : (row.member_role ?? 'VIEWER')) as DocumentSummary['role'],
    };
}

function toDetail(row: DocumentListRow): DocumentDetail {
    // 详情走缓存，role 是用户相关的不能进缓存，这里剥掉
    const { role: _role, ...summary } = toSummary(row, row.owner_id);
    return {
        ...summary,
        contentHash: row.content_hash,
        deletedAt: null,
    };
}

/**
 * 游标编码成 base64 的 `updatedAt|id`。
 * 放 URL 里不能有 `|` 和 `:`，所以统一 base64url。
 */
function encodeCursor(updatedAt: Date | string, id: string): string {
    const iso = typeof updatedAt === 'string' ? updatedAt : updatedAt.toISOString();
    return Buffer.from(`${iso}|${id}`, 'utf-8').toString('base64url');
}

function decodeCursor(
    cursor: string | undefined
): { updatedAt: Date; id: string } | undefined {
    if (!cursor) return undefined;
    try {
        const raw = Buffer.from(cursor, 'base64url').toString('utf-8');
        const sep = raw.lastIndexOf('|');
        if (sep < 0) return undefined;
        return { updatedAt: new Date(raw.slice(0, sep)), id: raw.slice(sep + 1) };
    } catch {
        // 游标坏了就当第一页，不要把用户挡在门外
        return undefined;
    }
}

/** `/path/报表.xlsx` → `报表`（去掉已识别的扩展名） */
function fileBaseName(originalname: string): string {
    const base = originalname.split(/[\\/]/).pop() ?? originalname;
    const ext = extensionOf(base);
    const name = (ext ? base.slice(0, base.length - ext.length) : base).trim();
    return name || '导入的文档';
}

/** 去掉文件名里的非法字符（Windows / POSIX 都照顾到） */
function safeFilename(name: string): string {
    return (
        name
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
            .trim()
            .slice(0, 100) || '工作簿'
    );
}
