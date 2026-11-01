/**
 * 文档交互 API。
 *
 * 设计约束（不是建议，是硬规则）：
 *   1. 全部异步 —— 将来插件进 iframe/Worker 时签名不变；
 *   2. 只返回普通 JSON，不暴露引擎内部对象/Y.Doc；
 *   3. 写入由宿主转成命令走 engine.execute，因此天然可撤销、可协同、受权限约束。
 */

import type { Disposable } from './common.js';

/** 0-based，闭区间 */
export interface RangeSnapshot {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

export interface SelectionSnapshot {
  active: { row: number; column: number };
  ranges: RangeSnapshot[];
}

export interface SheetSummarySnapshot {
  id: string;
  name: string;
  hidden: boolean;
}

/**
 * 工作表的尺寸与有效区域。
 *
 * `usedRange` 覆盖有内容或有样式的单元格；空表为 `null`。
 * 它只是「读取建议」，不代表写入边界 —— 写入仍受 rowCount / columnCount 约束。
 */
export interface SheetInfoSnapshot {
  id: string;
  name: string;
  hidden: boolean;
  rowCount: number;
  columnCount: number;
  usedRange: RangeSnapshot | null;
}

/** 单元格的只读快照。`displayText` 是按数字格式渲染后的显示文本 */
export interface CellSnapshot {
  value: string | number | boolean | null;
  formula: string | null;
  displayText: string;
}

/**
 * 可写入的单元格值。
 * - 字符串会走宿主的值推断（数字、布尔、= 公式）
 * - null 表示删除该格（稀疏矩阵里"不存在"才是常态）
 */
export type CellInput = string | number | boolean | null;

/**
 * 样式增量。只允许这些字段，避免插件把内部样式结构当契约。
 * 取值语义与引擎一致：0/1 是布尔开关，颜色是 { rgb }。
 */
export interface StylePatch {
  bl?: 0 | 1 | null;
  it?: 0 | 1 | null;
  ul?: 0 | 1 | null;
  st?: 0 | 1 | null;
  fs?: number | null;
  cl?: { rgb: string } | null;
  bg?: { rgb: string } | null;
  ht?: number | null;
  vt?: number | null;
  tb?: number | null;
}

export type DocumentChangeKind = 'content' | 'selection' | 'sheet';

export interface DocumentChangeEvent {
  kind: DocumentChangeKind;
  /**
   * 变更来源。
   * v1 能区分 plugin / local；remote 预留给协同层后续上报。
   */
  origin: 'local' | 'remote' | 'plugin';
}

export interface SelectionChangeEvent {
  selection: SelectionSnapshot;
}

/** 只读工作簿快照（与文档格式一致，但宿主不承诺插件可以依赖全部字段） */
export type WorkbookSnapshot = Record<string, unknown>;

export interface DocumentTransaction {
  setRangeValues(range: RangeSnapshot, values: CellInput[][]): void;
  clearRange(range: RangeSnapshot): void;
  setRangeStyle(range: RangeSnapshot, patch: StylePatch): void;
}

/**
 * 一个打开的表格文档。
 *
 * 所有写方法在以下情况会抛错：
 *   - 文档已关闭（E_PLUGIN_DISPOSED）
 *   - manifest 未声明 document:write（E_PLUGIN_PERMISSION）
 *   - 当前用户只读（E_PLUGIN_READ_ONLY）
 */
export interface SheetDocumentApi {
  readonly id: string;
  readonly title: string;
  readonly type: 'sheet';
  readonly readOnly: boolean;
  readonly canWrite: boolean;

  // ── 读 ──
  getSelection(): SelectionSnapshot;
  setSelection(selection: SelectionSnapshot): Promise<void>;
  getSheets(): SheetSummarySnapshot[];
  /** 所有工作表的尺寸与有效区域；不需要切换到目标表 */
  getSheetInfo(): SheetInfoSnapshot[];
  getActiveSheetId(): string;
  setActiveSheet(sheetId: string): Promise<void>;
  /** 超过 20,000 格抛 E_PLUGIN_RANGE_TOO_LARGE */
  getRangeValues(range: RangeSnapshot): Promise<CellSnapshot[][]>;
  /**
   * 读取任意工作表，**不切换当前活动表、不改变用户的选区和视图**。
   * 工作表不存在抛 E_PLUGIN_INVALID_RANGE。
   */
  getRangeValuesInSheet(sheetId: string, range: RangeSnapshot): Promise<CellSnapshot[][]>;
  /** 整份只读快照。大文档慎用，优先读选区 */
  getSnapshot(): Promise<WorkbookSnapshot>;

  // ── 写 ──
  setRangeValues(range: RangeSnapshot, values: CellInput[][]): Promise<void>;
  clearRange(range: RangeSnapshot): Promise<void>;
  setRangeStyle(range: RangeSnapshot, patch: StylePatch): Promise<void>;

  // ── 事件 ──
  onDidChange(cb: (event: DocumentChangeEvent) => void): Disposable;
  onDidChangeSelection(cb: (event: SelectionChangeEvent) => void): Disposable;

  /** 多次写入合成一个撤销单元；fn 抛错则不落任何改动 */
  transact<T>(label: string, fn: (tx: DocumentTransaction) => Promise<T> | T): Promise<T>;
  /**
   * 在指定工作表上执行事务，**不切换当前活动表**。
   * 写入同样进入撤销栈与协同广播，一次事务 = 一个撤销单元。
   */
  transactInSheet<T>(
    sheetId: string,
    label: string,
    fn: (tx: DocumentTransaction) => Promise<T> | T
  ): Promise<T>;
}

export interface DocumentHub {
  /** 当前打开的文档；不在编辑页时为 null */
  active(): SheetDocumentApi | null;
  onDidOpen(cb: (doc: SheetDocumentApi) => void): Disposable;
  onDidClose(cb: (documentId: string) => void): Disposable;
}
