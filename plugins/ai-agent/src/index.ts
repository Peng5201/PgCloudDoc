/**
 * AI 助手插件入口。
 *
 * 面板在 manifest 里声明；用户第一次打开时宿主加载本模块并调用 activate，
 * 这里注册真实面板内容与命令。
 */

import type { PluginContext } from '@pgclouddoc/plugin-api';
import { AgentController } from './controller';
import { mountPanel } from './ui/mount';

const PANEL_ID = 'aiAgent.panel';

export async function activate(ctx: PluginContext): Promise<void> {
    const controller = new AgentController(ctx);
    ctx.subscriptions.push(controller);

    // 开发时 Vite 从 public/ 提供图标；生产走 dist/ 目录
    const icon = import.meta.env.DEV ? 'icons/ai.svg' : 'dist/icons/ai.svg';

    ctx.subscriptions.push(
        ctx.ui.registerPanel({
            id: PANEL_ID,
            title: 'AI 助手',
            slot: 'editor.sidebar',
            icon,
            mount(container) {
                return mountPanel(container, controller);
            },
        })
    );

    ctx.subscriptions.push(
        ctx.commands.register('aiAgent.open', () => {
            ctx.ui.showPanel(PANEL_ID);
        })
    );

    ctx.subscriptions.push(
        ctx.commands.register('aiAgent.summarizeSelection', () => {
            ctx.ui.showPanel(PANEL_ID);
            void controller.startPrompt('总结当前选区的内容，列出关键信息和异常。');
        })
    );

    ctx.subscriptions.push(
        ctx.commands.register('aiAgent.explainFormula', () => {
            ctx.ui.showPanel(PANEL_ID);
            void controller.startPrompt(
                '解释当前活动单元格里的公式，说明它计算了什么。'
            );
        })
    );

    ctx.subscriptions.push(
        ctx.commands.register('aiAgent.cleanSelection', () => {
            ctx.ui.showPanel(PANEL_ID);
            void controller.startPrompt(
                '检查当前选区，找出空值、重复和格式不一致的数据，并给出清洗方案。'
            );
        })
    );
}

export function deactivate(): void {
    // 控制器已登记在 subscriptions 里，宿主统一 dispose
}
