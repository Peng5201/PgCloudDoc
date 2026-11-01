/**
 * 管理端插件接口。全部要求 ADMIN 角色。
 *
 * 上传接口接收 zip，服务端校验 manifest、检查 zip 安全、原子发布产物；
 * 版本发布后不可覆盖，新版本通过重新上传产生。
 */

import {
    Body,
    Controller,
    Get,
    Param,
    Post,
    Put,
    UploadedFile,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AdminGuard } from '../users/admin.guard';
import { CurrentUser, type AuthUser } from '../../shared/decorators/auth.decorators';
import { AppError } from '../../shared/errors/app-error';
import { PluginService, type AdminPluginItem } from './plugin.service';
import { SetPluginInstallationDto } from './dto/plugin.dto';

/** 与部署侧 nginx `client_max_body_size 60m` 对齐 */
const MAX_PLUGIN_ZIP_BYTES = 50 * 1024 * 1024;

@Controller('api/v1/admin/plugins')
@UseGuards(AdminGuard)
export class AdminPluginsController {
    constructor(private readonly plugins: PluginService) {}

    @Get()
    list(): Promise<AdminPluginItem[]> {
        return this.plugins.list();
    }

    @Post('upload')
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PLUGIN_ZIP_BYTES } }))
    upload(
        @CurrentUser() user: AuthUser,
        @UploadedFile() file: Express.Multer.File | undefined
    ): Promise<AdminPluginItem> {
        if (!file?.buffer?.length) {
            throw AppError.badRequest('请选择插件 zip 文件');
        }
        if (!file.originalname.toLowerCase().endsWith('.zip')) {
            throw AppError.badRequest('只支持 .zip 格式');
        }
        return this.plugins.upload(user, file.buffer);
    }

    /** 启用/禁用，或切换到指定已发布版本 */
    @Put(':pluginKey/installation')
    setInstallation(
        @CurrentUser() user: AuthUser,
        @Param('pluginKey') pluginKey: string,
        @Body() dto: SetPluginInstallationDto
    ): Promise<AdminPluginItem> {
        return this.plugins.setInstallation(user, pluginKey, dto);
    }
}
