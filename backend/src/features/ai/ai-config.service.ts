/**
 * AI 配置与可用性判断。
 *
 * 密钥只在这里存在；对浏览器暴露的永远只有模型列表、限制和不可用原因。
 */

import { Injectable } from '@nestjs/common';
import type { AiConfigResponse, AiLimits, AiModelInfo } from '@pgclouddoc/ai-protocol';
import { AppConfigService } from '../../config/app-config.service';
import { AppError, ErrorCode } from '../../shared/errors/app-error';

const MODEL_LABELS: Record<string, string> = {
    'deepseek-v4-flash': 'DeepSeek V4 Flash',
};

@Injectable()
export class AiConfigService {
    constructor(private readonly config: AppConfigService) {}

    /** 真正可用的条件：开关打开 + 有对应凭据（mock 不需要） */
    get enabled(): boolean {
        const ai = this.config.ai;
        if (!ai.enabled) return false;
        if (ai.provider === 'mock') return true;
        return Boolean(ai.apiKey);
    }

    get unavailableReason(): string | undefined {
        const ai = this.config.ai;
        if (!ai.enabled) return 'AI 助手已被服务端关闭';
        if (ai.provider !== 'mock' && !ai.apiKey) return '服务端未配置 AI_API_KEY';
        return undefined;
    }

    get defaultModel(): string {
        return this.config.ai.model;
    }

    get models(): AiModelInfo[] {
        return this.config.ai.models.map((id) => ({
            id,
            label: MODEL_LABELS[id] ?? id,
        }));
    }

    get limits(): AiLimits {
        const ai = this.config.ai;
        return {
            maxOutputTokens: ai.maxOutputTokens,
            maxToolCallsPerTurn: ai.maxToolCallsPerTurn,
            maxContextChars: ai.contextMaxChars,
            dailyTokenLimit: ai.dailyTokenLimit,
            maxStepsPerConversation: ai.maxStepsPerConversation,
        };
    }

    toResponse(): AiConfigResponse {
        return {
            enabled: this.enabled,
            reason: this.unavailableReason,
            defaultModel: this.defaultModel,
            models: this.models,
            limits: this.limits,
        };
    }

    assertEnabled(): void {
        if (this.enabled) return;
        throw new AppError(
            ErrorCode.SERVICE_UNAVAILABLE,
            this.unavailableReason ?? 'AI 助手暂不可用'
        );
    }

    /** 请求模型必须在白名单里，防止客户端把任意模型名透传给供应商 */
    resolveModel(requested?: string): string {
        const model = requested?.trim() || this.defaultModel;
        if (!this.config.ai.models.includes(model)) {
            throw AppError.validation(`不支持的模型：${model}`);
        }
        return model;
    }
}
