/**
 * 第三方身份绑定 DAO。
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

export interface AuthIdentityRow {
    id: string;
    provider: string;
    providerUserId: string;
    userId: string;
    email: string | null;
}

@Injectable()
export class IdentityRepository {
    constructor(private readonly prisma: PrismaService) {}

    async findByProvider(
        provider: string,
        providerUserId: string
    ): Promise<AuthIdentityRow | null> {
        return this.prisma.authIdentity.findUnique({
            where: { provider_providerUserId: { provider, providerUserId } },
        });
    }

    async findByUserId(userId: string): Promise<AuthIdentityRow[]> {
        return this.prisma.authIdentity.findMany({ where: { userId } });
    }

    async bind(data: {
        provider: string;
        providerUserId: string;
        userId: string;
        email?: string | null;
        raw?: unknown;
    }): Promise<AuthIdentityRow> {
        return this.prisma.authIdentity.create({
            data: {
                provider: data.provider,
                providerUserId: data.providerUserId,
                userId: data.userId,
                email: data.email ?? null,
                raw: (data.raw ?? {}) as object,
            },
        });
    }
}
