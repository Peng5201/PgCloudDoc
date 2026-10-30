import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './common/decorators/auth.decorators';

/**
 * 旧接口，保留给前端现有代码用（frontend/src/App.tsx 里 fetch('/api/testSheet')）。
 * 下一轮把前端切到 /api/v1/documents/:id/snapshot 后可以删掉。
 */
@Controller('api')
export class AppController {
    constructor(private readonly appService: AppService) {}

    @Public()
    @Get()
    getHello(): string {
        return this.appService.getHello();
    }

    @Public()
    @Get('testSheet')
    getTestSheet(): unknown {
        return this.appService.getTestSheet();
    }
}
