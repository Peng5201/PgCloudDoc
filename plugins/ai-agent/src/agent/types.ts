/**
 * 插件侧的 Agent 内部类型。
 *
 * 只依赖 plugin-api 与 ai-protocol；不 import 宿主内部模块。
 */

import type { AiToolDefinition } from '@pgclouddoc/ai-protocol';
import type { PluginContext, SheetDocumentApi } from '@pgclouddoc/plugin-api';

export class ToolError extends Error {
    constructor(
        readonly code: string,
        message: string
    ) {
        super(message);
        this.name = 'ToolError';
    }
}

export interface ToolContext {
    doc: SheetDocumentApi;
    ctx: PluginContext;
    signal: AbortSignal;
}

export interface DiffCell {
    address: string;
    before: string;
    after: string;
}

/**
 * 写工具的两阶段计划：
 *   prepare 时读取基线、算 diff；用户确认后执行 apply。
 *   apply 内部会再校验一次基线，防止确认期间文档被其他人改动。
 */
export interface WritePlan {
    toolName: string;
    title: string;
    summary: string;
    diff: DiffCell[];
    totalChanges: number;
    apply(): Promise<unknown>;
}

export interface ToolHandler {
    definition: AiToolDefinition;
    kind: 'read' | 'write' | 'navigate';
    /** 读 / 导航工具 */
    run?(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
    /** 写工具 */
    prepare?(args: Record<string, unknown>, context: ToolContext): Promise<WritePlan>;
}
