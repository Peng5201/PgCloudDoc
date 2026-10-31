/**
 * 双 token 的单元测试。
 *
 * 重点验三件事：
 *   1. access / refresh 用的是不同 secret，拿一个去验另一个必须失败
 *   2. 过期和签名错误能被区分开（客户端要据此决定「自动刷新」还是「重新登录」）
 *   3. token 哈希稳定且不可逆 —— 库里只存哈希
 *
 * 为什么 mock 掉 @nestjs/common：
 *   Nest 12 发布的是纯 ESM 包（package.json 里 type: module），
 *   jest 30 在 Node 22 上的 require() 实现不支持 require(esm)，
 *   连 `import { Injectable } from '@nestjs/common'` 都装不进来。
 *   这里只用到 @Injectable 这个装饰器（纯元数据），stub 掉即可 ——
 *   真正的 Nest 装配由 test/*.smoke.mjs 打真实服务来验证。
 */
import jwt from 'jsonwebtoken';
import { TokenIssuer } from './token';
import { AppError, ErrorCode } from '../../shared/errors/app-error';

const AUTH = {
    accessSecret: 'test-access-secret-0123456789',
    refreshSecret: 'test-refresh-secret-0123456789',
    accessTokenTtl: 900,
    refreshTokenTtl: 2592000,
    issuer: 'pgclouddoc',
    audience: 'pgclouddoc-client',
    cookie: { domain: undefined, secure: false, sameSite: 'lax' as const },
};

function makeService(auth: typeof AUTH = AUTH): TokenIssuer {
    return new TokenIssuer(auth);
}

const USER = {
    id: 'user-1',
    username: 'alice',
    email: 'alice@example.com',
    tokenVersion: 3,
};

describe('TokenService', () => {
    const service = makeService();

    describe('签发与校验', () => {
        it('签出的一对 token 都能各自验回来', () => {
            const familyId = service.newFamilyId();
            const issued = service.issueTokens(USER, familyId);

            const access = service.verifyAccessToken(issued.accessToken);
            expect(access.sub).toBe(USER.id);
            expect(access.username).toBe('alice');
            expect(access.tokenVersion).toBe(3);
            expect(access.type).toBe('access');
            expect(access.jti).toBe(issued.accessJti);

            const refresh = service.verifyRefreshToken(issued.refreshToken);
            expect(refresh.sub).toBe(USER.id);
            expect(refresh.familyId).toBe(familyId);
            expect(refresh.type).toBe('refresh');
        });

        it('access 和 refresh 的有效期不同', () => {
            const issued = service.issueTokens(USER, service.newFamilyId());
            const accessExp = service.verifyAccessToken(issued.accessToken).exp!;
            const refreshExp = service.verifyRefreshToken(issued.refreshToken).exp!;
            // refresh 必须活得比 access 久，否则双 token 没有意义
            expect(refreshExp - accessExp).toBeGreaterThan(2000);
        });
    });

    describe('类型不能混用', () => {
        it('拿 refresh token 去验 access 必须失败', () => {
            const issued = service.issueTokens(USER, service.newFamilyId());
            expect(() => service.verifyAccessToken(issued.refreshToken)).toThrow(AppError);
        });

        it('拿 access token 去验 refresh 必须失败', () => {
            const issued = service.issueTokens(USER, service.newFamilyId());
            expect(() => service.verifyRefreshToken(issued.accessToken)).toThrow(AppError);
        });
    });

    describe('secret 隔离', () => {
        it('用 refresh secret 造的 token 不能当 access 用', () => {
            const forged = jwt.sign(
                { sub: USER.id, type: 'access', jti: 'x', tokenVersion: 3 },
                AUTH.refreshSecret,
                { expiresIn: 60 }
            );
            expect(() => service.verifyAccessToken(forged)).toThrow(AppError);
        });
    });

    describe('错误分类', () => {
        it('过期 → TOKEN_EXPIRED', () => {
            const expired = jwt.sign(
                { sub: USER.id, type: 'access', jti: 'x', tokenVersion: 3 },
                AUTH.accessSecret,
                { expiresIn: -10, issuer: AUTH.issuer, audience: AUTH.audience }
            );

            try {
                service.verifyAccessToken(expired);
                fail('应当抛错');
            } catch (err) {
                expect((err as AppError).code).toBe(ErrorCode.TOKEN_EXPIRED);
            }
        });

        it('签名不对 → TOKEN_INVALID', () => {
            try {
                service.verifyAccessToken('not-a-jwt');
                fail('应当抛错');
            } catch (err) {
                expect((err as AppError).code).toBe(ErrorCode.TOKEN_INVALID);
            }
        });

        it('issuer 不匹配也会被拒', () => {
            const wrongIssuer = jwt.sign(
                { sub: USER.id, type: 'access', jti: 'x', tokenVersion: 3 },
                AUTH.accessSecret,
                { expiresIn: 600, issuer: 'someone-else', audience: AUTH.audience }
            );
            expect(() => service.verifyAccessToken(wrongIssuer)).toThrow(AppError);
        });
    });

    describe('token 哈希', () => {
        it('同一个 token 哈希稳定', () => {
            const issued = service.issueTokens(USER, service.newFamilyId());
            expect(service.hashToken(issued.refreshToken)).toBe(
                service.hashToken(issued.refreshToken)
            );
        });

        it('哈希不等于明文，且长度固定 64（sha256 hex）', () => {
            const issued = service.issueTokens(USER, service.newFamilyId());
            const hash = service.hashToken(issued.refreshToken);
            expect(hash).not.toContain(issued.refreshToken);
            expect(hash).toHaveLength(64);
            expect(hash).toMatch(/^[0-9a-f]{64}$/);
        });

        it('不同 token 哈希不同', () => {
            const a = service.issueTokens(USER, service.newFamilyId());
            const b = service.issueTokens(USER, service.newFamilyId());
            expect(service.hashToken(a.refreshToken)).not.toBe(
                service.hashToken(b.refreshToken)
            );
        });
    });
});
