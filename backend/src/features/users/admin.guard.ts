/**
 * 管理员 Guard。
 *
 * 权限**从库里查**，不从 JWT 读：token 里放 role 的话，
 * 撤销管理员权限要等 token 过期才生效（access token 默认 15 分钟），
 * 而这段窗口足够做完一次破坏性操作。
 *
 * 必须挂在全局 JwtAuthGuard 之后（Nest 里全局 Guard 先于控制器 Guard 执行），
 * 所以这里能确定 request.user 已经存在。
 */

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { UserRole } from '../../infrastructure/prisma/generated/client';
import { AppError } from '../../shared/errors/app-error';
import type { AuthUser } from '../../shared/decorators/auth.decorators';
import { UserRepository } from './user.repository';

@Injectable()
export class AdminGuard implements CanActivate {
    constructor(private readonly users: UserRepository) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
        const user = request.user;
        if (!user) throw AppError.unauthorized();

        const role = await this.users.findRoleById(user.id);
        if (role !== UserRole.ADMIN) {
            throw AppError.forbidden('需要管理员权限');
        }
        return true;
    }
}
