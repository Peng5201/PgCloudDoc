import { Global, Module } from '@nestjs/common';
import { EtcdService } from './etcd.service';

/** 配置中心的基础设施。和 prisma/redis/kafka 一样全局注册 */
@Global()
@Module({
    providers: [EtcdService],
    exports: [EtcdService],
})
export class EtcdModule {}
