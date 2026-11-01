/**
 * 工具测试用的假文档。
 *
 * 只实现工具真正用到的文档 API；写入语义与宿主保持一致：
 *   - null 删除单元格；
 *   - 一次 transactInSheet = 一次记录；
 *   - 记录实际写过的地址，用来验证 find_replace 只写命中格。
 */

import type {
    CellInput,
    CellSnapshot,
    Disposable,
    DocumentChangeEvent,
    DocumentTransaction,
    RangeSnapshot,
    SelectionChangeEvent,
    SelectionSnapshot,
    SheetDocumentApi,
    SheetInfoSnapshot,
    StylePatch,
    WorkbookSnapshot,
} from '@pgclouddoc/plugin-api';

export interface StyleCall {
    sheetId: string;
    range: RangeSnapshot;
    patch: StylePatch;
}

export class FakeDoc implements SheetDocumentApi {
    readonly id = 'doc-1';
    readonly type = 'sheet' as const;
    title = '测试文档';
    readOnly = false;
    canWrite = true;

    readonly sheets: Array<{
        id: string;
        name: string;
        hidden: boolean;
        rowCount: number;
        columnCount: number;
    }> = [
        { id: 'sheet1', name: 'Sheet1', hidden: false, rowCount: 100, columnCount: 26 },
        { id: 'sheet2', name: 'Sheet2', hidden: false, rowCount: 100, columnCount: 26 },
    ];

    readonly cells = new Map<string, CellSnapshot>();
    readonly writtenCells: string[] = [];
    readonly transactions: string[] = [];
    readonly styleCalls: StyleCall[] = [];

    activeSheetId = 'sheet1';
    private selection: SelectionSnapshot = {
        active: { row: 0, column: 0 },
        ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
    };

    setCell(
        sheetId: string,
        row: number,
        column: number,
        value: string | number | boolean | null
    ): void {
        const key = this.key(sheetId, row, column);
        if (value === null) {
            this.cells.delete(key);
            return;
        }
        this.cells.set(key, snapshotOf(value));
    }

    getSelection(): SelectionSnapshot {
        return this.selection;
    }

    async setSelection(selection: SelectionSnapshot): Promise<void> {
        this.selection = selection;
    }

    getSheets() {
        return this.sheets.map((sheet) => ({
            id: sheet.id,
            name: sheet.name,
            hidden: sheet.hidden,
        }));
    }

    getSheetInfo(): SheetInfoSnapshot[] {
        return this.sheets.map((sheet) => ({
            ...sheet,
            usedRange: this.usedRange(sheet.id),
        }));
    }

    getActiveSheetId(): string {
        return this.activeSheetId;
    }

    async setActiveSheet(sheetId: string): Promise<void> {
        if (this.sheets.some((sheet) => sheet.id === sheetId)) this.activeSheetId = sheetId;
    }

    async getRangeValues(range: RangeSnapshot): Promise<CellSnapshot[][]> {
        return this.getRangeValuesInSheet(this.activeSheetId, range);
    }

    async getRangeValuesInSheet(
        sheetId: string,
        range: RangeSnapshot
    ): Promise<CellSnapshot[][]> {
        const rows: CellSnapshot[][] = [];
        for (let row = range.startRow; row <= range.endRow; row++) {
            const out: CellSnapshot[] = [];
            for (let column = range.startColumn; column <= range.endColumn; column++) {
                out.push(
                    this.cells.get(this.key(sheetId, row, column)) ?? {
                        value: null,
                        formula: null,
                        displayText: '',
                    }
                );
            }
            rows.push(out);
        }
        return rows;
    }

    async getSnapshot(): Promise<WorkbookSnapshot> {
        return {};
    }

    async setRangeValues(range: RangeSnapshot, values: CellInput[][]): Promise<void> {
        this.applyValues(this.activeSheetId, range, values);
    }

    async clearRange(range: RangeSnapshot): Promise<void> {
        this.clear(this.activeSheetId, range);
    }

    async setRangeStyle(range: RangeSnapshot, patch: StylePatch): Promise<void> {
        this.styleCalls.push({ sheetId: this.activeSheetId, range, patch });
    }

    onDidChange(_cb: (event: DocumentChangeEvent) => void): Disposable {
        return { dispose: () => undefined };
    }

    onDidChangeSelection(_cb: (event: SelectionChangeEvent) => void): Disposable {
        return { dispose: () => undefined };
    }

    async transact<T>(
        label: string,
        fn: (tx: DocumentTransaction) => Promise<T> | T
    ): Promise<T> {
        return this.transactInSheet(this.activeSheetId, label, fn);
    }

    async transactInSheet<T>(
        sheetId: string,
        label: string,
        fn: (tx: DocumentTransaction) => Promise<T> | T
    ): Promise<T> {
        const operations: Array<() => void> = [];
        const tx: DocumentTransaction = {
            setRangeValues: (range, values) => {
                operations.push(() => this.applyValues(sheetId, range, values));
            },
            clearRange: (range) => {
                operations.push(() => this.clear(sheetId, range));
            },
            setRangeStyle: (range, patch) => {
                operations.push(() => {
                    this.styleCalls.push({ sheetId, range, patch });
                });
            },
        };

        const result = await fn(tx);
        for (const operation of operations) operation();
        this.transactions.push(label);
        return result;
    }

    // ─────────────────────────── 内部 ───────────────────────────

    private applyValues(sheetId: string, range: RangeSnapshot, values: CellInput[][]): void {
        for (let row = range.startRow; row <= range.endRow; row++) {
            for (let column = range.startColumn; column <= range.endColumn; column++) {
                const value = values[row - range.startRow]?.[column - range.startColumn] ?? null;
                this.writtenCells.push(`${sheetId}!${row}:${column}`);
                this.setCell(sheetId, row, column, value);
            }
        }
    }

    private clear(sheetId: string, range: RangeSnapshot): void {
        for (let row = range.startRow; row <= range.endRow; row++) {
            for (let column = range.startColumn; column <= range.endColumn; column++) {
                this.writtenCells.push(`${sheetId}!${row}:${column}`);
                this.cells.delete(this.key(sheetId, row, column));
            }
        }
    }

    private usedRange(sheetId: string): RangeSnapshot | null {
        let startRow = Number.POSITIVE_INFINITY;
        let startColumn = Number.POSITIVE_INFINITY;
        let endRow = -1;
        let endColumn = -1;

        for (const key of this.cells.keys()) {
            const [id, row, column] = key.split(':');
            if (id !== sheetId) continue;
            const r = Number(row);
            const c = Number(column);
            startRow = Math.min(startRow, r);
            startColumn = Math.min(startColumn, c);
            endRow = Math.max(endRow, r);
            endColumn = Math.max(endColumn, c);
        }

        if (endRow < 0) return null;
        return { startRow, startColumn, endRow, endColumn };
    }

    private key(sheetId: string, row: number, column: number): string {
        return `${sheetId}:${row}:${column}`;
    }
}

function snapshotOf(value: string | number | boolean): CellSnapshot {
    const formula = typeof value === 'string' && value.startsWith('=') ? value : null;
    return {
        value,
        formula,
        displayText:
            typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value),
    };
}
