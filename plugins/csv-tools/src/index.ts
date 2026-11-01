/**
 * 示例插件：CSV 工具。
 *
 * 演示五件事：
 *   1. 通过 commands.register 注册命令（manifest 里的按钮先渲染，点击时才激活）；
 *   2. 通过 documents.active() 读写当前文档；
 *   3. 通过 transact 把多次写入合成一个撤销单元；
 *   4. 通过 settings / ui.showMessage 使用宿主能力；
 *   5. 通过 ui.registerPanel 往宿主右侧面板挂内容（容器挂载，零运行时依赖）。
 */

import type { CellSnapshot, PluginContext } from '@pgclouddoc/plugin-api';

export async function activate(ctx: PluginContext): Promise<void> {
  const { commands, documents, settings, ui, subscriptions, logger } = ctx;

  subscriptions.push(
    commands.register('csvTools.exportSelection', async () => {
      const doc = documents.active();
      if (!doc) {
        ui.showMessage('warning', '请先打开一个文档');
        return;
      }

      const selection = doc.getSelection();
      const range = selection.ranges[0];
      if (!range) {
        ui.showMessage('warning', '请先选择要导出的区域');
        return;
      }

      const rows = await doc.getRangeValues(range);
      if (rows.length === 0) {
        ui.showMessage('warning', '选区内没有可导出的内容');
        return;
      }

      const delimiter = settings.get<string>('delimiter') ?? ',';
      const csv = rows
        .map((row) => row.map((cell) => escapeCsv(cell, delimiter)).join(delimiter))
        .join('\r\n');

      download(
        new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }),
        `${doc.title || 'selection'}.csv`
      );
      logger.info('导出 CSV', { rows: rows.length, delimiter });
      ui.showMessage('success', `已导出 ${rows.length} 行`);
    })
  );

  subscriptions.push(
    commands.register('csvTools.fillDemo', async () => {
      const doc = documents.active();
      if (!doc) {
        ui.showMessage('warning', '请先打开一个文档');
        return;
      }
      if (!doc.canWrite) {
        ui.showMessage('warning', '当前文档只读，无法写入');
        return;
      }

      await doc.transact('填充示例数据', (tx) => {
        tx.setRangeValues(
          { startRow: 0, startColumn: 0, endRow: 2, endColumn: 2 },
          [
            ['名称', '数量', '金额'],
            ['示例 A', 10, 99.5],
            ['示例 B', 20, 168],
          ]
        );
      });
      ui.showMessage('success', '已写入 A1:C3，可按 Ctrl+Z 整体撤销');
    })
  );

  // 侧面板：manifest 里声明了 panels，用户点开时才触发本插件激活，
  // 激活后在这里把内容补上（宿主用同一个 id 替换掉占位视图）
  subscriptions.push(
    ui.registerPanel({
      id: 'csvTools.panel',
      title: 'CSV 工具',
      slot: 'editor.sidebar',
      mount(container) {
        const root = document.createElement('div');
        root.style.cssText =
          'display:flex;flex-direction:column;gap:8px;padding:12px;font-size:13px;';

        const hint = document.createElement('p');
        hint.textContent = '选中一块区域后导出为 CSV；也可以往空白表格里填一份示例数据。';
        hint.style.cssText = 'margin:0;color:#5f6368;line-height:1.6;';

        const exportButton = createPanelButton('导出选区为 CSV', () => {
          void commands.execute('csvTools.exportSelection').catch((err: unknown) => {
            ui.showMessage('error', err instanceof Error ? err.message : String(err));
          });
        });
        const demoButton = createPanelButton('填充示例数据', () => {
          void commands.execute('csvTools.fillDemo').catch((err: unknown) => {
            ui.showMessage('error', err instanceof Error ? err.message : String(err));
          });
        });

        root.append(hint, exportButton, demoButton);
        container.appendChild(root);

        return () => root.remove();
      },
    })
  );
}

/** 插件没有共享 React 运行时，面板内容用原生 DOM 写；样式内联，避免依赖宿主主题变量 */
function createPanelButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.style.cssText =
    'height:28px;padding:0 12px;border:1px solid #d9d9d9;border-radius:6px;background:#fff;color:#1f2329;cursor:pointer;font-size:13px;';
  button.addEventListener('click', onClick);
  return button;
}

function escapeCsv(cell: CellSnapshot, delimiter: string): string {
  const value = cell.displayText;
  return value.includes(delimiter) || /["\r\n]/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
