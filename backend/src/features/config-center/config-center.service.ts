/**
 * 配置中心。
 *
 * ## 键位布局
 *
 *   <ETCD_CONFIG_PREFIX>/client/<key>   → 下发给浏览器的配置
 *   <ETCD_CONFIG_PREFIX>/server/<key>   → 只给服务端用的配置
 *
 * 为什么要分 scope：/api/v1/config 是**匿名可读**的（首屏渲染前就要拿到），
 * 如果把服务端配置混在里面，等于把所有内部开关都公开了。写入时按 scope
 * 分目录，读取时只扫 client/，从存储结构上杜绝误暴露。
 *
 * ## 值的形态
 *
 * etcd 里存的是 JSON 文本。管理后台写入时套一层信封：
 *
 *   { "__meta": 1, "value": <任意 JSON>, "description": "...",
 *     "updatedBy": "...", "updatedAt": "ISO" }
 *
 * 读取时兼容「直接写裸 JSON」的键（用 etcdctl 手工塞的值），
 * 这时整份内容就是 value，元信息为空。这样运维层面不会被格式卡住。
 *
 * ## 首屏读取
 *
 * 公共配置在内存里维护一份快照（watch 前缀 + 60s 兜底刷新），
 * /api/v1/config 直接返回快照，不走 etcd 往返 —— 首屏不能等一个跨网 RPC。
 * etcd 挂了也只是回退到上一份快照，不影响页面打开。
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Watcher } from 'etcd3';
import { AppConfigService } from '../../config/app-config.service';
import { EtcdService } from '../../infrastructure/etcd/etcd.service';
import { AppError } from '../../shared/errors/app-error';

export type ConfigScope = 'client' | 'server';

export const CONFIG_SCOPES: readonly ConfigScope[] = ['client', 'server'];

/** 键名限制：字母数字开头，允许 . _ -，最长 80。点号用来表达层级（ui.theme） */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** 单个配置项序列化后的上限。配置不是数据仓库，超过这个量说明放错地方了 */
const MAX_VALUE_BYTES = 64 * 1024;

const MAX_DESCRIPTION_LENGTH = 200;

/** 快照读取失败后的冷却时间：期间首屏请求直接拿空配置/旧快照，不再等 etcd */
const PUBLIC_RETRY_COOLDOWN_MS = 5000;

/** 管理后台看到的一条配置 */
export interface ConfigEntry {
    scope: ConfigScope;
    key: string;
    value: unknown;
    description: string | null;
    /** etcd modRevision，改配置时用于乐观并发 */
    revision: number;
    updatedAt: string | null;
    updatedBy: string | null;
}

/** 历史里的一个版本 */
export interface ConfigHistoryItem {
    revision: number;
    deleted: boolean;
    value: unknown;
    description: string | null;
    updatedAt: string | null;
    updatedBy: string | null;
}

/** 下发给浏览器的东西 */
export interface PublicConfig {
    /** etcd 全局 revision，前端可以用它判断配置有没有变 */
    version: number;
    updatedAt: string | null;
    values: Record<string, unknown>;
}

interface Envelope {
    __meta: 1;
    value: unknown;
    description?: string;
    updatedBy?: string;
    updatedAt?: string;
}

interface DecodedValue {
    value: unknown;
    description: string | null;
    updatedBy: string | null;
    updatedAt: string | null;
}

@Injectable()
export class ConfigCenterService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ConfigCenterService.name);
    private readonly prefix: string;

    private snapshot: PublicConfig = { version: 0, updatedAt: null, values: {} };
    private loaded = false;
    private loading: Promise<void> | null = null;
    /** 上次读取失败的时间：失败后的冷却期内不再重试，避免首屏请求排队等 etcd 超时 */
    private failedAt = 0;

    private watcher: Watcher | null = null;
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private fallbackTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly etcd: EtcdService,
        config: AppConfigService
    ) {
        this.prefix = config.etcd.configPrefix;
    }

    onModuleInit(): void {
        if (!this.etcd.enabled) return;

        // 不 await：etcd 挂了不能拖住应用启动。首次请求会再尝试一次
        void this.ensureLoaded();
        void this.startWatch().catch((err: unknown) =>
            this.logger.warn(`配置 watch 启动失败，改用轮询：${String(err)}`)
        );

        // 兜底轮询：watch 断线重连期间、或者 etcd 被 compact 后漏事件，
        // 最多 60s 也能自愈。本地读快照，成本可以忽略
        this.fallbackTimer = setInterval(() => {
            void this.refreshPublic().catch(() => undefined);
        }, 60_000);
        this.fallbackTimer.unref?.();
    }

    onModuleDestroy(): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        if (this.fallbackTimer) clearInterval(this.fallbackTimer);
        void this.watcher?.cancel().catch(() => undefined);
    }

    // ─────────────────────────── 公共配置（首屏） ───────────────────────────

    /** 给 /api/v1/config 用；永远不抛错，最差返回空配置 */
    async getPublicConfig(): Promise<PublicConfig> {
        if (!this.etcd.enabled) return { version: 0, updatedAt: null, values: {} };
        if (!this.loaded) await this.ensureLoaded();
        return this.snapshot;
    }

    private async ensureLoaded(): Promise<void> {
        if (this.loading) return this.loading;
        // etcd 刚失败过：冷却期内直接回空快照，别让每个首屏请求都等一次超时
        if (!this.loaded && Date.now() - this.failedAt < PUBLIC_RETRY_COOLDOWN_MS) return;

        this.loading = this.refreshPublic()
            .then(() => {
                this.failedAt = 0;
            })
            .catch((err: unknown) => {
                this.failedAt = Date.now();
                this.logger.warn(`读取配置快照失败：${String(err)}`);
            })
            .finally(() => {
                this.loading = null;
            });
        return this.loading;
    }

    private async refreshPublic(): Promise<void> {
        const clientPrefix = `${this.prefix}/client/`;
        const { revision, entries } = await this.etcd.getPrefix(clientPrefix);

        const values: Record<string, unknown> = {};
        let updatedAt: string | null = null;

        for (const entry of entries) {
            const key = entry.key.slice(clientPrefix.length);
            if (!KEY_PATTERN.test(key)) continue;
            const decoded = decodeValue(entry.raw);
            values[key] = decoded.value;
            if (decoded.updatedAt && (!updatedAt || decoded.updatedAt > updatedAt)) {
                updatedAt = decoded.updatedAt;
            }
        }

        this.snapshot = { version: revision, updatedAt, values };
        this.loaded = true;
    }

    private async startWatch(): Promise<void> {
        this.watcher = await this.etcd.watchPrefix(`${this.prefix}/client/`, () => {
            this.scheduleRefresh();
        });
    }

    /** watch 一次变更可能连着来几条（批量写入），合并成一次刷新 */
    private scheduleRefresh(): void {
        if (this.refreshTimer) return;
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            void this.refreshPublic().catch((err: unknown) =>
                this.logger.warn(`watch 触发的快照刷新失败：${String(err)}`)
            );
        }, 100);
        this.refreshTimer.unref?.();
    }

    // ─────────────────────────── 管理端 ───────────────────────────

    async listEntries(): Promise<ConfigEntry[]> {
        const { entries } = await this.etcd.getPrefix(`${this.prefix}/`);
        const out: ConfigEntry[] = [];

        for (const entry of entries) {
            const parsed = this.parseFullKey(entry.key);
            if (!parsed) continue;
            const decoded = decodeValue(entry.raw);
            out.push({
                scope: parsed.scope,
                key: parsed.key,
                value: decoded.value,
                description: decoded.description,
                revision: entry.revision,
                updatedAt: decoded.updatedAt,
                updatedBy: decoded.updatedBy,
            });
        }

        return out.sort(
            (a, b) =>
                a.scope.localeCompare(b.scope) || a.key.localeCompare(b.key)
        );
    }

    async getEntry(scope: ConfigScope, key: string): Promise<ConfigEntry> {
        assertScope(scope);
        assertKey(key);

        const fullKey = this.fullKey(scope, key);
        const entry = await this.etcd.get(fullKey);
        if (!entry) throw AppError.notFound(`配置 ${scope}/${key} 不存在`);

        const decoded = decodeValue(entry.raw);
        return {
            scope,
            key,
            value: decoded.value,
            description: decoded.description,
            revision: entry.revision,
            updatedAt: decoded.updatedAt,
            updatedBy: decoded.updatedBy,
        };
    }

    /**
     * 新建或更新。
     *
     * expectedRevision 存在时做 CAS：两个管理员同时编辑，后提交的一方拿到 409，
     * 而不是静默覆盖对方刚发布的配置。
     */
    async upsert(
        actor: string,
        scope: ConfigScope,
        key: string,
        input: { value: unknown; description?: string; expectedRevision?: number }
    ): Promise<ConfigEntry> {
        assertScope(scope);
        assertKey(key);

        const description = (input.description ?? '').trim();
        if (description.length > MAX_DESCRIPTION_LENGTH) {
            throw AppError.validation(`描述最多 ${MAX_DESCRIPTION_LENGTH} 个字符`);
        }

        const raw = encodeValue(input.value, description, actor);
        if (Buffer.byteLength(raw, 'utf8') > MAX_VALUE_BYTES) {
            throw AppError.validation(`配置值过大（上限 ${MAX_VALUE_BYTES / 1024}KB）`);
        }

        const fullKey = this.fullKey(scope, key);
        if (input.expectedRevision !== undefined) {
            const result = await this.etcd.putIfRevision(fullKey, raw, input.expectedRevision);
            if (!result.ok) {
                throw AppError.conflict('配置已被其他人修改，请刷新后重试', { key });
            }
        } else {
            await this.etcd.put(fullKey, raw);
        }

        // watch 是异步的（还有 100ms 合并窗口），管理端刚保存完就刷新公共页面
        // 会读到旧快照。写入后同步刷新一次，保证「保存 → 刷新浏览器」立即可见。
        await this.syncPublicSnapshot();
        return this.getEntry(scope, key);
    }

    async remove(scope: ConfigScope, key: string): Promise<void> {
        assertScope(scope);
        assertKey(key);
        const existing = await this.etcd.get(this.fullKey(scope, key));
        if (!existing) throw AppError.notFound(`配置 ${scope}/${key} 不存在`);
        await this.etcd.delete(this.fullKey(scope, key));
        await this.syncPublicSnapshot();
    }

    /** 最新的在前 */
    async history(scope: ConfigScope, key: string, limit = 20): Promise<ConfigHistoryItem[]> {
        assertScope(scope);
        assertKey(key);

        const events = await this.etcd.history(this.fullKey(scope, key), limit);
        return events
            .slice()
            .reverse()
            .map((event) => {
                if (event.deleted) {
                    return {
                        revision: event.revision,
                        deleted: true,
                        value: null,
                        description: null,
                        updatedAt: null,
                        updatedBy: null,
                    };
                }
                const decoded = decodeValue(event.raw);
                return {
                    revision: event.revision,
                    deleted: false,
                    value: decoded.value,
                    description: decoded.description,
                    updatedAt: decoded.updatedAt,
                    updatedBy: decoded.updatedBy,
                };
            });
    }

    /**
     * 回滚到某个历史 revision：把当时的 value 取出来，以一次新写入的方式落回去。
     * 不修改历史（etcd 本来也改不了），所以回滚本身也是可追溯的。
     */
    async rollback(
        actor: string,
        scope: ConfigScope,
        key: string,
        revision: number
    ): Promise<ConfigEntry> {
        assertScope(scope);
        assertKey(key);

        const fullKey = this.fullKey(scope, key);
        const target = await this.etcd.get(fullKey, revision);
        if (!target) {
            throw AppError.notFound('该版本不存在，或已被 etcd 压缩清理');
        }

        const decoded = decodeValue(target.raw);
        const current = await this.etcd.get(fullKey);
        const raw = encodeValue(decoded.value, decoded.description ?? '', actor);

        if (current) {
            // 回滚同样走 CAS，避免覆盖掉回滚期间别人的修改
            const result = await this.etcd.putIfRevision(fullKey, raw, current.revision);
            if (!result.ok) throw AppError.conflict('配置已被其他人修改，请刷新后重试');
        } else {
            await this.etcd.put(fullKey, raw);
        }

        await this.syncPublicSnapshot();
        return this.getEntry(scope, key);
    }

    /** 写完 etcd 后主动刷新一次公共快照；失败只记日志，不影响写入结果 */
    private async syncPublicSnapshot(): Promise<void> {
        if (!this.etcd.enabled) return;
        try {
            await this.refreshPublic();
        } catch (err) {
            this.logger.warn(`写入后刷新公共配置快照失败：${String(err)}`);
        }
    }

    // ─────────────────────────── 键位 ───────────────────────────

    private fullKey(scope: ConfigScope, key: string): string {
        return `${this.prefix}/${scope}/${key}`;
    }

    private parseFullKey(fullKey: string): { scope: ConfigScope; key: string } | null {
        const rest = fullKey.slice(this.prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash <= 0) return null;

        const scope = rest.slice(0, slash);
        const key = rest.slice(slash + 1);
        if (!CONFIG_SCOPES.includes(scope as ConfigScope)) return null;
        if (!KEY_PATTERN.test(key)) return null;
        return { scope: scope as ConfigScope, key };
    }
}

// ─────────────────────────── 编解码 ───────────────────────────

function encodeValue(value: unknown, description: string, actor: string): string {
    const envelope: Envelope = {
        __meta: 1,
        value,
        description,
        updatedBy: actor,
        updatedAt: new Date().toISOString(),
    };
    try {
        return JSON.stringify(envelope);
    } catch (err) {
        throw AppError.validation('配置值必须是可序列化的 JSON', err instanceof Error ? err.message : undefined);
    }
}

/**
 * 解码。兼容三种形态：
 *   1. 带 __meta 的信封（管理后台写入的）
 *   2. 任意 JSON（etcdctl 手工写的）
 *   3. 完全不是 JSON 的旧值 / 文本（原样当字符串）
 */
function decodeValue(raw: string): DecodedValue {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { value: raw, description: null, updatedBy: null, updatedAt: null };
    }

    if (isEnvelope(parsed)) {
        return {
            value: parsed.value,
            description: parsed.description ?? null,
            updatedBy: parsed.updatedBy ?? null,
            updatedAt: parsed.updatedAt ?? null,
        };
    }

    return { value: parsed, description: null, updatedBy: null, updatedAt: null };
}

function isEnvelope(value: unknown): value is Envelope {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { __meta?: unknown }).__meta === 1 &&
        'value' in value
    );
}

function assertScope(scope: string): asserts scope is ConfigScope {
    if (!CONFIG_SCOPES.includes(scope as ConfigScope)) {
        throw AppError.validation(`scope 只能是 ${CONFIG_SCOPES.join(' / ')}`);
    }
}

function assertKey(key: string): void {
    if (!KEY_PATTERN.test(key)) {
        throw AppError.validation(
            '配置键只能包含字母、数字、点、下划线、短横线，且以字母或数字开头（最长 80）'
        );
    }
}
