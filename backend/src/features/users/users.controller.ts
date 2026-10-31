import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { UsersService } from './users.service';
import { CurrentUser, type AuthUser } from '../../shared/decorators/auth.decorators';
import { UpdateProfileDto } from '../auth/dto/auth.dto';
import { toUserDto, UserDto } from '../auth/dto/auth.dto';
import { HttpCache } from '../../shared/interceptors/http-cache.interceptor';

@Controller('api/v1/users')
export class UsersController {
    constructor(private readonly users: UsersService) {}

    /** 当前登录用户 */
    @Get('me')
    async me(@CurrentUser() user: AuthUser): Promise<UserDto> {
        return toUserDto(await this.users.getProfile(user.id));
    }

    /**
     * 公开资料页。
     * 走协商缓存：资料几乎不变，304 能省掉绝大部分响应体。
     */
    @HttpCache({ etag: 'auto', maxAgeSeconds: 60, private: false })
    @Get(':id')
    async getOne(@Param('id') id: string): Promise<UserDto> {
        return toUserDto(await this.users.getProfile(id));
    }

    @Post('me')
    async updateMe(
        @CurrentUser() user: AuthUser,
        @Body() dto: UpdateProfileDto
    ): Promise<UserDto> {
        return toUserDto(await this.users.updateProfile(user.id, dto));
    }
}
