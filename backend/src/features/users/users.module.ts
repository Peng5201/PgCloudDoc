import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { UserRepository } from './user.repository';
import { AdminGuard } from './admin.guard';
import { AdminBootstrapService } from './admin-bootstrap.service';

@Module({
    controllers: [UsersController],
    providers: [UsersService, UserRepository, AdminGuard, AdminBootstrapService],
    exports: [UsersService, UserRepository, AdminGuard],
})
export class UsersModule {}
