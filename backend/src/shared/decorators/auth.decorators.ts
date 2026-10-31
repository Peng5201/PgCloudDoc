/**
 * 认证相关的公共类型 + 装饰器。
 *
 * 放在 common 而不是 modules/auth：Guard 之外的地方（比如 collab 的 WS 握手）
 * 也要声明「这个入参是当前用户」，公共层不该依赖具体 auth 模块。
 */

import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export const IS_PUBLIC = 'IS_PUBLIC';

/**
 * 标记接口无需登录。
 *
 * 全局 JwtAuthGuard 会跳过带这个装饰器的路由 ——
 * 「默认拒绝、显式放行」比「默认放行、逐个加 guard」安全得多：
 * 新增接口忘了加 guard 是常见事故源，反过来忘了加 @Public 只是麻烦一点。
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** JWT 解析出来的用户身份 */
export interface AuthUser {
    id: string;
    username: string;
    email: string;
    /** JWT 里带的 tokenVersion，用于校验存量 token 是否已被作废 */
    tokenVersion: number;
}

export const REQUEST_USER_KEY = 'user';

/**
 * 取当前登录用户。
 *
 * 用法：`me(@CurrentUser() user: AuthUser)`
 * 默认 required=true —— 需要用户信息的接口拿不到就该报错，
 * 而不是静默地传个 undefined 进去然后在深层炸掉。
 */
export const CurrentUser = createParamDecorator(
    (data: keyof AuthUser | undefined, context: ExecutionContext): AuthUser | AuthUser[keyof AuthUser] => {
        const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
        const user = request.user;
        if (!user) {
            // Guard 已经保证有 user；走到这里是装配错误
            throw new Error('CurrentUser 只能用在受 JwtAuthGuard 保护的路由上');
        }
        return data ? user[data] : user;
    }
);

/** 取请求上下文里的 requestId */
export const RequestId = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<Request & { requestId?: string }>();
    return request.requestId ?? '-';
});
