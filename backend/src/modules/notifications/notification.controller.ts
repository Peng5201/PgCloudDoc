import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/decorators/auth.decorators';
import { NotificationService, type NotificationDto } from './notification.service';

@Controller('api/v1/notifications')
export class NotificationsController {
    constructor(private readonly notifications: NotificationService) {}

    @Get()
    list(@CurrentUser() user: AuthUser): Promise<NotificationDto[]> {
        return this.notifications.list(user.id);
    }

    @Get('unread-count')
    unreadCount(@CurrentUser() user: AuthUser): Promise<number> {
        return this.notifications.unreadCount(user.id);
    }

    @Post('read')
    @HttpCode(200)
    markRead(
        @CurrentUser() user: AuthUser,
        @Body() body: { ids: string[] }
    ): Promise<void> {
        return this.notifications.markRead(user.id, body?.ids ?? []);
    }

    @Post('read-all')
    @HttpCode(200)
    markAllRead(@CurrentUser() user: AuthUser): Promise<void> {
        return this.notifications.markAllRead(user.id);
    }
}
