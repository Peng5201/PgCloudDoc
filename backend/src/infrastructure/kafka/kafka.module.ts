import { Global, Module } from '@nestjs/common';
import { KafkaService } from './kafka.service';
import { ConsumerManagerService } from './consumer-manager.service';
import { OutboxService } from './outbox.service';
import { OutboxDispatcher } from './outbox.dispatcher';

@Global()
@Module({
    providers: [KafkaService, ConsumerManagerService, OutboxService, OutboxDispatcher],
    exports: [KafkaService, ConsumerManagerService, OutboxService],
})
export class KafkaModule {}
