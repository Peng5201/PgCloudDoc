/**
 * 插件 zip 校验与解包。
 *
 * 上传包是**管理员提交的不可信输入**，即使只有管理员能上传，也不能假设它安全：
 *   - zip slip（`../` 路径穿越）
 *   - zip bomb（声明大小 / 实际解压量双重限制）
 *   - 危险扩展名（.html / .node / 可执行文件）
 *
 * 解包到调用方给的临时目录；manifest 用和前端/插件构建完全相同的 zod schema 校验。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, posix, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { Open } from 'unzipper';
import type { PluginManifest } from '@pgclouddoc/plugin-api';
import { AppError } from '../../shared/errors/app-error';
import { loadPluginApi } from './plugin-api.loader';

const MAX_ENTRIES = 2000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_PATH_LENGTH = 200;

const ALLOWED_EXTENSIONS = new Set([
    '.js',
    '.mjs',
    '.css',
    '.json',
    '.map',
    '.svg',
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.woff2',
    '.txt',
    '.md',
    '.wasm',
]);

export interface ValidatedPackageFile {
    path: string;
    sha256: string;
    bytes: number;
}

export interface ValidatedPluginPackage {
    manifest: PluginManifest;
    files: ValidatedPackageFile[];
    assetsBytes: number;
    zipSha256: string;
}

@Injectable()
export class PluginZipService {
    async validateAndExtract(buffer: Buffer, destDir: string): Promise<ValidatedPluginPackage> {
        if (!buffer.length) throw AppError.validation('上传文件为空');

        let directory;
        try {
            directory = await Open.buffer(buffer);
        } catch (err) {
            throw AppError.validation(
                '不是合法的 zip 文件',
                err instanceof Error ? err.message : undefined
            );
        }

        const entries = directory.files.filter((entry) => entry.type === 'File');
        if (entries.length === 0) throw AppError.validation('zip 内没有文件');
        if (entries.length > MAX_ENTRIES) {
            throw AppError.validation(`zip 文件数量超过上限（${MAX_ENTRIES}）`);
        }

        // 先做完整路径/大小校验，再开始解压，避免解到一半才发现非法条目
        let declaredBytes = 0;
        for (const entry of entries) {
            assertSafePath(entry.path);
            assertAllowedExtension(entry.path);

            if (entry.uncompressedSize > MAX_FILE_BYTES) {
                throw AppError.validation(`文件过大：${entry.path}`);
            }
            declaredBytes += entry.uncompressedSize;
            if (declaredBytes > MAX_TOTAL_BYTES) {
                throw AppError.validation('解压后总大小超过上限（100MB）');
            }
        }

        if (!entries.some((entry) => entry.path === 'plugin.json')) {
            throw AppError.validation('zip 根目录缺少 plugin.json');
        }

        const root = resolve(destDir);
        const files: ValidatedPackageFile[] = [];
        let totalBytes = 0;

        for (const entry of entries) {
            const target = resolve(root, entry.path);
            if (target !== root && !target.startsWith(root + sep)) {
                throw AppError.validation(`非法路径：${entry.path}`);
            }

            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of entry.stream()) {
                const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
                size += data.length;
                totalBytes += data.length;

                // 不信任 central directory 里声明的大小，按实际读到的字节再拦一次
                if (size > MAX_FILE_BYTES) {
                    throw AppError.validation(`文件解压后过大：${entry.path}`);
                }
                if (totalBytes > MAX_TOTAL_BYTES) {
                    throw AppError.validation('解压后总大小超过上限（100MB）');
                }
                chunks.push(data);
            }

            const data = Buffer.concat(chunks);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, data);

            files.push({
                path: entry.path,
                sha256: createHash('sha256').update(data).digest('hex'),
                bytes: data.length,
            });
        }

        const manifest = await this.parseManifest(root);
        const filePaths = new Set(files.map((file) => file.path));

        if (!filePaths.has(manifest.entry)) {
            throw AppError.validation(`manifest.entry 指向的文件不存在：${manifest.entry}`);
        }
        if (manifest.style && !filePaths.has(manifest.style)) {
            throw AppError.validation(`manifest.style 指向的文件不存在：${manifest.style}`);
        }
        if (manifest.icon && !filePaths.has(manifest.icon)) {
            throw AppError.validation(`manifest.icon 指向的文件不存在：${manifest.icon}`);
        }

        return {
            manifest,
            files,
            assetsBytes: totalBytes,
            zipSha256: createHash('sha256').update(buffer).digest('hex'),
        };
    }

    private async parseManifest(root: string): Promise<PluginManifest> {
        let raw: string;
        try {
            raw = await readFile(join(root, 'plugin.json'), 'utf8');
        } catch (err) {
            throw AppError.validation(
                '读取 plugin.json 失败',
                err instanceof Error ? err.message : undefined
            );
        }

        let json: unknown;
        try {
            json = JSON.parse(raw);
        } catch (err) {
            throw AppError.validation(
                'plugin.json 不是合法 JSON',
                err instanceof Error ? err.message : undefined
            );
        }

        // 后端是 CJS，plugin-api 是 ESM：动态 import 是两者共存的唯一方式
        const api = await loadPluginApi();
        try {
            return api.parseManifest(json);
        } catch (err) {
            throw AppError.validation(
                err instanceof Error ? err.message : 'plugin.json 校验失败'
            );
        }
    }
}

function assertSafePath(name: string): void {
    if (!name || name.length > MAX_PATH_LENGTH) {
        throw AppError.validation(`zip 内路径长度非法：${name.slice(0, 80)}`);
    }
    if (name.includes('\\') || name.includes('\0')) {
        throw AppError.validation(`zip 内路径包含非法字符：${name}`);
    }
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
        throw AppError.validation(`zip 内不允许绝对路径：${name}`);
    }

    const normalized = posix.normalize(name);
    if (normalized !== name || normalized === '..' || normalized.startsWith('../')) {
        throw AppError.validation(`zip 内路径越界：${name}`);
    }
}

function assertAllowedExtension(name: string): void {
    const extension = extname(name).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(extension)) return;

    // LICENSE / README 这类无扩展名文件允许保留
    const base = posix.basename(name).toUpperCase();
    if (base === 'LICENSE' || base === 'README') return;

    throw AppError.validation(`不允许的文件类型：${name}`);
}
