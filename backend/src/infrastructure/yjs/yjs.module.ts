import { Global, Module } from '@nestjs/common';
import { YDocStore } from './ydoc-store';

@Global()
@Module({
    providers: [YDocStore],
    exports: [YDocStore],
})
export class YjsModule {}
