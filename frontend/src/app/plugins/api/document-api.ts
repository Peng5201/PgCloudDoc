/**
 * 文档 API 的宿主实现。
 *
 * 关键点：插件的写入**不直接改矩阵**，而是构造 IEdit 走 engine.execute。
 * 这样一次写入天然获得：
 *   - 撤销/重做（History）
 *   - 协同广播（DocSync 的 change hooks → Y.Doc）
 *   - 只读/角色拦截（assertWrite + engine.readOnly）
 */

import type {
  CellInput,
  CellSnapshot,
  DocumentChangeEvent,
  DocumentChangeKind,
  DocumentHub,
  DocumentTransaction,
  PluginPermission,
  RangeSnapshot,
  SelectionSnapshot,
  SelectionChangeEvent,
  SheetDocumentApi,
  SheetInfoSnapshot,
  SheetSummarySnapshot,
  StylePatch,
  WorkbookSnapshot,
} from '@pgclouddoc/plugin-api';
import { PluginApiError } from '@pgclouddoc/plugin-api/errors';
import type { ICellData, IEdit, IRange, IStylePatch, Worksheet } from '../../spreadsheet/engine';
import {
  CellValueType,
  createClearRangeEdit,
  createSetRangeStylesEdit,
  inferCellData,
} from '../../spreadsheet/engine';
import { captureRange, restoreRange } from '../../spreadsheet/engine/command/set-range-values';
import type { DocumentSession, DocumentSessionRegistry } from '../host/document-session';

const MAX_CELLS = 20_000;
const EDIT_PREFIX = '插件：';
const STYLE_KEYS = new Set(['bl', 'it', 'ul', 'st', 'fs', 'cl', 'bg', 'ht', 'vt', 'tb']);

export interface SheetDocumentHandle {
  api: SheetDocumentApi;
  dispose(): void;
}

export interface DocumentHubHandle {
  hub: DocumentHub;
  dispose(): void;
}

type ErrorReporter = (pluginId: string, error: unknown, context: string) => void;

export function createDocumentHub(
  registry: DocumentSessionRegistry,
  pluginId: string,
  permissions: ReadonlySet<PluginPermission>,
  reportError: ErrorReporter
): DocumentHubHandle {
  const handles = new Map<DocumentSession, SheetDocumentHandle>();
  const openListeners = new Set<(doc: SheetDocumentApi) => void>();
  const closeListeners = new Set<(documentId: string) => void>();
  let disposed = false;

  const getHandle = (session: DocumentSession): SheetDocumentHandle => {
    let handle = handles.get(session);
    if (!handle) {
      handle = createSheetDocumentApi(session, pluginId, permissions, reportError);
      handles.set(session, handle);
    }
    return handle;
  };

  const offOpen = registry.onDidOpen((session) => {
    if (disposed) return;
    const api = getHandle(session).api;
    for (const listener of [...openListeners]) {
      try {
        listener(api);
      } catch (err) {
        reportError(pluginId, err, 'documents.onDidOpen');
      }
    }
  });

  const offClose = registry.onDidClose((documentId) => {
    for (const [session, handle] of [...handles]) {
      if (session.id === documentId) {
        handle.dispose();
        handles.delete(session);
      }
    }
    for (const listener of [...closeListeners]) {
      try {
        listener(documentId);
      } catch (err) {
        reportError(pluginId, err, 'documents.onDidClose');
      }
    }
  });

  const hub: DocumentHub = {
    active() {
      if (disposed) return null;
      const session = registry.active();
      return session ? getHandle(session).api : null;
    },
    onDidOpen(cb) {
      openListeners.add(cb);
      return {
        dispose: () => {
          openListeners.delete(cb);
        },
      };
    },
    onDidClose(cb) {
      closeListeners.add(cb);
      return {
        dispose: () => {
          closeListeners.delete(cb);
        },
      };
    },
  };

  return {
    hub,
    dispose() {
      disposed = true;
      offOpen();
      offClose();
      for (const handle of handles.values()) handle.dispose();
      handles.clear();
      openListeners.clear();
      closeListeners.clear();
    },
  };
}

function createSheetDocumentApi(
  session: DocumentSession,
  pluginId: string,
  permissions: ReadonlySet<PluginPermission>,
  reportError: ErrorReporter
): SheetDocumentHandle {
  const contentListeners = new Set<(event: DocumentChangeEvent) => void>();
  const selectionListeners = new Set<(event: SelectionChangeEvent) => void>();
  let applyingPluginEdit = false;
  let disposed = false;
  let scheduled = false;
  const pending = new Map<DocumentChangeKind, 'local' | 'plugin'>();

  const engine = session.engine;

  const flush = () => {
    scheduled = false;
    if (disposed) {
      pending.clear();
      return;
    }
    const entries = [...pending.entries()];
    pending.clear();

    for (const [kind, origin] of entries) {
      const event: DocumentChangeEvent = { kind, origin };
      for (const listener of [...contentListeners]) {
        try {
          listener(event);
        } catch (err) {
          reportError(pluginId, err, 'documents.onDidChange');
        }
      }
      if (kind === 'selection') {
        const payload: SelectionChangeEvent = { selection: readSelection() };
        for (const listener of [...selectionListeners]) {
          try {
            listener(payload);
          } catch (err) {
            reportError(pluginId, err, 'documents.onDidChangeSelection');
          }
        }
      }
    }
  };

  const schedule = (kind: DocumentChangeKind, origin: 'local' | 'plugin') => {
    if (disposed) return;
    if (!pending.has(kind)) pending.set(kind, origin);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  };

  const offContent = engine.on('content-change', () =>
    schedule('content', applyingPluginEdit ? 'plugin' : 'local')
  );
  const offSelection = engine.on('selection-change', () => schedule('selection', 'local'));
  const offSheet = engine.on('sheet-change', () => schedule('sheet', 'local'));

  // ─────────────────────────── 校验 ───────────────────────────

  const assertAlive = () => {
    if (disposed || session.isDisposed) {
      throw new PluginApiError('E_PLUGIN_DISPOSED', '文档已关闭');
    }
  };

  const requirePermission = (permission: PluginPermission) => {
    if (!permissions.has(permission)) {
      throw new PluginApiError(
        'E_PLUGIN_PERMISSION',
        `插件 ${pluginId} 未声明 ${permission} 权限`
      );
    }
  };

  const assertRead = () => {
    assertAlive();
    requirePermission('document:read');
  };

  const assertWrite = () => {
    assertAlive();
    requirePermission('document:write');
    if (!session.canWrite()) {
      throw new PluginApiError('E_PLUGIN_READ_ONLY', '当前文档只读，无法写入');
    }
  };

  const activeWorksheet = (): Worksheet => {
    const worksheet = engine.workbook.getActiveSheet();
    if (!worksheet) throw new PluginApiError('E_PLUGIN_NO_DOCUMENT', '当前没有活动工作表');
    return worksheet;
  };

  /** 按 id 取表：读/写非活动表时用，不改变用户的视图和选区 */
  const worksheetById = (sheetId: string): Worksheet => {
    if (typeof sheetId !== 'string' || sheetId.length === 0) {
      throw new PluginApiError('E_PLUGIN_INVALID_INPUT', 'sheetId 必须是非空字符串');
    }
    const worksheet = engine.workbook.getSheet(sheetId);
    if (!worksheet) {
      throw new PluginApiError('E_PLUGIN_INVALID_RANGE', `工作表不存在：${sheetId}`);
    }
    return worksheet;
  };

  const normalizeRange = (range: RangeSnapshot, worksheet: Worksheet): IRange => {
    const values = [range.startRow, range.startColumn, range.endRow, range.endColumn];
    if (values.some((value) => !Number.isInteger(value) || value < 0)) {
      throw new PluginApiError('E_PLUGIN_INVALID_RANGE', '选区必须是大于等于 0 的整数');
    }
    const normalized: IRange = {
      startRow: Math.min(range.startRow, range.endRow),
      startColumn: Math.min(range.startColumn, range.endColumn),
      endRow: Math.max(range.startRow, range.endRow),
      endColumn: Math.max(range.startColumn, range.endColumn),
    };
    const clamped = worksheet.clampRange(normalized);
    if (!clamped) {
      throw new PluginApiError('E_PLUGIN_INVALID_RANGE', '选区超出工作表范围');
    }
    return clamped;
  };

  const cellCount = (range: IRange): number =>
    (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1);

  const assertCellBudget = (range: IRange) => {
    if (cellCount(range) > MAX_CELLS) {
      throw new PluginApiError(
        'E_PLUGIN_RANGE_TOO_LARGE',
        `单次最多处理 ${MAX_CELLS} 个单元格`
      );
    }
  };

  const readSelection = (): SelectionSnapshot => {
    const selection = engine.getSelection();
    return {
      active: { ...selection.active },
      ranges: selection.ranges.map((range) => ({ ...range })),
    };
  };

  /** 读取任意工作表指定区域；调用方负责权限断言 */
  const readRange = (worksheet: Worksheet, range: RangeSnapshot): CellSnapshot[][] => {
    const normalized = normalizeRange(range, worksheet);
    assertCellBudget(normalized);

    const styles = engine.workbook.styles;
    const rows: CellSnapshot[][] = [];
    for (let row = normalized.startRow; row <= normalized.endRow; row++) {
      const out: CellSnapshot[] = [];
      for (
        let column = normalized.startColumn;
        column <= normalized.endColumn;
        column++
      ) {
        const cell = worksheet.getCell(row, column);
        const style = worksheet.resolveCell(row, column, styles);
        out.push({
          value: cell?.v ?? null,
          formula: cell?.f ?? null,
          displayText: worksheet.cellText(cell, style),
        });
      }
      rows.push(out);
    }
    return rows;
  };

  /**
   * 有效区域：有值或有样式的格子。cellData 是稀疏矩阵，
   * 遍历非空条目即可，不需要扫 rowCount × columnCount。
   */
  const usedRangeOf = (worksheet: Worksheet): RangeSnapshot | null => {
    let startRow = Number.POSITIVE_INFINITY;
    let startColumn = Number.POSITIVE_INFINITY;
    let endRow = -1;
    let endColumn = -1;

    worksheet.cellData.forEach((row, column) => {
      if (row < startRow) startRow = row;
      if (row > endRow) endRow = row;
      if (column < startColumn) startColumn = column;
      if (column > endColumn) endColumn = column;
    });

    if (endRow < 0 || endColumn < 0) return null;
    return { startRow, startColumn, endRow, endColumn };
  };

  const executeEdits = (edits: IEdit[], label: string) => {
    if (edits.length === 0) return;
    assertWrite();

    const edit: IEdit =
      edits.length === 1
        ? edits[0]
        : {
            label: `${EDIT_PREFIX}${label}`,
            redo: () => {
              for (const item of edits) item.redo();
            },
            undo: () => {
              for (let index = edits.length - 1; index >= 0; index--) edits[index].undo();
            },
          };

    applyingPluginEdit = true;
    try {
      engine.execute(edit);
    } finally {
      applyingPluginEdit = false;
    }
  };

  const buildValuesEdit = (
    worksheet: Worksheet,
    range: IRange,
    values: CellInput[][],
    label: string
  ): IEdit => {
    const before = captureRange(worksheet, range);
    return {
      label,
      redo() {
        for (let row = range.startRow, r = 0; row <= range.endRow; row++, r++) {
          for (let column = range.startColumn, c = 0; column <= range.endColumn; column++, c++) {
            const input = values[r]?.[c] ?? null;
            if (input === null) worksheet.cellData.realDeleteValue(row, column);
            else worksheet.cellData.setValue(row, column, toCellData(input));
          }
        }
      },
      undo: () => restoreRange(worksheet, before),
    };
  };

  const assertValuesShape = (range: IRange, values: CellInput[][]) => {
    const rows = range.endRow - range.startRow + 1;
    const columns = range.endColumn - range.startColumn + 1;

    if (!Array.isArray(values) || values.length !== rows) {
      throw new PluginApiError(
        'E_PLUGIN_INVALID_INPUT',
        `values 需要 ${rows} 行，实际 ${Array.isArray(values) ? values.length : '非数组'}`
      );
    }
    for (const [index, row] of values.entries()) {
      if (!Array.isArray(row) || row.length !== columns) {
        throw new PluginApiError('E_PLUGIN_INVALID_INPUT', `第 ${index} 行需要 ${columns} 列`);
      }
      for (const value of row) {
        const valid =
          value === null ||
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean';
        if (!valid) {
          throw new PluginApiError(
            'E_PLUGIN_INVALID_INPUT',
            '单元格值只能是 string / number / boolean / null'
          );
        }
      }
    }
  };

  /**
   * 事务执行器。活动表与指定表共用同一套逻辑，
   * 只把「解析工作表」作为参数传进来。
   */
  const runTransaction = async <T>(
    label: string,
    resolveWorksheet: () => Worksheet,
    fn: (tx: DocumentTransaction) => Promise<T> | T
  ): Promise<T> => {
    assertWrite();
    const operations: Array<() => IEdit> = [];

    const tx: DocumentTransaction = {
      setRangeValues(range, values) {
        const worksheet = resolveWorksheet();
        const normalized = normalizeRange(range, worksheet);
        assertCellBudget(normalized);
        assertValuesShape(normalized, values);
        operations.push(() =>
          buildValuesEdit(worksheet, normalized, values, `${EDIT_PREFIX}${label}`)
        );
      },
      clearRange(range) {
        const worksheet = resolveWorksheet();
        const normalized = normalizeRange(range, worksheet);
        assertCellBudget(normalized);
        operations.push(() =>
          createClearRangeEdit(worksheet, normalized, `${EDIT_PREFIX}${label}`)
        );
      },
      setRangeStyle(range, patch) {
        const worksheet = resolveWorksheet();
        const normalized = normalizeRange(range, worksheet);
        assertCellBudget(normalized);
        const stylePatch = toStylePatch(patch);
        operations.push(() =>
          createSetRangeStylesEdit(
            engine.workbook,
            worksheet,
            normalized,
            stylePatch,
            `${EDIT_PREFIX}${label}`
          )
        );
      },
    };

    const result = await fn(tx);
    executeEdits(
      operations.map((buildEdit) => buildEdit()),
      label
    );
    return result;
  };

  const api: SheetDocumentApi = {
    id: session.id,
    get title() {
      return session.title;
    },
    type: 'sheet',
    get readOnly() {
      return !permissions.has('document:write') || !session.canWrite();
    },
    get canWrite() {
      return permissions.has('document:write') && session.canWrite() && !disposed;
    },

    getSelection() {
      assertRead();
      return readSelection();
    },

    async setSelection(selection) {
      assertRead();
      const ranges = selection.ranges.map((range) => ({
        startRow: Math.min(range.startRow, range.endRow),
        startColumn: Math.min(range.startColumn, range.endColumn),
        endRow: Math.max(range.startRow, range.endRow),
        endColumn: Math.max(range.startColumn, range.endColumn),
      }));
      const active = selection.active ?? { row: 0, column: 0 };
      engine.setSelection({
        active: { row: active.row, column: active.column },
        ranges:
          ranges.length > 0
            ? ranges
            : [
                {
                  startRow: active.row,
                  startColumn: active.column,
                  endRow: active.row,
                  endColumn: active.column,
                },
              ],
      });
    },

    getSheets(): SheetSummarySnapshot[] {
      assertRead();
      return engine.getSheets().map((sheet) => ({
        id: sheet.id,
        name: sheet.name,
        hidden: sheet.hidden,
      }));
    },

    getSheetInfo(): SheetInfoSnapshot[] {
      assertRead();
      return engine.getSheets().map((summary) => {
        const worksheet = engine.workbook.getSheet(summary.id);
        return {
          id: summary.id,
          name: summary.name,
          hidden: summary.hidden,
          rowCount: worksheet?.rowCount ?? 0,
          columnCount: worksheet?.columnCount ?? 0,
          usedRange: worksheet ? usedRangeOf(worksheet) : null,
        };
      });
    },

    getActiveSheetId() {
      assertRead();
      return activeWorksheet().id;
    },

    async setActiveSheet(sheetId) {
      assertRead();
      engine.setActiveSheet(sheetId);
    },

    async getRangeValues(range) {
      assertRead();
      return readRange(activeWorksheet(), range);
    },

    async getRangeValuesInSheet(sheetId, range) {
      assertRead();
      return readRange(worksheetById(sheetId), range);
    },

    async getSnapshot(): Promise<WorkbookSnapshot> {
      assertRead();
      return engine.toJSON() as unknown as WorkbookSnapshot;
    },

    async setRangeValues(range, values) {
      assertWrite();
      const worksheet = activeWorksheet();
      const normalized = normalizeRange(range, worksheet);
      assertCellBudget(normalized);
      assertValuesShape(normalized, values);

      executeEdits(
        [buildValuesEdit(worksheet, normalized, values, `${EDIT_PREFIX}写入选区`)],
        '写入选区'
      );
    },

    async clearRange(range) {
      assertWrite();
      const worksheet = activeWorksheet();
      const normalized = normalizeRange(range, worksheet);
      assertCellBudget(normalized);
      executeEdits(
        [createClearRangeEdit(worksheet, normalized, `${EDIT_PREFIX}清除选区`)],
        '清除选区'
      );
    },

    async setRangeStyle(range, patch) {
      assertWrite();
      const worksheet = activeWorksheet();
      const normalized = normalizeRange(range, worksheet);
      assertCellBudget(normalized);
      executeEdits(
        [
          createSetRangeStylesEdit(
            engine.workbook,
            worksheet,
            normalized,
            toStylePatch(patch),
            `${EDIT_PREFIX}设置样式`
          ),
        ],
        '设置样式'
      );
    },

    onDidChange(cb) {
      contentListeners.add(cb);
      return {
        dispose: () => {
          contentListeners.delete(cb);
        },
      };
    },

    onDidChangeSelection(cb) {
      selectionListeners.add(cb);
      return {
        dispose: () => {
          selectionListeners.delete(cb);
        },
      };
    },

    async transact(label, fn) {
      return runTransaction(label, activeWorksheet, fn);
    },

    async transactInSheet(sheetId, label, fn) {
      // 先校验存在：避免 fn 执行到一半才发现工作表不存在
      worksheetById(sheetId);
      return runTransaction(label, () => worksheetById(sheetId), fn);
    },
  };

  return {
    api,
    dispose() {
      disposed = true;
      offContent();
      offSelection();
      offSheet();
      contentListeners.clear();
      selectionListeners.clear();
      pending.clear();
    },
  };
}

function toCellData(input: Exclude<CellInput, null>): ICellData {
  if (typeof input === 'string') return inferCellData(input);
  if (typeof input === 'number') return { v: input, t: CellValueType.NUMBER };
  return { v: input, t: CellValueType.BOOLEAN };
}

/** 白名单过滤：插件的 JS 可能传任意 key，不能让脏字段进共享样式表 */
function toStylePatch(patch: StylePatch): IStylePatch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!STYLE_KEYS.has(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out as IStylePatch;
}
