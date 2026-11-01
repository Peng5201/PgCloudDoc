/**
 * 插件产物存储。
 *
 * 目录布局（PLUGIN_STORAGE_DIR）：
 *   zips/<pluginKey>/<version>.zip          原始包（审计 / 回滚）
 *   assets/<pluginKey>/<version>/...        解包后的静态文件（nginx 只读挂载）
 *   tmp/<uuid>/                             上传解包临时目录
 *
 * 发布是原子的：先解到 tmp，校验通过后 rename 到 assets/<key>/<version>。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { AppError } from '../../shared/errors/app-error';

@Injectable()
export class PluginStorageService implements OnModuleInit {
    readonly root: string;
    readonly assetsDir: string;
    readonly zipsDir: string;
    readonly tmpDir: string;

    constructor(config: AppConfigService) {
        this.root = resolve(config.plugins.storageDir);
        this.assetsDir = join(this.root, 'assets');
        this.zipsDir = join(this.root, 'zips');
        this.tmpDir = join(this.root, 'tmp');
    }

    async onModuleInit(): Promise<void> {
        await Promise.all([
            mkdir(this.assetsDir, { recursive: true }),
            mkdir(this.zipsDir, { recursive: true }),
            mkdir(this.tmpDir, { recursive: true }),
        ]);
    }

    async createTempDir(): Promise<string> {
        const dir = join(this.tmpDir, randomUUID());
        await mkdir(dir, { recursive: true });
        return dir;
    }

    async removeTempDir(dir: string): Promise<void> {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }

    /**
     * 把校验通过的临时目录发布为不可变版本目录。
     * 目标已存在说明同版本被重复上传，直接冲突，不覆盖。
     */
    async publishVersion(pluginKey: string, version: string, tempDir: string): Promise<string> {
        const target = join(this.assetsDir, pluginKey, version);
        if (await pathExists(target)) {
            throw AppError.conflict(`插件 ${pluginKey}@${version} 已存在，版本发布后不可覆盖`);
        }

        await mkdir(dirname(target), { recursive: true });
        await rename(tempDir, target);
        return target;
    }

    async writeZip(pluginKey: string, version: string, buffer: Buffer): Promise<string> {
        const target = join(this.zipsDir, pluginKey, `${version}.zip`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, buffer);
        return target;
    }

    /** DB 写入失败时回滚已落盘的产物 */
    async removeVersion(pluginKey: string, version: string): Promise<void> {
        await Promise.all([
            rm(join(this.assetsDir, pluginKey, version), { recursive: true, force: true }).catch(
                () => undefined
            ),
            rm(join(this.zipsDir, pluginKey, `${version}.zip`), { force: true }).catch(
                () => undefined
            ),
        ]);
    }
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}
