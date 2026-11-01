/**
 * 工具注册表。
 *
 * 只读工具始终可用；写工具在只读文档里不发给模型，
 * 从源头上避免模型规划出无法执行的修改。
 */

import type { AiToolDefinition } from '@pgclouddoc/ai-protocol';
import type { ToolHandler } from '../agent/types';
import { computeStatsTool } from './analyze';
import { readTools } from './read';
import { writeTools } from './write';

const handlers = new Map<string, ToolHandler>();

for (const tool of [...readTools, computeStatsTool, ...writeTools]) {
    handlers.set(tool.definition.name, tool);
}

export function getTool(name: string): ToolHandler | undefined {
    return handlers.get(name);
}

export function toolDefinitions(canWrite: boolean): AiToolDefinition[] {
    return [...handlers.values()]
        .filter((tool) => tool.kind !== 'write' || canWrite)
        .map((tool) => tool.definition);
}

export function toolNames(): string[] {
    return [...handlers.keys()];
}
