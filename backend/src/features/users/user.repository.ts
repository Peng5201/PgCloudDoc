/**
 * 用户 DAO。只封装 Prisma 查询，不写业务规则。
 *
 * select 列是显式的 —— 绝不 `select *`：
 * password_hash 一旦混进返回值，早晚会被某次接口泄漏出去。
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** 对外可见的字段集合。所有查询都基于它，从源头杜绝哈希泄漏 */
export const USER_PUBLIC_SELECT = {
    id: true,
    email: true,
    username: true,
    displayName: true,
    avatarUrl: true,
    status: true,
    tokenVersion: true,
    createdAt: true,
    updatedAt: true,
} as const;

export type UserPublic = {
    id: string;
    email: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    status: string;
    tokenVersion: number;
    createdAt: Date;
    updatedAt: Date;
};

/** 含哈希的内部形态，只在登录校验时用 */
export type UserWithSecret = UserPublic & { passwordHash: string | null };

@Injectable()
export class UserRepository {
    constructor(private readonly prisma: PrismaService) {}

    async findById(id: string): Promise<UserPublic | null> {
        return this.prisma.user.findUnique({
            where: { id },
            select: USER_PUBLIC_SELECT,
        });
    }

    async findByEmail(email: string): Promise<UserPublic | null> {
        return this.prisma.user.findUnique({
            where: { email },
            select: USER_PUBLIC_SELECT,
        });
    }

    async findByUsername(username: string): Promise<UserPublic | null> {
        return this.prisma.user.findUnique({
            where: { username },
            select: USER_PUBLIC_SELECT,
        });
    }

    /** 登录用：按邮箱或用户名找，带密码哈希 */
    async findWithSecretByIdentifier(identifier: string): Promise<UserWithSecret | null> {
        return this.prisma.user.findFirst({
            where: {
                OR: [{ email: identifier.toLowerCase() }, { username: identifier }],
            },
            select: { ...USER_PUBLIC_SELECT, passwordHash: true },
        });
    }

    async findWithSecretById(id: string): Promise<UserWithSecret | null> {
        return this.prisma.user.findUnique({
            where: { id },
            select: { ...USER_PUBLIC_SELECT, passwordHash: true },
        });
    }

    async create(data: {
        email: string;
        username: string;
        passwordHash: string;
        displayName?: string | null;
    }): Promise<UserPublic> {
        return this.prisma.user.create({
            data: {
                email: data.email.toLowerCase(),
                username: data.username,
                passwordHash: data.passwordHash,
                displayName: data.displayName ?? null,
            },
            select: USER_PUBLIC_SELECT,
        });
    }

    async updateProfile(
        id: string,
        data: { displayName?: string; avatarUrl?: string }
    ): Promise<UserPublic> {
        return this.prisma.user.update({
            where: { id },
            data,
            select: USER_PUBLIC_SELECT,
        });
    }

    async updatePassword(id: string, passwordHash: string): Promise<void> {
        await this.prisma.user.update({
            where: { id },
            data: {
                passwordHash,
                // 自增 tokenVersion 让所有已签发的 access token 立刻失效
                tokenVersion: { increment: 1 },
            },
        });
    }

    /**
     * 检查邮箱/用户名是否被占用。
     * 用 findFirst 而不是 findUnique + catch：注册不是超高频路径，
     * 读两次比靠异常控制流清晰。
     */
    async isIdentityTaken(email: string, username: string): Promise<{
        emailTaken: boolean;
        usernameTaken: boolean;
    }> {
        const [byEmail, byUsername] = await Promise.all([
            this.prisma.user.findUnique({
                where: { email: email.toLowerCase() },
                select: { id: true },
            }),
            this.prisma.user.findUnique({
                where: { username },
                select: { id: true },
            }),
        ]);
        return {
            emailTaken: byEmail !== null,
            usernameTaken: byUsername !== null,
        };
    }
}
