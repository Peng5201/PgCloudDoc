/**
 * 文档相关 API。
 * 字段名与后端 `backend/src/modules/documents/dto/document.dto.ts` 一一对应。
 */

import { api, request } from './client';
import type { IWorkbookData } from '../spreadsheet/engine';

export interface DocumentSummary {
    id: string;
    name: string;
    description: string | null;
    status: string;
    ownerId: string;
    ownerName: string;
    snapshotVersion: number;
    versionCount: number;
    docSize: number;
    cellCount: number;
    createdAt: string;
    updatedAt: string;
}

export interface DocumentDetail extends DocumentSummary {
    contentHash: string | null;
    deletedAt: string | null;
}

export interface DocumentVersion {
    id: string;
    versionNo: number;
    name: string | null;
    remark: string | null;
    sizeBytes: number;
    createdAt: string;
}

export interface PageResult<T> {
    items: T[];
    nextCursor: string | null;
    hasMore: boolean;
}

export interface ListQuery {
    cursor?: string;
    limit?: number;
    keyword?: string;
    status?: string;
}

function toQuery(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== '') search.set(key, String(value));
    }
    const qs = search.toString();
    return qs ? `?${qs}` : '';
}

export const documentsApi = {
    list(query: ListQuery = {}): Promise<PageResult<DocumentSummary>> {
        return api.get<PageResult<DocumentSummary>>(
            `/api/v1/documents${toQuery({ ...query })}`
        );
    },

    detail(id: string): Promise<DocumentDetail> {
        return api.get<DocumentDetail>(`/api/v1/documents/${id}`);
    },

    create(input: {
        name: string;
        description?: string;
        rowCount?: number;
        columnCount?: number;
    }): Promise<DocumentDetail> {
        return api.post<DocumentDetail>('/api/v1/documents', input);
    },

    update(
        id: string,
        input: { name?: string; description?: string; status?: string }
    ): Promise<DocumentDetail> {
        return api.patch<DocumentDetail>(`/api/v1/documents/${id}`, input);
    },

    remove(id: string): Promise<{ deleted: true }> {
        return api.delete<{ deleted: true }>(`/api/v1/documents/${id}`);
    },

    duplicate(id: string): Promise<DocumentDetail> {
        return api.post<DocumentDetail>(`/api/v1/documents/${id}/duplicate`);
    },

    /**
     * 工作簿快照。
     *
     * 后端用 `@SkipWrap()` 直接返回 IWorkbookData，不套 {success,data} 信封；
     * 所以这里走 raw 请求自己解，不能用 api.get。
     */
    async snapshot(id: string): Promise<IWorkbookData> {
        const response = await request<Response>(`/api/v1/documents/${id}/snapshot`, {
            raw: true,
        });
        if (!response.ok) {
            throw new Error(`取快照失败（${response.status}）`);
        }
        return (await response.json()) as IWorkbookData;
    },

    /** 存一版（「保存」按钮） */
    archive(id: string, remark?: string): Promise<{ versionNo: number }> {
        return api.post<{ versionNo: number }>(`/api/v1/documents/${id}/archive`, {
            remark,
        });
    },

    versions(id: string): Promise<DocumentVersion[]> {
        return api.get<DocumentVersion[]>(`/api/v1/documents/${id}/versions`);
    },

    restoreVersion(id: string, versionNo: number): Promise<DocumentDetail> {
        return api.post<DocumentDetail>(
            `/api/v1/documents/${id}/versions/${versionNo}/restore`
        );
    },

    /** 异步触发归档（走 Kafka），立即返回 */
    requestArchive(id: string, reason = 'manual'): Promise<{ accepted: true }> {
        return api.post<{ accepted: true }>(
            `/api/v1/documents/${id}/refresh-snapshot?reason=${encodeURIComponent(reason)}`
        );
    },
};
