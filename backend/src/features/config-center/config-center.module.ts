import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AdminConfigController } from './admin-config.controller';
import { ConfigCenterService } from './config-center.service';
import { PublicConfigController } from './public-config.controller';

@Module({
    imports: [UsersModule],
    controllers: [AdminConfigController, PublicConfigController],
    providers: [ConfigCenterService],
    exports: [ConfigCenterService],
})
export class ConfigCenterModule {}
