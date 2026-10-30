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
import { YDocStore } from '../../infra/yjs/ydoc-store';
import { materialize, applySnapshot } from '../../infra/yjs/ydoc';
import type { SnapshotWorkbook } from '../../infra/yjs/ydoc.types';
import { CacheService } from '../../infra/redis/cache.service';
import { KafkaService } from '../../infra/kafka/kafka.service';
import { KafkaTopic } from '../../infra/kafka/topics';
import type { DocSnapshotRequestedEvent } from '../../infra/kafka/events';
import { AppError } from '../../common/errors/app-error';
import { PageResult, toPage } from '../../common/dto/pagination.dto';
import {
    CreateDocumentDto,
    DocumentDetail,
    DocumentSummary,
    DocumentVersionDto,
    ListDocumentsDto,
    UpdateDocumentDto,
} from './dto/document.dto';

export interface SnapshotPayload {
    workbook: SnapshotWorkbook;
    contentHash: string;
    sizeBytes: number;
    updatedAt: Date;
}

@Injectable()
export class DocumentService {
    private readonly logger = new Logger(DocumentService.name);

    constructor(
        private readonly documents: DocumentRepository,
        private readonly ydocStore: YDocStore,
        private readonly cache: CacheService,
        private readonly kafka: KafkaService
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

        return toPage(rows.map(toSummary), query.limit, (row) =>
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
        await this.getAccessibleRow(userId, documentId);

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
        await this.getAccessibleRow(userId, documentId);
        await this.documents.softDelete(documentId);
        await this.invalidateMeta(documentId);
        this.ydocStore.evict(documentId);
    }

    /** 复制一份，内容跟着走 */
    async duplicate(userId: string, documentId: string): Promise<DocumentDetail> {
        const row = await this.getAccessibleRow(userId, documentId);
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

    /** 手动归档（「保存为版本」按钮） */
    async archive(
        documentId: string,
        userId: string | undefined,
        remark?: string
    ): Promise<{ versionNo: number }> {
        const { snapshot, contentHash, sizeBytes, cellCount } =
            await this.ydocStore.buildSnapshot(documentId);

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

        return { versionNo };
    }

    /**
     * 异步归档：发个事件让 worker 去做，接口立刻返回。
     * 用在「文档刚被协同编辑完，过一会儿自动存一版」这种不着急的场景。
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
        await this.getAccessibleRow(userId, documentId);

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
     * 取文档行并校验访问权。
     * 越权 / 不存在 统一抛 404（见文件头注释）。
     */
    async getAccessibleRow(userId: string, documentId: string): Promise<DocumentListRow> {
        const row = await this.documents.findByIdFromView(documentId);
        if (!row || row.owner_id !== userId) {
            throw AppError.notFound('文档不存在');
        }
        return row;
    }

    private async invalidateMeta(documentId: string): Promise<void> {
        await this.cache.invalidate(`doc:meta:${documentId}`);
    }
}

// ─────────────────────────── 映射 / 游标 ───────────────────────────

function toSummary(row: DocumentListRow): DocumentSummary {
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
    };
}

function toDetail(row: DocumentListRow): DocumentDetail {
    return {
        ...toSummary(row),
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
