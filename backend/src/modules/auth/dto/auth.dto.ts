/**
 * 认证接口的入参/出参契约。
 *
 * 入参用 class-validator 严格校验（whitelist + forbidNonWhitelisted），
 * 多传字段直接 422 —— 防的是「客户端多传个 role: admin」这类参数污染。
 */

import {
    IsEmail,
    IsNotEmpty,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    MinLength,
} from 'class-validator';

/** 用户名：字母数字下划线，3-32 位 */
const USERNAME_RULE = /^[a-zA-Z0-9_]{3,32}$/;

export class RegisterDto {
    @IsEmail({}, { message: '邮箱格式不正确' })
    @MaxLength(254)
    email!: string;

    @Matches(USERNAME_RULE, {
        message: '用户名只能包含字母、数字、下划线，长度 3-32',
    })
    username!: string;

    /**
     * 密码策略：8-72 位，至少一个字母和一个数字。
     * 72 是 argon2 的输入上限，超过会被截断（不是报错，是静默截断 —— 更危险）。
     */
    @IsString()
    @MinLength(8, { message: '密码至少 8 位' })
    @MaxLength(72, { message: '密码最多 72 位' })
    @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
        message: '密码需同时包含字母和数字',
    })
    password!: string;

    @IsOptional()
    @IsString()
    @MaxLength(64)
    displayName?: string;
}

export class LoginDto {
    /** 邮箱或用户名都行 */
    @IsString()
    @IsNotEmpty({ message: '请输入邮箱或用户名' })
    @MaxLength(254)
    identifier!: string;

    @IsString()
    @IsNotEmpty({ message: '请输入密码' })
    @MaxLength(72)
    password!: string;
}

export class UpdateProfileDto {
    @IsOptional()
    @IsString()
    @MaxLength(64)
    displayName?: string;

    @IsOptional()
    @IsString()
    @MaxLength(512)
    avatarUrl?: string;
}

export class ChangePasswordDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(72)
    currentPassword!: string;

    @IsString()
    @MinLength(8)
    @MaxLength(72)
    @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
        message: '密码需同时包含字母和数字',
    })
    newPassword!: string;
}

/** 对外暴露的用户信息。**绝不包含 passwordHash** */
export interface UserDto {
    id: string;
    email: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    createdAt: string;
}

export interface AuthResultDto {
    user: UserDto;
    /** access token，客户端放 Authorization: Bearer */
    accessToken: string;
    /** 剩余秒数 */
    expiresInSeconds: number;
    /** refresh token 同时也通过 httpOnly cookie 下发，这里是给非浏览器客户端用的 */
    refreshToken: string;
}

export function toUserDto(user: {
    id: string;
    email: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    createdAt: Date;
}): UserDto {
    return {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt.toISOString(),
    };
}
