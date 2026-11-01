/**
 * `unzipper` 没有自带类型。这里只声明插件上传用到的子集，
 * 避免为了几个字段引入 @types/unzipper。
 */
declare module 'unzipper' {
    import type { Readable } from 'node:stream';

    export interface ZipEntry {
        /** zip 内的相对路径（可能含 `..`，使用前必须自行校验） */
        path: string;
        type: 'File' | 'Directory';
        /** 解压后大小，用于读取前做 zip bomb 防护 */
        uncompressedSize: number;
        compressedSize: number;
        stream(): Readable;
    }

    export interface Directory {
        files: ZipEntry[];
    }

    export const Open: {
        buffer(buffer: Buffer): Promise<Directory>;
    };
}
