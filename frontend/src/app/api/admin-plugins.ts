/**
 * 插件管理 API（管理端）。
 *
 * 后端用 AdminGuard 校验库里的 role，前端入口只是体验层。
 */

import { api } from './client';

export type PluginVersionStatus =
    | 'UPLOADED'
    | 'VALIDATED'
    | 'REJECTED'
    | 'PUBLISHED'
    | 'DEPRECATED';

export interface AdminPluginVersion {
    version: string;
    status: PluginVersionStatus;
    sizeBytes: number;
    assetsBytes: number;
    uploadedAt: string;
    publishedAt: string | null;
    active: boolean;
}

export interface AdminPlugin {
    pluginKey: string;
    name: string;
    description: string | null;
    author: string | null;
    enabled: boolean;
    activeVersion: string | null;
    permissions: string[];
    activationEvents: string[];
    versions: AdminPluginVersion[];
    updatedAt: string | null;
}

export interface SetPluginInstallationInput {
    enabled?: boolean;
    version?: string;
}

export const adminPluginsApi = {
    list(): Promise<AdminPlugin[]> {
        return api.get<AdminPlugin[]>('/api/v1/admin/plugins');
    },

    upload(file: File): Promise<AdminPlugin> {
        const form = new FormData();
        form.append('file', file);
        return api.post<AdminPlugin>('/api/v1/admin/plugins/upload', form);
    },

    setInstallation(
        pluginKey: string,
        input: SetPluginInstallationInput
    ): Promise<AdminPlugin> {
        return api.put<AdminPlugin>(
            `/api/v1/admin/plugins/${encodeURIComponent(pluginKey)}/installation`,
            input
        );
    },
};
