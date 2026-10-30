/**
 * 刷新令牌 DAO。
 *
 * 单独拆出来而不是塞进 AuthService：
 *   1. 「轮换 + 重放检测」的查询逻辑相当绕，值得独立成一块可单测的代码
 *   2. Service 不碰 Prisma 查询语句，将来换存储（Redis 会话 / 分库）只改这里
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { Prisma } from '../../infra/prisma/generated/client';

export interface RefreshTokenRow {
    id: string;
    familyId: string;
    userId: string;
    expiresAt: Date;
    revokedAt: Date | null;
    replacedById: string | null;
    createdAt: Date;
}

/** 一个「登录会话」下所有令牌的最小必要字段 */
export interface TokenFamilyRow {
    id: string;
    familyId: string;
    userId: string;
    revokedAt: Date | null;
    expiresAt: Date;
}

@Injectable()
export class RefreshTokenRepository {
    constructor(private readonly prisma: PrismaService) {}

    async create(data: {
        userId: string;
        familyId: string;
        tokenHash: string;
        expiresAt: Date;
        userAgent?: string | null;
        ip?: string | null;
    }): Promise<RefreshTokenRow> {
        return this.prisma.refreshToken.create({
            data: {
                userId: data.userId,
                familyId: data.familyId,
                tokenHash: data.tokenHash,
                expiresAt: data.expiresAt,
                userAgent: data.userAgent ?? null,
                ip: data.ip ?? null,
            },
        });
    }

    /** 按哈希查令牌。登录/刷新是热路径，token_hash 上有唯一索引 */
    async findByHash(tokenHash: string): Promise<RefreshTokenRow | null> {
        return this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    }

    /** 标记单个令牌已撤销，并记录它是被谁顶替的 */
    async revoke(id: string, replacedById?: string): Promise<void> {
        await this.prisma.refreshToken.update({
            where: { id },
            data: { revokedAt: new Date(), replacedById: replacedById ?? null },
        });
    }

    /**
     * 吊销整个 family —— 重放检测的核心动作。
     *
     * 一个 family 就是一次「登录」产生的令牌串。只要出现「已撤销的令牌又被使用」，
     * 就说明这串令牌至少有一份泄漏了（正常流程中旧令牌用完就丢，不会被再次使用），
     * 此时唯一安全的做法是把这次登录产生的所有令牌全部作废，强制重新登录。
     */
    async revokeFamily(familyId: string): Promise<number> {
        const result = await this.prisma.refreshToken.updateMany({
            where: { familyId, revokedAt: null },
            data: { revokedAt: new Date() },
        });
        return result.count;
    }

    /** 查询整个 family，用于把访问令牌也一并拉黑 */
    async findFamily(familyId: string): Promise<TokenFamilyRow[]> {
        return this.prisma.refreshToken.findMany({
            where: { familyId },
            select: { id: true, familyId: true, userId: true, revokedAt: true, expiresAt: true },
        });
    }

    async countActiveByUser(userId: string): Promise<number> {
        return this.prisma.refreshToken.count({
            where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        });
    }

    /** 清理过期令牌（cron 调用） */
    async deleteExpired(before: Date): Promise<number> {
        const result = await this.prisma.refreshToken.deleteMany({
            where: { expiresAt: { lt: before } },
        });
        return result.count;
    }
}

export type RefreshTokenTx = Prisma.TransactionClient;
