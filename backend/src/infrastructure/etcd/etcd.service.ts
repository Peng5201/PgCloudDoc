/**
 * etcd 客户端封装 —— 只做「键值操作 + 版本号」，不含任何业务语义。
 *
 * 为什么不让前端直连 etcd：
 *   1. etcd 是集群的内网组件，暴露到公网等于把整棵配置树（可能含密码/开关）交出去；
 *   2. etcd 的 HTTP/gRPC 接口没有面向浏览器的 CORS 与鉴权模型；
 *   3. 浏览器需要的是「一小份白名单配置」，不是原始 KV。
 * 所以管理后台写 etcd、后端读 etcd，前端只访问后端的 /api/v1/config。
 *
 * ETCD_ENDPOINTS 为空时整个服务降级为「未启用」：
 * 应用照常启动，/api/v1/config 返回空配置，后台接口返回 503。
 * 配置中心不是核心链路，不能因为它没配就让站点起不来。
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Etcd3, type Watcher } from 'etcd3';
import { AppConfigService } from '../../config/app-config.service';
import { AppError, ErrorCode } from '../../shared/errors/app-error';

/** etcd 里的一条原始记录 */
export interface EtcdEntry {
    key: string;
    raw: string;
    /** 最后修改时集群的 revision，用于乐观并发和回滚 */
    revision: number;
    /** 首次创建时的 revision，历史查询从这里开始重放 */
    createRevision: number;
}

export interface EtcdHistoryEvent {
    revision: number;
    raw: string;
    deleted: boolean;
}

@Injectable()
export class EtcdService implements OnModuleDestroy {
    private readonly logger = new Logger(EtcdService.name);
    private readonly client: Etcd3 | null;

    constructor(config: AppConfigService) {
        const { endpoints, username, password } = config.etcd;
        this.client = endpoints.length
            ? new Etcd3({
                  // etcd3 要求 host 带协议前缀；允许配置里只写 host:port
                  hosts: endpoints.map((host) =>
                      /^https?:\/\//.test(host) ? host : `http://${host}`
                  ),
                  // 不设上限的话 etcd 不可达时请求会一直挂着，把后台和首屏一起拖死
                  dialTimeout: 3000,
                  defaultCallOptions: (context) =>
                      context.isStream ? {} : { deadline: Date.now() + 3000 },
                  ...(username ? { auth: { username, password: password ?? '' } } : {}),
              })
            : null;

        if (!this.client) {
            this.logger.warn('ETCD_ENDPOINTS 为空，配置中心未启用');
        }
    }

    get enabled(): boolean {
        return this.client !== null;
    }

    private require(): Etcd3 {
        if (!this.client) {
            throw new AppError(
                ErrorCode.SERVICE_UNAVAILABLE,
                '配置中心未启用（ETCD_ENDPOINTS 为空）'
            );
        }
        return this.client;
    }

    /** 健康检查用 */
    async ping(): Promise<boolean> {
        if (!this.client) return false;
        // etcd3 没有专门的 ping；做一次最小的 range 即可，异常由调用方捕获
        await this.client.get('__health__').exec();
        return true;
    }

    /** 按前缀读取快照。revision 是读取时的全局 revision，前端拿它做版本号 */
    async getPrefix(prefix: string): Promise<{ revision: number; entries: EtcdEntry[] }> {
        const res = await this.require().getAll().prefix(prefix).exec();
        return {
            revision: Number(res.header.revision),
            entries: res.kvs.map((kv) => ({
                key: kv.key.toString('utf8'),
                raw: kv.value.toString('utf8'),
                revision: Number(kv.mod_revision),
                createRevision: Number(kv.create_revision),
            })),
        };
    }

    /** 读单键。传 revision 可读历史版本（回滚用） */
    async get(key: string, revision?: number): Promise<EtcdEntry | null> {
        const client = this.require();
        const builder = client.get(key);
        if (revision !== undefined) builder.revision(revision);
        const res = await builder.exec();
        const kv = res.kvs[0];
        if (!kv) return null;
        return {
            key: kv.key.toString('utf8'),
            raw: kv.value.toString('utf8'),
            revision: Number(kv.mod_revision),
            createRevision: Number(kv.create_revision),
        };
    }

    /** 无条件写入，返回新的 revision */
    async put(key: string, raw: string): Promise<number> {
        const res = await this.require().put(key).value(raw);
        return Number(res.header.revision);
    }

    /**
     * CAS 写入：只有当前 modRevision 等于 expected 时才写。
     * 管理后台用它防止两个管理员互相覆盖。
     */
    async putIfRevision(
        key: string,
        raw: string,
        expectedRevision: number
    ): Promise<{ ok: boolean; revision: number }> {
        const client = this.require();
        const res = await client
            .if(key, 'Mod', '==', expectedRevision)
            .then(client.put(key).value(raw))
            .commit();
        return { ok: Boolean(res.succeeded), revision: Number(res.header.revision) };
    }

    async delete(key: string): Promise<void> {
        await this.require().delete().key(key);
    }

    /**
     * 监听某个前缀。返回 Watcher，调用方负责在销毁时 cancel。
     * etcd3 内部会在断线后自动重连，这里只把错误抛出给上层记日志。
     */
    async watchPrefix(prefix: string, listener: () => void): Promise<Watcher> {
        const watcher = await this.require().watch().prefix(prefix).create();
        watcher.on('put', () => listener());
        watcher.on('delete', () => listener());
        watcher.on('error', (err) => this.logger.warn(`etcd watch 异常：${err.message}`));
        return watcher;
    }

    /**
     * 读取某个键的历史版本。
     *
     * etcd 没有「列出某键所有版本」的接口，正确做法是从 createRevision 起
     * 重放 watch，收到最新 revision 后立刻取消。只看不改，不需要补偿逻辑。
     */
    async history(key: string, limit = 20): Promise<EtcdHistoryEvent[]> {
        const current = await this.get(key);
        if (!current) return [];

        const watcher = await this.require()
            .watch()
            .key(key)
            .startRevision(String(current.createRevision))
            .create();

        return new Promise<EtcdHistoryEvent[]>((resolve) => {
            const events: EtcdHistoryEvent[] = [];
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | null = null;

            const finish = (): void => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                void watcher.cancel().catch(() => undefined);
                resolve(events.slice(-limit));
            };

            const push = (revision: number, raw: string, deleted: boolean): void => {
                events.push({ revision, raw, deleted });
                // 只看最新 N 条：不能按条数提前收尾，否则拿到的是最早的那些版本
                if (revision >= current.revision) finish();
            };

            watcher.on('put', (kv) => push(Number(kv.mod_revision), kv.value.toString('utf8'), false));
            watcher.on('delete', (kv) => push(Number(kv.mod_revision), '', true));
            watcher.on('error', finish);

            // 兜底：etcd 被 compact 过时历史可能永远等不到，不能把请求挂死
            timer = setTimeout(finish, 1000);
        });
    }

    onModuleDestroy(): void {
        this.client?.close();
    }
}
