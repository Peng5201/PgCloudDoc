/**
 * Provider 工厂。
 *
 * 供应商选择完全由环境变量决定；密钥只可能在服务端。
 * 新增供应商只需要在这里加分支 + 一个适配器文件。
 */

import type { AppConfigService } from '../../../config/app-config.service';
import { AnthropicProvider } from './anthropic.provider';
import { MockProvider } from './mock.provider';
import type { AiProvider } from './types';

export const AI_PROVIDER_TOKEN = 'AI_PROVIDER';

export function createAiProvider(config: AppConfigService): AiProvider {
    const ai = config.ai;

    if (ai.provider === 'mock') return new MockProvider();

    // DeepSeek 的 Anthropic 兼容端点就是这一条：
    //   AI_BASE_URL=https://api.deepseek.com/anthropic
    //   AI_MODEL=deepseek-v4-flash
    return new AnthropicProvider({
        baseUrl: ai.baseUrl,
        apiKey: ai.apiKey,
        timeoutMs: ai.requestTimeoutMs,
    });
}
