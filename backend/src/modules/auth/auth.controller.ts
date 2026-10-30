/**
 * 认证接口。
 *
 * Cookie 策略：
 *   refresh token 只进 httpOnly cookie，path 收窄到 /api/v1/auth ——
 *   cookie 只在刷新/登出时发出去，普通业务请求根本不带它，泄漏面小一个数量级。
 *   access token 不进 cookie，走 Authorization 头，天然不受 CSRF 影响。
 */

import {
    Body,
    Controller,
    Get,
    HttpCode,
    Param,
    Post,
    Query,
    Req,
    Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService, RequestMeta } from './auth.service';
import { OAuthService } from './oauth/oauth.service';
import { AppConfigService } from '../../config/app-config.service';
import {
    AuthResultDto,
    ChangePasswordDto,
    LoginDto,
    RegisterDto,
    UpdateProfileDto,
    UserDto,
} from './dto/auth.dto';
import { CurrentUser, Public, type AuthUser } from '../../common/decorators/auth.decorators';
import { RateLimit } from '../../common/guards/rate-limit.guard';
import { AppError } from '../../common/errors/app-error';
import { REFRESH_COOKIE_NAME, extractAccessToken } from './jwt-auth.guard';
import { UserRepository } from '../users/user.repository';
import { toUserDto } from './dto/auth.dto';

const AUTH_COOKIE_PATH = '/api/v1/auth';

@Controller('api/v1/auth')
export class AuthController {
    constructor(
        private readonly auth: AuthService,
        private readonly oauth: OAuthService,
        private readonly users: UserRepository,
        private readonly config: AppConfigService
    ) {}

    // ─────────────────────────── 注册 / 登录 ───────────────────────────

    @Public()
    @RateLimit({ bucket: 'auth:register', windowMs: 60_000, limit: 10 })
    @Post('register')
    async register(
        @Body() dto: RegisterDto,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response
    ): Promise<AuthResultDto> {
        const result = await this.auth.register(dto, this.meta(req));
        this.setRefreshCookie(res, result.refreshToken);
        return result;
    }

    @Public()
    @RateLimit({ bucket: 'auth:login', windowMs: 60_000, limit: 20 })
    @Post('login')
    @HttpCode(200)
    async login(
        @Body() dto: LoginDto,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response
    ): Promise<AuthResultDto> {
        const result = await this.auth.login(dto, this.meta(req));
        this.setRefreshCookie(res, result.refreshToken);
        return result;
    }

    // ─────────────────────────── 刷新 / 登出 ───────────────────────────

    @Public()
    @RateLimit({ bucket: 'auth:refresh', windowMs: 60_000, limit: 60 })
    @Post('refresh')
    @HttpCode(200)
    async refresh(
        @Req() req: Request & { body?: { refreshToken?: string } },
        @Res({ passthrough: true }) res: Response
    ): Promise<AuthResultDto> {
        // 优先读 cookie；非浏览器客户端可以放 body
        const raw = req.cookies?.[REFRESH_COOKIE_NAME] ?? req.body?.refreshToken;
        if (!raw) {
            throw AppError.unauthorized('缺少刷新令牌');
        }

        const result = await this.auth.refresh(raw, this.meta(req));
        // 轮换：新 cookie 顶掉旧的
        this.setRefreshCookie(res, result.refreshToken);
        return result;
    }

    @Post('logout')
    @HttpCode(200)
    async logout(
        @CurrentUser() user: AuthUser,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response
    ): Promise<{ loggedOut: true }> {
        const raw = req.cookies?.[REFRESH_COOKIE_NAME] ?? req.body?.refreshToken;
        await this.auth.logout(user.id, raw, extractAccessToken(req), this.meta(req));
        this.clearRefreshCookie(res);
        return { loggedOut: true };
    }

    // ─────────────────────────── 用户 ───────────────────────────

    @Get('me')
    me(@CurrentUser() user: AuthUser): Promise<UserDto> {
        return this.auth.me(user.id);
    }

    @Post('change-password')
    @HttpCode(200)
    async changePassword(
        @CurrentUser() user: AuthUser,
        @Body() dto: ChangePasswordDto,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response
    ): Promise<{ changed: true }> {
        await this.auth.changePassword(user.id, dto, this.meta(req));
        // 改密码后所有会话失效，本地 cookie 也清掉
        this.clearRefreshCookie(res);
        return { changed: true };
    }

    @Post('profile')
    @HttpCode(200)
    async updateProfile(
        @CurrentUser() user: AuthUser,
        @Body() dto: UpdateProfileDto
    ): Promise<UserDto> {
        const updated = await this.users.updateProfile(user.id, dto);
        return toUserDto(updated);
    }

    // ─────────────────────────── OAuth2 ───────────────────────────

    @Public()
    @Get('oauth/:provider')
    async oauthStart(@Param('provider') provider: string): Promise<{ authorizeUrl: string }> {
        return { authorizeUrl: await this.oauth.begin(provider) };
    }

    @Public()
    @Get('oauth/:provider/callback')
    async oauthCallback(
        @Param('provider') provider: string,
        @Query('code') code: string,
        @Query('state') state: string,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response
    ): Promise<{ accessToken: string }> {
        if (!code || !state) {
            throw AppError.badRequest('缺少 code 或 state 参数');
        }

        const { userId } = await this.oauth.complete(provider, code, state);
        const user = await this.users.findById(userId);
        if (!user) {
            throw AppError.notFound('用户不存在');
        }

        const result = await this.auth.loginAsExisting(user, this.meta(req));
        this.setRefreshCookie(res, result.refreshToken);
        return { accessToken: result.accessToken };
    }

    // ─────────────────────────── 内部 ───────────────────────────

    private meta(req: Request): RequestMeta {
        return { ip: req.ip, userAgent: req.headers['user-agent'] };
    }

    private setRefreshCookie(res: Response, token: string): void {
        const { auth } = this.config;
        res.cookie(REFRESH_COOKIE_NAME, token, {
            httpOnly: true, // JS 读不到，XSS 偷不走
            secure: auth.cookie.secure, // 生产必须 true（HTTPS）
            sameSite: auth.cookie.sameSite,
            domain: auth.cookie.domain,
            // path 收窄到 auth 路由：业务请求不带这个 cookie
            path: AUTH_COOKIE_PATH,
            maxAge: auth.refreshTokenTtl * 1000,
        });
    }

    private clearRefreshCookie(res: Response): void {
        res.clearCookie(REFRESH_COOKIE_NAME, {
            path: AUTH_COOKIE_PATH,
            domain: this.config.auth.cookie.domain,
        });
    }
}
