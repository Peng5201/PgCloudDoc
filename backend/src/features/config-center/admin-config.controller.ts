/**
 * 管理后台的配置接口。全部要求 ADMIN 角色。
 *
 * 路径参数 scope / key 在 service 里统一校验：直接写在 URL path 里，
 * 用 DTO 校验不到，service 的 assert 是唯一入口。
 */

import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Post,
    Put,
    Query,
    UseGuards,
} from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../shared/decorators/auth.decorators';
import { AdminGuard } from '../users/admin.guard';
import { ConfigCenterService, type ConfigEntry, type ConfigHistoryItem } from './config-center.service';
import { RollbackConfigDto, UpsertConfigDto } from './config.dto';

@Controller('api/v1/admin/config')
@UseGuards(AdminGuard)
export class AdminConfigController {
    constructor(private readonly configCenter: ConfigCenterService) {}

    /** 列出 client / server 两个 scope 的全部配置 */
    @Get()
    list(): Promise<ConfigEntry[]> {
        return this.configCenter.listEntries();
    }

    @Get(':scope/:key')
    get(@Param('scope') scope: string, @Param('key') key: string): Promise<ConfigEntry> {
        return this.configCenter.getEntry(scope as 'client' | 'server', key);
    }

    /** 新建或更新。带 expectedRevision 时做 CAS */
    @Put(':scope/:key')
    upsert(
        @CurrentUser() user: AuthUser,
        @Param('scope') scope: string,
        @Param('key') key: string,
        @Body() dto: UpsertConfigDto
    ): Promise<ConfigEntry> {
        return this.configCenter.upsert(user.email, scope as 'client' | 'server', key, dto);
    }

    @Delete(':scope/:key')
    async remove(
        @Param('scope') scope: string,
        @Param('key') key: string
    ): Promise<{ deleted: true }> {
        await this.configCenter.remove(scope as 'client' | 'server', key);
        return { deleted: true };
    }

    @Get(':scope/:key/history')
    history(
        @Param('scope') scope: string,
        @Param('key') key: string,
        @Query('limit') limit?: string
    ): Promise<ConfigHistoryItem[]> {
        const parsed = Number(limit ?? 20);
        const safe = Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), 100) : 20;
        return this.configCenter.history(scope as 'client' | 'server', key, safe);
    }

    /** 回滚：把指定 revision 的值以一次新写入的方式恢复 */
    @Post(':scope/:key/rollback')
    rollback(
        @CurrentUser() user: AuthUser,
        @Param('scope') scope: string,
        @Param('key') key: string,
        @Body() dto: RollbackConfigDto
    ): Promise<ConfigEntry> {
        return this.configCenter.rollback(
            user.email,
            scope as 'client' | 'server',
            key,
            dto.revision
        );
    }
}
