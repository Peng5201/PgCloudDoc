import { Module } from '@nestjs/common';
import { ConfigCenterModule } from '../config-center/config-center.module';
import { UsersModule } from '../users/users.module';
import { AdminPluginsController } from './admin-plugins.controller';
import { PluginsController } from './plugins.controller';
import { PluginService } from './plugin.service';
import { PluginStorageService } from './plugin-storage.service';
import { PluginZipService } from './plugin-zip.service';

@Module({
    imports: [UsersModule, ConfigCenterModule],
    controllers: [PluginsController, AdminPluginsController],
    providers: [PluginService, PluginStorageService, PluginZipService],
    exports: [PluginStorageService],
})
export class PluginsModule {}
