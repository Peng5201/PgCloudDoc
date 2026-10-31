import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { DocumentService } from './document.service';
import { DocumentRepository } from './document.repository';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
    imports: [NotificationsModule],
    controllers: [DocumentsController],
    providers: [DocumentService, DocumentRepository],
    exports: [DocumentService, DocumentRepository],
})
export class DocumentsModule {}
