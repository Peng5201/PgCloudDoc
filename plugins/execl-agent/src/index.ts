/**
 * 表格内容输出插件。
 *
 * 点击工具栏「输出表格」：
 *   1. 取当前打开的文档；
 *   2. 调 getSnapshot() 拿整份工作簿的只读快照；
 *   3. console.log 输出，打开 DevTools（F12）即可查看。
 *
 * 只有 document:read 权限，不写文档。
 */

import type { PluginContext } from '@pgclouddoc/plugin-api';

export async function activate(ctx: PluginContext): Promise<void> {
  ctx.subscriptions.push(
    ctx.commands.register('excelAgent.dumpToConsole', async () => {
      const doc = ctx.documents.active();
      if (!doc) {
        ctx.ui.showMessage('warning', '请先打开一个文档');
        return;
      }

      const snapshot = await doc.getSnapshot();
      console.log(`[excel-agent] 文档「${doc.title}」内容：`, snapshot);
      ctx.ui.showMessage('success', '表格内容已输出到控制台（F12 查看）');
    })
  );
}
