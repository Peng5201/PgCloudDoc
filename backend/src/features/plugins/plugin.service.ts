/**
 * 插件注册表业务。
 *
 * 真源是 PostgreSQL；磁盘只放不可变产物。
 * - 上传：校验 zip → 解包 → 原子发布 → 写版本 + 启用关系 → 审计
 * - 列表 / 启用 / 切版本：管理端
 * - 索引：客户端启动时拉取，只返回启用且已发布的插件
 */

import { Logger, Injectable } from '@nestjs/common';
import type { PluginIndex, PluginIndexEntry, PluginManifest } from '@pgclouddoc/plugin-api';
import {
    PluginScope,
    PluginVersionStatus,
    Prisma,
} from '../../infrastructure/prisma/generated/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AppError } from '../../shared/errors/app-error';
import type { AuthUser } from '../../shared/decorators/auth.decorators';
import { ConfigCenterService } from '../config-center/config-center.service';
import { loadPluginApi } from './plugin-api.loader';
import { PluginStorageService } from './plugin-storage.service';
import { PluginZipService } from './plugin-zip.service';

export interface AdminPluginVersionItem {
    version: string;
    status: PluginVersionStatus;
    sizeBytes: number;
    assetsBytes: number;
    uploadedAt: string;
    publishedAt: string | null;
    active: boolean;
}

export interface AdminPluginItem {
    pluginKey: string;
    name: string;
    description: string | null;
    author: string | null;
    enabled: boolean;
    activeVersion: string | null;
    permissions: string[];
    activationEvents: string[];
    versions: AdminPluginVersionItem[];
    updatedAt: string | null;
}

export interface SetPluginInstallationInput {
    enabled?: boolean;
    version?: string;
}

type PluginWithDetails = Prisma.PluginGetPayload<{
    include: {
        versions: true;
        installations: { include: { pluginVersion: true } };
    };
}>;

const GLOBAL_SCOPE_VALUE = '';

@Injectable()
export class PluginService {
    private readonly logger = new Logger(PluginService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly configCenter: ConfigCenterService,
        private readonly storage: PluginStorageService,
        private readonly zip: PluginZipService
    ) {}

    // ─────────────────────────── 上传 ───────────────────────────

    async upload(actor: AuthUser, buffer: Buffer): Promise<AdminPluginItem> {
        const tempDir = await this.storage.createTempDir();
        let pluginKey = '';

        try {
            const validated = await this.zip.validateAndExtract(buffer, tempDir);
            const manifest = validated.manifest;
            pluginKey = manifest.id;

            // 版本不可覆盖：先查 DB，再发布文件
            const existing = await this.prisma.pluginVersion.findFirst({
                where: { plugin: { pluginKey }, version: manifest.version },
                select: { id: true },
            });
            if (existing) {
                throw AppError.conflict(
                    `插件 ${pluginKey}@${manifest.version} 已存在，版本发布后不可覆盖`
                );
            }

            await this.storage.publishVersion(pluginKey, manifest.version, tempDir);

            try {
                await this.storage.writeZip(pluginKey, manifest.version, buffer);

                await this.prisma.withTransaction(async (tx) => {
                    const plugin = await tx.plugin.upsert({
                        where: { pluginKey },
                        create: {
                            pluginKey,
                            name: manifest.name,
                            description: manifest.description ?? null,
                            author: manifest.author ?? null,
                            homepage: manifest.homepage ?? null,
                            createdBy: actor.id,
                        },
                        update: {
                            name: manifest.name,
                            description: manifest.description ?? null,
                            author: manifest.author ?? null,
                            homepage: manifest.homepage ?? null,
                        },
                    });

                    const version = await tx.pluginVersion.create({
                        data: {
                            pluginId: plugin.id,
                            version: manifest.version,
                            manifest: manifest as unknown as Prisma.InputJsonValue,
                            entry: manifest.entry,
                            sha256: validated.zipSha256,
                            zipBytes: buffer.length,
                            assetsBytes: validated.assetsBytes,
                            fileCount: validated.files.length,
                            status: PluginVersionStatus.PUBLISHED,
                            pluginApi: manifest.engines.pluginApi,
                            hostRange: manifest.engines.pgclouddoc,
                            createdBy: actor.id,
                            publishedAt: new Date(),
                            reviewedBy: actor.email,
                        },
                    });

                    // 新上传的版本立即成为当前版本；已有安装的启用状态保持不变
                    await tx.pluginInstallation.upsert({
                        where: {
                            pluginId_scope_scopeValue: {
                                pluginId: plugin.id,
                                scope: PluginScope.GLOBAL,
                                scopeValue: GLOBAL_SCOPE_VALUE,
                            },
                        },
                        create: {
                            pluginId: plugin.id,
                            pluginVersionId: version.id,
                            scope: PluginScope.GLOBAL,
                            scopeValue: GLOBAL_SCOPE_VALUE,
                            enabled: true,
                            updatedBy: actor.id,
                        },
                        update: {
                            pluginVersionId: version.id,
                            updatedBy: actor.id,
                        },
                    });
                });
            } catch (err) {
                // DB 没写成功 → 删掉刚发布的产物，避免留下孤儿目录
                await this.storage.removeVersion(pluginKey, manifest.version);
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                    throw AppError.conflict(
                        `插件 ${pluginKey}@${manifest.version} 已存在，版本发布后不可覆盖`
                    );
                }
                throw err;
            }

            await this.audit(actor.id, 'plugin.upload', pluginKey, {
                version: manifest.version,
                sha256: validated.zipSha256,
                files: validated.files.length,
                assetsBytes: validated.assetsBytes,
            });

            return await this.getAdminItem(pluginKey);
        } finally {
            // rename 成功后临时目录已不存在；失败时这里负责清理
            await this.storage.removeTempDir(tempDir);
        }
    }

    // ─────────────────────────── 管理端 ───────────────────────────

    async list(): Promise<AdminPluginItem[]> {
        const plugins = await this.prisma.plugin.findMany({
            orderBy: { createdAt: 'desc' },
            include: {
                versions: { orderBy: { createdAt: 'desc' } },
                installations: {
                    where: { scope: PluginScope.GLOBAL, scopeValue: GLOBAL_SCOPE_VALUE },
                    include: { pluginVersion: true },
                },
            },
        });
        return plugins.map((plugin) => toAdminItem(plugin));
    }

    async getAdminItem(pluginKey: string): Promise<AdminPluginItem> {
        const plugin = await this.prisma.plugin.findUnique({
            where: { pluginKey },
            include: {
                versions: { orderBy: { createdAt: 'desc' } },
                installations: {
                    where: { scope: PluginScope.GLOBAL, scopeValue: GLOBAL_SCOPE_VALUE },
                    include: { pluginVersion: true },
                },
            },
        });
        if (!plugin) throw AppError.notFound(`插件 ${pluginKey} 不存在`);
        return toAdminItem(plugin);
    }

    async setInstallation(
        actor: AuthUser,
        pluginKey: string,
        input: SetPluginInstallationInput
    ): Promise<AdminPluginItem> {
        if (input.enabled === undefined && input.version === undefined) {
            throw AppError.validation('enabled 与 version 至少提供一个');
        }

        const plugin = await this.prisma.plugin.findUnique({
            where: { pluginKey },
            include: {
                versions: { orderBy: { createdAt: 'desc' } },
                installations: {
                    where: { scope: PluginScope.GLOBAL, scopeValue: GLOBAL_SCOPE_VALUE },
                    include: { pluginVersion: true },
                },
            },
        });
        if (!plugin) throw AppError.notFound(`插件 ${pluginKey} 不存在`);

        const current = plugin.installations[0];
        const targetVersion = input.version
            ? plugin.versions.find((version) => version.version === input.version)
            : current?.pluginVersion ?? plugin.versions[0];

        if (!targetVersion) throw AppError.notFound('插件没有可用版本');
        if (targetVersion.status !== PluginVersionStatus.PUBLISHED) {
            throw AppError.validation('只能启用已发布的版本');
        }

        const enabled = input.enabled ?? current?.enabled ?? true;
        await this.prisma.pluginInstallation.upsert({
            where: {
                pluginId_scope_scopeValue: {
                    pluginId: plugin.id,
                    scope: PluginScope.GLOBAL,
                    scopeValue: GLOBAL_SCOPE_VALUE,
                },
            },
            create: {
                pluginId: plugin.id,
                pluginVersionId: targetVersion.id,
                scope: PluginScope.GLOBAL,
                scopeValue: GLOBAL_SCOPE_VALUE,
                enabled,
                updatedBy: actor.id,
            },
            update: {
                pluginVersionId: targetVersion.id,
                enabled,
                updatedBy: actor.id,
            },
        });

        const switched = input.version !== undefined && input.version !== current?.pluginVersion.version;
        await this.audit(
            actor.id,
            switched ? 'plugin.version_switch' : enabled ? 'plugin.enable' : 'plugin.disable',
            pluginKey,
            { version: targetVersion.version, enabled }
        );

        return this.getAdminItem(pluginKey);
    }

    // ─────────────────────────── 客户端索引 ───────────────────────────

    async getIndex(): Promise<PluginIndex> {
        const publicConfig = await this.configCenter.getPublicConfig();
        const values = publicConfig.values;
        const killSwitch = values['plugins.enabled'] === false;
        const blockedRaw = values['plugins.blocked'];
        const blocked = new Set(
            Array.isArray(blockedRaw)
                ? blockedRaw.filter((value): value is string => typeof value === 'string')
                : []
        );

        const api = await loadPluginApi();
        if (killSwitch) {
            return {
                revision: 0,
                hostApiVersion: api.PLUGIN_API_VERSION,
                killSwitch: true,
                plugins: [],
            };
        }

        const installations = await this.prisma.pluginInstallation.findMany({
            where: {
                scope: PluginScope.GLOBAL,
                scopeValue: GLOBAL_SCOPE_VALUE,
                enabled: true,
                pluginVersion: { status: PluginVersionStatus.PUBLISHED },
            },
            include: { plugin: true, pluginVersion: true },
        });

        const plugins: PluginIndexEntry[] = [];
        let revision = 0;

        for (const installation of installations) {
            const pluginKey = installation.plugin.pluginKey;
            revision = Math.max(revision, Math.floor(installation.updatedAt.getTime() / 1000));
            if (blocked.has(pluginKey)) continue;

            const manifest = installation.pluginVersion.manifest as unknown as PluginManifest;
            plugins.push({
                id: pluginKey,
                version: installation.pluginVersion.version,
                baseUrl: `/plugin-assets/${encodeURIComponent(pluginKey)}/${encodeURIComponent(
                    installation.pluginVersion.version
                )}/`,
                entry: installation.pluginVersion.entry,
                style: manifest.style,
                sha256: installation.pluginVersion.sha256,
                engines: manifest.engines,
                activationEvents: manifest.activationEvents ?? [],
                contributes: manifest.contributes,
                permissions: manifest.permissions ?? [],
                settings: resolveClientSettings(manifest, installation.settings),
            });
        }

        plugins.sort((left, right) => left.id.localeCompare(right.id));
        return {
            revision,
            hostApiVersion: api.PLUGIN_API_VERSION,
            killSwitch: false,
            plugins,
        };
    }

    // ─────────────────────────── 工具 ───────────────────────────

    private async audit(
        userId: string,
        action: string,
        pluginKey: string,
        metadata: Record<string, unknown>
    ): Promise<void> {
        try {
            await this.prisma.auditLog.create({
                data: {
                    userId,
                    action,
                    resourceType: 'plugin',
                    resourceId: pluginKey,
                    metadata: metadata as Prisma.InputJsonValue,
                },
            });
        } catch (err) {
            this.logger.warn(
                `插件审计写入失败（${action} ${pluginKey}）：${
                    err instanceof Error ? err.message : String(err)
                }`
            );
        }
    }
}

function toAdminItem(plugin: PluginWithDetails): AdminPluginItem {
    const installation = plugin.installations[0];
    const activeVersion = installation?.pluginVersion ?? plugin.versions[0] ?? null;
    const manifest = activeVersion?.manifest as unknown as PluginManifest | undefined;

    return {
        pluginKey: plugin.pluginKey,
        name: plugin.name,
        description: plugin.description,
        author: plugin.author,
        enabled: installation?.enabled ?? false,
        activeVersion: installation?.pluginVersion.version ?? null,
        permissions: manifest?.permissions ?? [],
        activationEvents: manifest?.activationEvents ?? [],
        versions: plugin.versions.map((version) => ({
            version: version.version,
            status: version.status,
            sizeBytes: version.zipBytes,
            assetsBytes: version.assetsBytes,
            uploadedAt: version.createdAt.toISOString(),
            publishedAt: version.publishedAt?.toISOString() ?? null,
            active: installation?.pluginVersion.version === version.version,
        })),
        updatedAt: (installation?.updatedAt ?? plugin.createdAt).toISOString(),
    };
}

/**
 * 设置合并：manifest 默认值 → 管理端覆盖。
 * 只下发 client scope 的 key —— server 配置永远不出服务器。
 */
function resolveClientSettings(
    manifest: PluginManifest,
    stored: Prisma.JsonValue | null
): Record<string, unknown> {
    const clientKeys = new Set(
        (manifest.settings ?? [])
            .filter((setting) => setting.scope !== 'server')
            .map((setting) => setting.key)
    );

    const out: Record<string, unknown> = {};
    for (const setting of manifest.settings ?? []) {
        if (!clientKeys.has(setting.key)) continue;
        if (setting.default !== undefined) out[setting.key] = setting.default;
    }

    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        for (const [key, value] of Object.entries(stored)) {
            if (clientKeys.has(key)) out[key] = value;
        }
    }
    return out;
}
