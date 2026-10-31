import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationGateway } from './notification.gateway';
import { NotificationService } from './notification.service';
import { NotificationsController } from './notification.controller';

@Module({
    imports: [PrismaModule, AuthModule],
    controllers: [NotificationsController],
    providers: [NotificationService, NotificationGateway],
    exports: [NotificationService],
})
export class NotificationsModule {}
