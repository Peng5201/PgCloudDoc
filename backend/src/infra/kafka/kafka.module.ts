import { Global, Module } from '@nestjs/common';
import { KafkaService } from './kafka.service';
import { ConsumerManagerService } from './consumer-manager.service';

@Global()
@Module({
    providers: [KafkaService, ConsumerManagerService],
    exports: [KafkaService, ConsumerManagerService],
})
export class KafkaModule {}
