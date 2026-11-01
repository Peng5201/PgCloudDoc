/**
 * 管理员引导。
 *
 * 首次部署时库里没有任何管理员，而「第一个注册的人自动当管理员」是个
 * 接管风险。所以用显式的 ADMIN_EMAILS 环境变量：
 *
 *   ADMIN_EMAILS=ops@example.com,lead@example.com
 *
 * 启动时把这些已存在的账号提升为 ADMIN。只升不降 —— 后续在后台加的
 * 管理员不会被下一次重启抹掉。
 */

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { UserRepository } from './user.repository';

@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
    private readonly logger = new Logger(AdminBootstrapService.name);

    constructor(
        private readonly users: UserRepository,
        private readonly config: AppConfigService
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        const emails = this.config.admin.bootstrapEmails;
        if (emails.length === 0) return;

        try {
            const promoted = await this.users.promoteToAdminByEmails(emails);
            if (promoted > 0) {
                this.logger.log(`已按 ADMIN_EMAILS 将 ${promoted} 个账号提升为管理员`);
            }
        } catch (err) {
            // 引导失败不影响启动：数据库抖动不该阻止整个服务起来
            this.logger.warn(`管理员引导失败：${String(err)}`);
        }
    }
}
