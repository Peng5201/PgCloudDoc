import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SnapshotWorker } from './snapshot.worker';
import { AuditConsumer } from './audit.consumer';
import { DeadLetterConsumer } from './dead-letter.consumer';
import { CleanupTask } from './cleanup.task';
import { DocumentsModule } from '../documents/documents.module';
import { CollabModule } from '../collab/collab.module';
import { AuthModule } from '../auth/auth.module';

@Module({
    imports: [ScheduleModule.forRoot(), DocumentsModule, CollabModule, AuthModule],
    providers: [SnapshotWorker, AuditConsumer, DeadLetterConsumer, CleanupTask],
})
export class JobsModule {}
