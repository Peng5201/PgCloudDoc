/**
 * Y.Doc 的持久化 —— update 追加日志 + compaction。
 *
 * ## 为什么是「追加日志」而不是「每次存整份快照」
 *
 * 一次编辑可能只改 3 个格子，存整份快照是几 MB，追加一条 update 只有几十字节。
 * 写放大差两个数量级 —— 这在「每敲一个键就同步一次」的场景里是决定性的。
 *
 * ## 为什么 applyUpdate 顺序不重要
 *
 * CRDT 的合并满足交换律，任意顺序应用结果一致。所以这里按自增 seq 排序就够了，
 * 不需要为「乱序到达」做任何额外处理。这是 OT 做不到的。
 *
 * ## 谁负责持久化
 *
 * **YDocStore 自己**。它给每个 Y.Doc 挂一个 `update` 监听，只要文档变了就落库。
 * 不能挂在 WebSocket 连接上：没有连接时（比如服务端执行「回滚到某版本」）
 * 数据就丢了。持久化是文档自己的属性，不是连接的。
 *
 * ## compaction
 *
 * update 日志只增不减，读取时要按顺序重放 N 条才能还原文档，
 * N 越大启动越慢。所以超过阈值就把 N 条合并成一条 base update，
 * 把被吸收的行删掉 —— 相当于给日志做 checkpoint。
 *
 * 整个过程用 pg_advisory_xact_lock 串行化，保证不会和并发写入打架。
 */

import { Injectable, Logger } from '@nestjs/common';
import * as Y from 'yjs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../../config/app-config.service';
import { LockService } from '../redis/lock.service';
import { RedisService } from '../redis/redis.service';
import { createEmptyDoc, materialize, countCells } from './ydoc';
import type { SnapshotWorkbook } from './ydoc.types';

/** Y.applyUpdate 的 origin 标记：来自 DB 重放的 update 不需要再写回 DB */
const FROM_DB = Symbol('ydoc:from-db');

interface CacheEntry {
    doc: Y.Doc;
    /** 该文档已知的最大 seq，下一条 update 从它 +1 开始 */
    seq: number;
    lastAccessAt: number;
}

export interface LoadedDoc {
    doc: Y.Doc;
    seq: number;
}

@Injectable()
export class YDocStore {
    private readonly logger = new Logger(YDocStore.name);
    private readonly cache = new Map<string, CacheEntry>();
    /** 内存里最多挂多少个 Y.Doc，超了按 LRU 踢 */
    private readonly maxCachedDocs = 50;

    constructor(
        private readonly prisma: PrismaService,
        private readonly config: AppConfigService,
        private readonly lock: LockService,
        private readonly redis: RedisService
    ) {}

    // ─────────────────────────── 读 ───────────────────────────

    /**
     * 取文档的 Y.Doc。
     *
     * 内存里有就直接用（协同编辑时每秒几十次更新，不能每次都查库）；
     * 没有就从 update 日志重建，并挂上持久化监听。
     */
    async load(documentId: string): Promise<LoadedDoc> {
        const cached = this.cache.get(documentId);
        if (cached) {
            cached.lastAccessAt = Date.now();
            return { doc: cached.doc, seq: cached.seq };
        }

        const rows = await this.prisma.documentUpdate.findMany({
            where: { documentId },
            orderBy: { seq: 'asc' },
            select: { payload: true, seq: true },
        });

        const doc = new Y.Doc();
        let seq = 0;

        for (const row of rows) {
            // Prisma 的 Bytes 在 Node 侧是 Buffer
            Y.applyUpdate(doc, new Uint8Array(row.payload), FROM_DB);
            seq = Math.max(seq, row.seq);
        }

        if (rows.length === 0) {
            // 全新文档：先把空工作簿的状态写进去当 base，
            // 否则以后的增量 update 缺了基线，重建出来是残缺的
            this.logger.log(`文档 ${documentId} 无 update 记录，写入初始状态`);
            const empty = createEmptyDoc({ id: documentId, name: '工作簿' });
            const initial = Y.encodeStateAsUpdate(empty);
            empty.destroy();
            seq = await this.persistUpdate(documentId, initial, undefined);
            Y.applyUpdate(doc, initial, FROM_DB);
        }

        this.putInCache(documentId, doc, seq);
        this.attachPersistence(documentId, doc);
        return { doc, seq };
    }

    /**
     * 挂持久化监听。
     *
     * 从 DB 重放出来的 update（origin === FROM_DB）跳过 ——
     * 否则每读一次文档就把整个历史重写一遍。
     */
    private attachPersistence(documentId: string, doc: Y.Doc): void {
        doc.on('update', (update: Uint8Array, origin: unknown) => {
            if (origin === FROM_DB) return;
            void this.persistUpdate(documentId, update, undefined).catch((err: unknown) => {
                this.logger.error(
                    `update 落库失败 ${documentId}：${err instanceof Error ? err.message : String(err)}`
                );
            });
        });
    }

    // ─────────────────────────── 写 ───────────────────────────

    /**
     * 追加一条 update，返回分配到的 seq。**不改内存里的 Y.Doc** ——
     * 应用是调用方的事（通常是 `doc.on('update')` 已经应用过了）。
     *
     * seq 的分配必须和插入原子 —— 两个并发写入算出同一个 seq 会撞唯一索引。
     * 这里用 `pg_advisory_xact_lock`：同一个文档的写入在事务内串行，
     * 不同文档互不影响（锁按 documentId 哈希，粒度刚好）。
     */
    async persistUpdate(
        documentId: string,
        update: Uint8Array,
        actorId?: string
    ): Promise<number> {
        return this.prisma.withTransaction(async (tx) => {
            // 事务级咨询锁，事务结束自动释放
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${documentId}))`;

            const rows = await tx.$queryRaw<{ next_seq: number }[]>`
                SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
                  FROM document_updates
                 WHERE document_id = ${documentId}
            `;
            const nextSeq = Number(rows[0]?.next_seq ?? 1);

            await tx.documentUpdate.create({
                data: {
                    documentId,
                    seq: nextSeq,
                    payload: Buffer.from(update),
                    actorId: actorId ?? null,
                },
            });

            const entry = this.cache.get(documentId);
            if (entry) entry.seq = Math.max(entry.seq, nextSeq);

            // 变更流水写 Redis Stream（观测/回放用），失败不影响主流程
            void this.redis.xadd(
                `stream:doc-change:${documentId}`,
                1000,
                {
                    seq: String(nextSeq),
                    bytes: String(update.byteLength),
                    actor: actorId ?? '-',
                    at: Date.now().toString(),
                }
            );

            return nextSeq;
        });
    }

    // ─────────────────────────── compaction ───────────────────────────

    /**
     * 把一个文档的 update 日志合并成一条。
     *
     * 做法：把所有 update 应用到一个新 Y.Doc，再 encodeStateAsUpdate 得到
     * 「等价的单条 update」。它包含同样的状态，但只有一个。
     */
    async compact(documentId: string): Promise<{ before: number; after: number }> {
        return this.lock.withLock(`ydoc:compact:${documentId}`, async () => {
            return this.prisma.withTransaction(async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${documentId}))`;

                const rows = await tx.documentUpdate.findMany({
                    where: { documentId },
                    orderBy: { seq: 'asc' },
                    select: { id: true, payload: true },
                });

                if (rows.length <= 1) return { before: rows.length, after: rows.length };

                const merged = new Y.Doc();
                for (const row of rows) {
                    Y.applyUpdate(merged, new Uint8Array(row.payload), FROM_DB);
                }
                const combined = Y.encodeStateAsUpdate(merged);
                merged.destroy();

                await tx.documentUpdate.deleteMany({ where: { documentId } });
                await tx.documentUpdate.create({
                    data: { documentId, seq: 1, payload: Buffer.from(combined) },
                });

                const entry = this.cache.get(documentId);
                if (entry) entry.seq = 1;

                this.logger.log(
                    `compaction ${documentId}: ${rows.length} → 1 条，${combined.byteLength} 字节`
                );
                return { before: rows.length, after: 1 };
            });
        });
    }

    /** update 日志条数超阈值就压缩 */
    async compactIfNeed(documentId: string): Promise<void> {
        const count = await this.prisma.documentUpdate.count({ where: { documentId } });
        if (count < this.config.collab.compactThreshold) return;
        await this.compact(documentId).catch((err: unknown) =>
            this.logger.warn(`compaction 失败 ${documentId}：${String(err)}`)
        );
    }

    // ─────────────────────────── 快照 ───────────────────────────

    /** 物化当前状态，返回 gzipped JSON */
    async buildSnapshot(documentId: string): Promise<{
        snapshot: Buffer;
        contentHash: string;
        sizeBytes: number;
        cellCount: number;
    }> {
        const { doc } = await this.load(documentId);
        return this.encodeSnapshot(materialize(doc, documentId));
    }

    /** 把快照对象编码成落库用的 buffer（gzip + sha256） */
    encodeSnapshot(workbook: SnapshotWorkbook): {
        snapshot: Buffer;
        contentHash: string;
        sizeBytes: number;
        cellCount: number;
    } {
        const json = JSON.stringify(workbook);
        // 快照是大对象且写多读少，gzip 省下的存储和网络都相当可观
        const gzipped = gzipSync(Buffer.from(json, 'utf-8'), { level: 6 });
        return {
            snapshot: gzipped,
            // 哈希对**解压后的内容**算，这样「内容没变就不需要重新归档」的判断才准
            contentHash: createHash('sha256').update(json).digest('hex'),
            sizeBytes: gzipped.byteLength,
            cellCount: countCells(workbook),
        };
    }

    /** 解码落库的快照 buffer */
    decodeSnapshot(buffer: Buffer): SnapshotWorkbook {
        return JSON.parse(gunzipSync(buffer).toString('utf-8')) as SnapshotWorkbook;
    }

    // ─────────────────────────── 缓存 ───────────────────────────

    private putInCache(documentId: string, doc: Y.Doc, seq: number): void {
        if (this.cache.size >= this.maxCachedDocs) {
            this.evictOldest();
        }
        this.cache.set(documentId, { doc, seq, lastAccessAt: Date.now() });
    }

    /** LRU 淘汰。被踢的文档状态已全部落库，丢了不影响正确性 */
    private evictOldest(): void {
        let oldestKey: string | null = null;
        let oldestAt = Infinity;
        for (const [key, entry] of this.cache) {
            if (entry.lastAccessAt < oldestAt) {
                oldestAt = entry.lastAccessAt;
                oldestKey = key;
            }
        }
        if (oldestKey) this.evict(oldestKey);
    }

    /** 从缓存里摘掉（文档被删除/回滚后调用） */
    evict(documentId: string): void {
        this.cache.get(documentId)?.doc.destroy();
        this.cache.delete(documentId);
    }

    cachedSize(): number {
        return this.cache.size;
    }
}
