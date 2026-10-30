/**
 * 密码哈希。
 *
 * 用 argon2id（@node-rs/argon2）而不是 bcrypt：
 *   - argon2id 是 PHC 竞赛冠军，抗 GPU/ASIC 暴力破解
 *   - @node-rs 是预编译原生二进制，比 node-argon2 少一层 node-gyp 编译
 *   - 参数（内存/时间/并行度）跟着哈希串一起存，将来调参不影响老用户
 *
 * 密码永不明文落库、永不进日志、永不出现在任何 API 响应里。
 */

import { Injectable } from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/**
 * 256MB 内存 + 3 轮 —— 在「用户等得起」和「攻击者算不起」之间取平衡。
 *
 * 不显式传 algorithm：@node-rs/argon2 的默认值就是 Argon2id，
 * 而它的 Algorithm 是 const enum，`isolatedModules: true` 下不能引用其成员。
 */
const HASH_OPTIONS = {
    memoryCost: 65536, // KiB，64MB
    timeCost: 3,
    parallelism: 4,
};

@Injectable()
export class PasswordService {
    async hash(plain: string): Promise<string> {
        return argonHash(plain, HASH_OPTIONS);
    }

    /**
     * 校验密码。
     *
     * 第二个参数（密码哈希）缺失时**不能直接返回 false**，
     * 否则「这个用户名没设过密码」会被时序探测出来。
     * 改成对一个假哈希跑一遍 verify，让耗时和正常校验一致。
     */
    async verify(plain: string, hashed: string | null | undefined): Promise<boolean> {
        if (!hashed) {
            // 消耗一次真实的 argon2 计算，抹平时序差异
            await argonHash('timing-equalizer', HASH_OPTIONS);
            return false;
        }
        try {
            return await argonVerify(hashed, plain);
        } catch {
            // 哈希串损坏（数据问题），按校验失败处理，别把异常抛给用户
            return false;
        }
    }
}
