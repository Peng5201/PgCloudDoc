/**
 * 文档 DAO。
 *
 * 两处刻意走裸 SQL（Prisma 管不到的部分）：
 *   1. `v_document_list` 视图 —— 列表页要 owner + 版本数，用视图一次拿全，避免 N+1
 *   2. `archive_document_version()` 存储过程 —— 归档的原子性由 DB 保证
 *
 * 事务注入：凡是接受 `tx` 参数的方法，都能在调用方的事务里跑；
 * 不传就用自己的连接。这样 Service 层可以自由组合成大事务。
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AccessRequestStatus, MemberRole } from '../../infrastructure/prisma/generated/client';
import type { Prisma } from '../../infrastructure/prisma/generated/client';

export type DbClient = Prisma.TransactionClient | PrismaService;

/** 视图 v_document_list 的一行 */
export interface DocumentListRow {
    id: string;
    owner_id: string;
    name: string;
    description: string | null;
    status: string;
    snapshot_version: number;
    content_hash: string | null;
    doc_size: number;
    cell_count: number;
    created_at: Date;
    updated_at: Date;
    owner_username: string;
    owner_display_name: string;
    version_count: bigint;
    /** 当前用户在 document_members 里的角色（owner 不在 members 表，为 null） */
    member_role: string | null;
}

export interface ListOptions {
    ownerId: string;
    status?: string;
    keyword?: string;
    /** 游标：锚点的 (updatedAt, id) */
    cursorUpdatedAt?: Date;
    cursorId?: string;
    limit: number;
}

/** document_members 一行（已 join 用户信息） */
export interface MemberRow {
    user_id: string;
    role: string;
    email: string;
    username: string;
    display_name: string | null;
    joined_at: Date;
}

/** document_access_requests 一行（已 join 申请人信息） */
export interface AccessRequestRow {
    id: string;
    document_id: string;
    requester_id: string;
    status: string;
    decided_role: string | null;
    created_at: Date;
    decided_at: Date | null;
    requester_email: string;
    requester_username: string;
    requester_display_name: string | null;
}

@Injectable()
export class DocumentRepository {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * 游标分页列表。
     *
     * 用 `(updated_at, id) < (cUpdatedAt, cId)` 复合游标：
     * updated_at 会重复（同一秒内改多个文档），必须用 id 兜底，
     * 否则翻页时会在重复的 updated_at 上漏项。
     *
     * 多查一条（limit+1）由 Service 判断 hasMore。
     */
    async findManyForList(options: ListOptions): Promise<DocumentListRow[]> {
        // 动态拼条件：$queryRaw 的参数化只能用在值上，条件本身得拼字符串
        // 列表范围 = 我拥有 + 我参与（document_members 里有我）
        const wheres: string[] = ['(d.owner_id = $1 OR m.document_id IS NOT NULL)'];
        const values: unknown[] = [options.ownerId];
        let idx = 2;

        if (options.status) {
            wheres.push(`d.status = $${idx}::"DocumentStatus"`);
            values.push(options.status);
            idx++;
        } else {
            wheres.push(`d.status != 'DELETED'`);
        }

        if (options.keyword) {
            wheres.push(`d.name ILIKE $${idx}`);
            values.push(`%${options.keyword.replace(/[%_]/g, '\\$&')}%`);
            idx++;
        }

        if (options.cursorUpdatedAt && options.cursorId) {
            wheres.push(`(d.updated_at, d.id) < ($${idx}, $${idx + 1})`);
            values.push(options.cursorUpdatedAt, options.cursorId);
            idx += 2;
        }

        values.push(options.limit);

        const sql = `
            SELECT d.*, m.role AS member_role
              FROM v_document_list d
              LEFT JOIN document_members m
                ON m.document_id = d.id AND m.user_id = $1
             WHERE ${wheres.join(' AND ')}
             ORDER BY d.updated_at DESC, d.id DESC
             LIMIT $${idx}
        `;

        return this.prisma.$queryRawUnsafe<DocumentListRow[]>(sql, ...values);
    }

    /** 视图里的 owner 信息已经 join 好了，单条查询直接用它 */
    async findByIdFromView(documentId: string): Promise<DocumentListRow | null> {
        const rows = await this.prisma.$queryRaw<DocumentListRow[]>`
            SELECT * FROM v_document_list WHERE id = ${documentId}
        `;
        return rows[0] ?? null;
    }

    async create(data: {
        id: string;
        ownerId: string;
        name: string;
        description?: string | null;
        rowCount: number;
        columnCount: number;
        cellCount?: number;
    }): Promise<{ id: string }> {
        return this.prisma.document.create({
            data: {
                id: data.id,
                ownerId: data.ownerId,
                name: data.name,
                description: data.description ?? null,
                cellCount: data.cellCount ?? 0,
            },
            select: { id: true },
        });
    }

    async update(
        id: string,
        data: { name?: string; description?: string; status?: string },
        tx?: DbClient
    ): Promise<void> {
        const client = tx ?? this.prisma;
        await client.document.update({
            where: { id },
            data: {
                ...(data.name !== undefined ? { name: data.name } : {}),
                ...(data.description !== undefined ? { description: data.description } : {}),
                ...(data.status !== undefined
                    ? { status: data.status as 'ACTIVE' | 'ARCHIVED' | 'DELETED' }
                    : {}),
            },
        });
    }

    /** 软删除：不物理删，保留数据以便恢复 */
    async softDelete(id: string): Promise<void> {
        await this.prisma.document.update({
            where: { id },
            data: { status: 'DELETED', deletedAt: new Date() },
        });
    }

    async findRaw(id: string, tx?: DbClient) {
        const client = tx ?? this.prisma;
        return client.document.findUnique({ where: { id } });
    }

    /**
     * 只刷新「当前快照」和统计，**不新增版本**（自动归档用）。
     *
     * 刻意不动 content_hash 和 snapshot_version：
     *   - content_hash 是「最近一次存档」的内容基线，手动保存靠它判断要不要新建版本
     *   - snapshot_version 是最近一次真正归档的版本号
     */
    async refreshSnapshot(args: {
        documentId: string;
        snapshot: Buffer;
        sizeBytes: number;
        cellCount: number;
    }): Promise<void> {
        await this.prisma.$executeRaw`
            UPDATE documents
               SET snapshot   = ${args.snapshot},
                   doc_size   = ${args.sizeBytes},
                   cell_count = ${args.cellCount},
                   updated_at = now()
             WHERE id = ${args.documentId}
        `;
    }

    // ─────────────────────── 版本 / 归档 ───────────────────────

    /**
     * 归档一个版本 —— 走存储过程。
     *
     * 存储过程里做了「锁文档行 → 分配版本号 → 插版本表 → 回写快照」四步，
     * 全在一个函数调用里，应用层无法在中途插进来破坏原子性。
     */
    async archiveVersion(args: {
        documentId: string;
        actorId?: string | null;
        remark?: string | null;
        snapshot: Buffer;
        sizeBytes: number;
        contentHash: string;
        cellCount: number;
    }, tx?: DbClient): Promise<number> {
        const client = tx ?? this.prisma;
        const rows = await client.$queryRaw<{ version_no: number }[]>`
            SELECT archive_document_version(
                ${args.documentId},
                ${args.actorId ?? null},
                ${args.remark ?? null},
                ${args.snapshot},
                ${args.sizeBytes},
                ${args.contentHash},
                ${args.cellCount}
            ) AS version_no
        `;
        return Number(rows[0]?.version_no ?? 0);
    }

    async listVersions(
        documentId: string,
        limit = 50
    ): Promise<
        {
            id: string;
            version_no: number;
            name: string | null;
            remark: string | null;
            size_bytes: number;
            created_at: Date;
        }[]
    > {
        return this.prisma.$queryRaw`
            SELECT id, version_no, name, remark, size_bytes, created_at
              FROM document_versions
             WHERE document_id = ${documentId}
             ORDER BY version_no DESC
             LIMIT ${limit}
        `;
    }

    /** 取某个版本的快照（二进制，用于回滚） */
    async findVersion(
        documentId: string,
        versionNo: number
    ): Promise<{ snapshot: Buffer; version_no: number } | null> {
        const rows = await this.prisma.$queryRaw<{ snapshot: Buffer; version_no: number }[]>`
            SELECT snapshot, version_no
              FROM document_versions
             WHERE document_id = ${documentId} AND version_no = ${versionNo}
        `;
        return rows[0] ?? null;
    }

    /** 文档的 update 日志条数（compaction 观测用） */
    async countUpdates(documentId: string): Promise<number> {
        return this.prisma.documentUpdate.count({ where: { documentId } });
    }

    /** 删除文档时连带清掉 update 日志和版本（硬删，因为整个文档都没了） */
    async hardDeleteCascade(documentId: string): Promise<void> {
        await this.prisma.$transaction(async (tx) => {
            await tx.documentUpdate.deleteMany({ where: { documentId } });
            await tx.documentVersion.deleteMany({ where: { documentId } });
            await tx.documentMember.deleteMany({ where: { documentId } });
            await tx.document.delete({ where: { id: documentId } });
        });
    }

    // ─────────────────────── 成员 ───────────────────────

    /** 查用户基本信息（邮箱/用户名），通知 body 与成员列表用 */
    async findUser(
        userId: string
    ): Promise<{
        id: string;
        email: string;
        username: string;
        displayName: string | null;
    } | null> {
        return this.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, email: true, username: true, displayName: true },
        });
    }

    /** 查某人对某文档的成员记录（不含 owner，owner 走 documents.owner_id） */
    async findMember(
        documentId: string,
        userId: string
    ): Promise<{ role: string } | null> {
        return this.prisma.documentMember.findUnique({
            where: { documentId_userId: { documentId, userId } },
            select: { role: true },
        });
    }

    /** 成员列表（join 用户信息，给右上角协作者面板用） */
    async listMembers(documentId: string): Promise<MemberRow[]> {
        const rows = await this.prisma.documentMember.findMany({
            where: { documentId },
            include: {
                user: { select: { email: true, username: true, displayName: true } },
            },
            orderBy: { createdAt: 'asc' },
        });
        return rows.map((r) => ({
            user_id: r.userId,
            role: r.role,
            email: r.user.email,
            username: r.user.username,
            display_name: r.user.displayName,
            joined_at: r.createdAt,
        }));
    }

    /** 写入/更新成员角色。审批通过时可能已有记录，用 upsert 兜底 */
    async upsertMember(
        documentId: string,
        userId: string,
        role: 'EDITOR' | 'VIEWER'
    ): Promise<void> {
        await this.prisma.documentMember.upsert({
            where: { documentId_userId: { documentId, userId } },
            create: { documentId, userId, role: role as MemberRole },
            update: { role: role as MemberRole },
        });
    }

    async removeMember(documentId: string, userId: string): Promise<void> {
        await this.prisma.documentMember.delete({
            where: { documentId_userId: { documentId, userId } },
        });
    }

    // ─────────────────────── 访问申请 ───────────────────────

    async findPendingRequest(documentId: string, requesterId: string) {
        return this.prisma.documentAccessRequest.findFirst({
            where: { documentId, requesterId, status: 'PENDING' },
        });
    }

    async createAccessRequest(documentId: string, requesterId: string) {
        return this.prisma.documentAccessRequest.create({
            data: { documentId, requesterId, status: AccessRequestStatus.PENDING },
        });
    }

    async findAccessRequest(id: string) {
        return this.prisma.documentAccessRequest.findUnique({ where: { id } });
    }

    async decideAccessRequest(
        id: string,
        status: 'APPROVED' | 'REJECTED',
        decidedBy: string,
        decidedRole: 'EDITOR' | 'VIEWER' | null
    ): Promise<void> {
        await this.prisma.documentAccessRequest.update({
            where: { id },
            data: {
                status: status as AccessRequestStatus,
                decidedBy,
                decidedRole: decidedRole as MemberRole | null,
                decidedAt: new Date(),
            },
        });
    }

    async listAccessRequests(documentId: string): Promise<AccessRequestRow[]> {
        const rows = await this.prisma.documentAccessRequest.findMany({
            where: { documentId },
            include: {
                requester: { select: { email: true, username: true, displayName: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
        return rows.map((r) => ({
            id: r.id,
            document_id: r.documentId,
            requester_id: r.requesterId,
            status: r.status,
            decided_role: r.decidedRole,
            created_at: r.createdAt,
            decided_at: r.decidedAt,
            requester_email: r.requester.email,
            requester_username: r.requester.username,
            requester_display_name: r.requester.displayName,
        }));
    }
}
