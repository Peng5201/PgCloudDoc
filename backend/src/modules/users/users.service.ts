/**
 * 用户资料服务。
 *
 * 读路径走 Redis 缓存（Cache-Aside）：用户资料改动极少、读取极多
 * （每个文档列表页都要带 owner 信息），是最典型的缓存适用场景。
 */

import { Injectable } from '@nestjs/common';
import { UserRepository, type UserPublic } from './user.repository';
import { CacheService } from '../../infra/redis/cache.service';
import { AppError } from '../../common/errors/app-error';

const PROFILE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class UsersService {
    constructor(
        private readonly users: UserRepository,
        private readonly cache: CacheService
    ) {}

    async getProfile(id: string): Promise<UserPublic> {
        const user = await this.cache.getOrSet(
            `user:profile:${id}`,
            async () => {
                const found = await this.users.findById(id);
                if (!found) throw AppError.notFound('用户不存在');
                return found;
            },
            { ttlMs: PROFILE_TTL_MS, nullTtlMs: 30_000 }
        );
        return user;
    }

    async updateProfile(
        id: string,
        data: { displayName?: string; avatarUrl?: string }
    ): Promise<UserPublic> {
        const updated = await this.users.updateProfile(id, data);
        // 写后失效，而不是写后回填 —— 回填在并发下容易把旧值又写回去
        await this.cache.invalidate(`user:profile:${id}`);
        return updated;
    }
}
