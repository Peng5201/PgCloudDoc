/**
 * snapshot ↔ 工作簿对象 的装载/导出。
 *
 * 对照 Univer: packages/core/src/sheets/workbook.ts 的构造 +
 *              packages/core/src/services/snapshot/snapshot.service.ts
 *
 * 这里是唯一「知道服务端数据可能不完整」的地方：
 * 后端吐的是 Partial<IWorksheetData>，缺的字段在这里补默认值。
 * 补完之后数据层就不用到处 `?? DEFAULT` 了。
 */

import { ObjectMatrix } from './object-matrix';
import { Workbook } from './workbook';
import {
    DEFAULT_COLUMN_WIDTH,
    DEFAULT_HEADER_HEIGHT,
    DEFAULT_HEADER_WIDTH,
    DEFAULT_ROW_HEIGHT,
    Worksheet,
} from './worksheet';
import type { IStyleData, IWorkbookData } from './types';
import { normalizeRange } from './types';

export const APP_VERSION = '1.0.0';

/**
 * 装载工作簿。输入是后端的 JSON（可能是 Partial），
 * 输出是一个所有字段都已补全的 Workbook。
 */
export function loadWorkbook(data: Partial<IWorkbookData>): Workbook {
    const sheetOrder =
        data.sheetOrder && data.sheetOrder.length > 0
            ? [...data.sheetOrder]
            : Object.keys(data.sheets ?? {});

    if (sheetOrder.length === 0) {
        throw new Error('snapshot has no worksheet');
    }

    // 样式表：null 条目直接丢掉，避免后面到处判空
    const styles: Record<string, IStyleData> = {};
    for (const [id, style] of Object.entries(data.styles ?? {})) {
        if (style) styles[id] = style;
    }

    const sheets = sheetOrder
        .map((id) => {
            const raw = data.sheets?.[id];
            if (!raw) return null;
            return new Worksheet({
                id: raw.id ?? id,
                name: raw.name ?? id,
                tabColor: raw.tabColor ?? '',
                hidden: raw.hidden ? 1 : 0,
                freeze: raw.freeze
                    ? { ...raw.freeze }
                    : { xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 },
                rowCount: raw.rowCount ?? 100,
                columnCount: raw.columnCount ?? 26,
                zoomRatio: raw.zoomRatio ?? 1,
                scrollTop: raw.scrollTop ?? 0,
                scrollLeft: raw.scrollLeft ?? 0,
                defaultRowHeight: raw.defaultRowHeight ?? DEFAULT_ROW_HEIGHT,
                defaultColumnWidth: raw.defaultColumnWidth ?? DEFAULT_COLUMN_WIDTH,
                showGridlines: raw.showGridlines === 0 ? 0 : 1,
                gridlinesColor: raw.gridlinesColor ?? null,
                rowHeaderWidth: raw.rowHeader?.width ?? DEFAULT_HEADER_WIDTH,
                columnHeaderHeight: raw.columnHeader?.height ?? DEFAULT_HEADER_HEIGHT,
                mergeData: (raw.mergeData ?? []).map(normalizeRange),
                cellData: raw.cellData ?? {},
                rowData: raw.rowData ?? {},
                columnData: raw.columnData ?? {},
            });
        })
        .filter((s): s is Worksheet => s !== null);

    if (sheets.length === 0) {
        throw new Error('snapshot has no valid worksheet');
    }

    return new Workbook({
        id: data.id ?? 'workbook',
        name: data.name ?? '工作簿',
        appVersion: data.appVersion ?? APP_VERSION,
        locale: data.locale ?? '',
        styles,
        sheetOrder: sheets.map((s) => s.id),
        sheets,
        resources: data.resources ?? [],
    });
}

/**
 * 导出成服务端约定的格式。
 *
 * 与 loadWorkbook 往返后应当**逐字段一致** —— 这是数据契约的验收标准，
 * 也是「不动后端」的前提。
 */
export function saveWorkbook(workbook: Workbook): IWorkbookData {
    return workbook.toJSON() as unknown as IWorkbookData;
}

/** 造一张空表（「新增 sheet」用） */
export function createEmptyWorksheet(init: {
    id: string;
    name: string;
    rowCount?: number;
    columnCount?: number;
    defaultRowHeight?: number;
    defaultColumnWidth?: number;
}): Worksheet {
    return new Worksheet({
        id: init.id,
        name: init.name,
        rowCount: init.rowCount ?? 200,
        columnCount: init.columnCount ?? 26,
        defaultRowHeight: init.defaultRowHeight ?? DEFAULT_ROW_HEIGHT,
        defaultColumnWidth: init.defaultColumnWidth ?? DEFAULT_COLUMN_WIDTH,
        cellData: {},
    });
}

/** 造一份最小可用的空工作簿（加载失败时的兜底） */
export function createEmptyWorkbook(name = '工作簿'): Workbook {
    const sheet = createEmptyWorksheet({ id: 'sheet1', name: 'Sheet1' });
    return new Workbook({
        id: 'workbook',
        name,
        appVersion: APP_VERSION,
        styles: {},
        sheetOrder: [sheet.id],
        sheets: [sheet],
    });
}

export { ObjectMatrix };
