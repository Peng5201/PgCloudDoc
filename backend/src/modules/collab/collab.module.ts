import { Module } from '@nestjs/common';
import { CollabServer } from './collab.server';
import { DocumentsModule } from '../documents/documents.module';
import { AuthModule } from '../auth/auth.module';

@Module({
    imports: [DocumentsModule, AuthModule],
    providers: [CollabServer],
    exports: [CollabServer],
})
export class CollabModule {}
