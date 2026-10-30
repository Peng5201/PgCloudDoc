import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { pgPoolProvider } from './pg.pool';

@Global()
@Module({
    providers: [pgPoolProvider, PrismaService],
    exports: [PrismaService],
})
export class PrismaModule {}
