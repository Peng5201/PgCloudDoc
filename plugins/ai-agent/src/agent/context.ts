/**
 * 文档上下文构造。
 *
 * 原则：默认只给「结构 + 选区预览」，绝不整簿 dump。
 * 模型需要更多数据时用 read_range 工具按需读取，
 * 这样 token 成本和延迟都可控。
 */

import type { AiDocumentContext } from '@pgclouddoc/ai-protocol';
import type { CellSnapshot, SheetDocumentApi, SheetInfoSnapshot } from '@pgclouddoc/plugin-api';
import { toA1, toA1Cell } from './a1';

/** 预览的字符预算：超过就按行减半，避免把一轮请求撑爆 */
const MAX_PREVIEW_CHARS = 12_000;

export async function buildDocumentContext(
    doc: SheetDocumentApi,
    cellLimit: number
): Promise<AiDocumentContext> {
    const sheets = doc.getSheetInfo();
    const activeId = safeActiveSheetId(doc);
    const active = sheets.find((sheet) => sheet.id === activeId) ?? sheets[0];
    const selection = doc.getSelection();

    const ranges = selection.ranges.map((range) => ({
        address: toA1(range),
        rows: range.endRow - range.startRow + 1,
        columns: range.endColumn - range.startColumn + 1,
    }));

    let preview: (string | number | boolean | null)[][] | null = null;
    let previewAddress: string | null = null;
    let truncated = false;

    const first = selection.ranges[0];
    if (first && active) {
        const columns = first.endColumn - first.startColumn + 1;
        const maxRows = Math.max(1, Math.floor(cellLimit / Math.max(1, columns)));
        const clipped = {
            ...first,
            endRow: Math.min(first.endRow, first.startRow + maxRows - 1),
        };
        truncated =
            clipped.endRow < first.endRow || clipped.endColumn < first.endColumn;

        try {
            const cells = await doc.getRangeValuesInSheet(active.id, clipped);
            preview = cells.map((row) => row.map(previewCell));
            previewAddress = toA1(clipped);

            // 字符预算再兜一层：中文内容按行数减半
            let chars = JSON.stringify(preview).length;
            while (chars > MAX_PREVIEW_CHARS && preview.length > 1) {
                preview = preview.slice(0, Math.max(1, Math.floor(preview.length / 2)));
                truncated = true;
                chars = JSON.stringify(preview).length;
            }
        } catch {
            // 选区读取失败（越界 / 文档关闭）不应该阻断整轮对话
            preview = null;
            previewAddress = null;
        }
    }

    return {
        documentId: doc.id,
        title: doc.title,
        activeSheet: active
            ? { id: active.id, name: active.name }
            : { id: '', name: '' },
        sheets: sheets.map(toSheetContext),
        selection: {
            active: toA1Cell(selection.active.row, selection.active.column),
            ranges,
            preview,
            previewAddress,
            truncated,
        },
        capabilities: { canWrite: doc.canWrite },
    };
}

function toSheetContext(sheet: SheetInfoSnapshot) {
    return {
        id: sheet.id,
        name: sheet.name,
        hidden: sheet.hidden,
        rowCount: sheet.rowCount,
        columnCount: sheet.columnCount,
        usedRange: sheet.usedRange ? toA1(sheet.usedRange) : null,
    };
}

/** 预览用显示文本：日期/百分比/千分位对模型更友好 */
function previewCell(cell: CellSnapshot): string | number | boolean | null {
    if (cell.formula) return cell.formula;
    if (cell.value === null) return null;
    return cell.displayText || cell.value;
}

function safeActiveSheetId(doc: SheetDocumentApi): string {
    try {
        return doc.getActiveSheetId();
    } catch {
        return '';
    }
}
