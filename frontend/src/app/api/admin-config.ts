/**
 * 配置中心 API（管理端）。
 *
 * 对应的后端接口都在 /api/v1/admin/config，服务端用 AdminGuard 按库里的
 * role 校验，前端的「是否显示入口」只是体验，不是权限边界。
 */

import { api } from './client';

export type ConfigScope = 'client' | 'server';

export interface AdminConfigEntry {
    scope: ConfigScope;
    key: string;
    value: unknown;
    description: string | null;
    /** etcd modRevision，提交时作为 expectedRevision 防覆盖 */
    revision: number;
    updatedAt: string | null;
    updatedBy: string | null;
}

export interface ConfigHistoryItem {
    revision: number;
    deleted: boolean;
    value: unknown;
    description: string | null;
    updatedAt: string | null;
    updatedBy: string | null;
}

export interface UpsertConfigInput {
    value: unknown;
    description?: string;
    expectedRevision?: number;
}

function basePath(scope: ConfigScope, key: string): string {
    return `/api/v1/admin/config/${scope}/${encodeURIComponent(key)}`;
}

export const adminConfigApi = {
    list(): Promise<AdminConfigEntry[]> {
        return api.get<AdminConfigEntry[]>('/api/v1/admin/config');
    },

    upsert(scope: ConfigScope, key: string, input: UpsertConfigInput): Promise<AdminConfigEntry> {
        return api.put<AdminConfigEntry>(basePath(scope, key), input);
    },

    remove(scope: ConfigScope, key: string): Promise<{ deleted: true }> {
        return api.delete<{ deleted: true }>(basePath(scope, key));
    },

    history(scope: ConfigScope, key: string, limit = 20): Promise<ConfigHistoryItem[]> {
        return api.get<ConfigHistoryItem[]>(`${basePath(scope, key)}/history?limit=${limit}`);
    },

    rollback(scope: ConfigScope, key: string, revision: number): Promise<AdminConfigEntry> {
        return api.post<AdminConfigEntry>(`${basePath(scope, key)}/rollback`, { revision });
    },
};
