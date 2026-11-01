/**
 * 示例插件：CSV 工具。
 *
 * 演示四件事：
 *   1. 通过 commands.register 注册命令（manifest 里的按钮先渲染，点击时才激活）；
 *   2. 通过 documents.active() 读写当前文档；
 *   3. 通过 transact 把多次写入合成一个撤销单元；
 *   4. 通过 settings / ui.showMessage 使用宿主能力。
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
