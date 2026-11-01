import { Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { DocumentsModule } from '../documents/documents.module';
import { AiConfigService } from './ai-config.service';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiConversationRepository } from './conversation.repository';
import { createAiProvider, AI_PROVIDER_TOKEN } from './provider/provider.factory';
import { AiQuotaService } from './quota.service';

@Module({
    imports: [DocumentsModule],
    controllers: [AiController],
    providers: [
        AiService,
        AiConfigService,
        AiConversationRepository,
        AiQuotaService,
        {
            provide: AI_PROVIDER_TOKEN,
            inject: [AppConfigService],
            useFactory: (config: AppConfigService) => createAiProvider(config),
        },
    ],
    exports: [AiService],
})
export class AiModule {}
