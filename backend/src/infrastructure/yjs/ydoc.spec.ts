/**
 * Yjs 文档结构的单元测试。
 *
 * 重点测三件事：
 *   1. materialize ↔ applySnapshot 往返一致 —— 「存档」的正确性基础
 *   2. materialize 必须产出纯 JSON —— 夹带 Y 类型会污染快照、还会让回滚抛异常
 *   3. 并发编辑的合并语义 —— CRDT 的核心价值，也是本设计最容易改坏的地方
 */

import * as Y from 'yjs';
import {
    applySnapshot,
    countCells,
    createEmptyDoc,
    decodeCellKey,
    encodeCellKey,
    materialize,
    setCellField,
} from './ydoc';
import type { SnapshotWorkbook } from './ydoc.types';

describe('ydoc', () => {
    describe('cell key', () => {
        it('encode/decode 往返一致', () => {
            expect(decodeCellKey(encodeCellKey(3, 7, 'v'))).toEqual([3, 7, 'v']);
            expect(decodeCellKey(encodeCellKey(0, 0, 'f'))).toEqual([0, 0, 'f']);
        });
    });

    describe('createEmptyDoc', () => {
        it('产出带一张表的工作簿', () => {
            const doc = createEmptyDoc({ id: 'wb1', name: '测试簿' });
            const snap = materialize(doc, 'fallback');

            expect(snap.id).toBe('wb1');
            expect(snap.name).toBe('测试簿');
            expect(snap.sheetOrder).toEqual(['sheet1']);
            expect(snap.sheets['sheet1'].cellData).toEqual({});
            expect(snap.sheets['sheet1'].rowCount).toBe(200);
            doc.destroy();
        });

        it('尊重自定义行列数', () => {
            const doc = createEmptyDoc({
                id: 'wb1',
                name: 'x',
                rowCount: 50,
                columnCount: 10,
            });
            const snap = materialize(doc, 'wb1');
            expect(snap.sheets['sheet1'].rowCount).toBe(50);
            expect(snap.sheets['sheet1'].columnCount).toBe(10);
            doc.destroy();
        });
    });

    describe('materialize ↔ applySnapshot', () => {
        /** 造一份有内容的工作簿，字段尽量铺满 */
        function buildRichSnapshot(): SnapshotWorkbook {
            const doc = createEmptyDoc({ id: 'wb-rich', name: '销售报表' });

            doc.transact(() => {
                const meta = doc.getMap('meta');
                meta.set('locale', 'zhCN');

                // 样式是整份 LWW，存纯对象
                const styles = doc.getMap('styles');
                styles.set('s1', { bl: 1, fs: 12, bg: { rgb: '#EEF2FF' } });

                const sheet = doc.getArray<Y.Map<unknown>>('sheets').get(0);
                sheet.set('name', '汇总');
                sheet.set('tabColor', '#EEF2FF');
                sheet.set('defaultRowHeight', 32);
                sheet.set('showGridlines', 0);

                setCellField(doc, 0, 0, 0, 'v', '商品');
                setCellField(doc, 0, 0, 0, 't', 1);
                setCellField(doc, 0, 0, 0, 's', 's1');
                setCellField(doc, 0, 0, 1, 'v', '金额');
                setCellField(doc, 0, 0, 1, 't', 1);
                setCellField(doc, 0, 0, 1, 's', 's1');
                setCellField(doc, 0, 1, 0, 'v', '笔记本');
                setCellField(doc, 0, 1, 0, 't', 1);
                setCellField(doc, 0, 1, 1, 'v', 1280.5);
                setCellField(doc, 0, 1, 1, 't', 2);
                setCellField(doc, 0, 1, 1, 'f', '=SUM(B2:B2)');

                const rowData = sheet.get('rowData') as Y.Map<unknown>;
                rowData.set('0:h', 32);

                const columnData = sheet.get('columnData') as Y.Map<unknown>;
                columnData.set('0:w', 120);

                const mergeData = sheet.get('mergeData') as Y.Map<unknown>;
                mergeData.set('3:0:3:2', {
                    startRow: 3,
                    startColumn: 0,
                    endRow: 3,
                    endColumn: 2,
                });
            });

            const snapshot = materialize(doc, 'wb-rich');
            doc.destroy();
            return snapshot;
        }

        it('快照形态符合契约', () => {
            const snap = buildRichSnapshot();

            expect(snap.name).toBe('销售报表');
            expect(snap.styles['s1']).toEqual({ bl: 1, fs: 12, bg: { rgb: '#EEF2FF' } });
            expect(snap.sheets[snap.sheetOrder[0]].cellData[0][0]).toEqual({
                v: '商品',
                t: 1,
                s: 's1',
            });
            // 公式必须原样保留（本引擎不计算，但不能弄丢）
            expect(snap.sheets[snap.sheetOrder[0]].cellData[1][1].f).toBe('=SUM(B2:B2)');
            expect(snap.sheets[snap.sheetOrder[0]].mergeData).toHaveLength(1);
            expect(snap.sheets[snap.sheetOrder[0]].columnData[0]).toEqual({ w: 120 });
            expect(snap.sheets[snap.sheetOrder[0]].rowData[0]).toEqual({ h: 32 });
        });

        it('materialize 产出的是纯 JSON，不夹带 Y 类型', () => {
            const snap = buildRichSnapshot();
            // 夹带 Y.Map 的话 JSON.stringify 会吐出 Yjs 内部结构
            const json = JSON.parse(JSON.stringify(snap)) as SnapshotWorkbook;
            expect(json).toEqual(snap);
            expect(snap.styles['s1']).not.toBeInstanceOf(Y.Map);
        });

        it('往返后逐字段一致（存档/回滚的前提）', () => {
            const original = buildRichSnapshot();

            const doc = createEmptyDoc({ id: 'tmp', name: 'tmp' });
            applySnapshot(doc, original);
            const roundTripped = materialize(doc, original.id);
            doc.destroy();

            expect(roundTripped).toEqual(original);
        });

        it('applySnapshot 是覆盖而不是合并', () => {
            const first = buildRichSnapshot();

            const doc = createEmptyDoc({ id: 'wb', name: '旧内容' });
            doc.transact(() => setCellField(doc, 0, 99, 99, 'v', '旧值'));

            applySnapshot(doc, first);

            const result = materialize(doc, 'wb');
            // 回滚语义：旧内容不该被合并进来
            expect(result.sheets[result.sheetOrder[0]].cellData[99]?.[99]).toBeUndefined();
            expect(result.sheets[result.sheetOrder[0]].cellData[0][0].v).toBe('商品');
            expect(result.name).toBe('销售报表');
            doc.destroy();
        });

        it('同一份内容物化两次得到同样的快照（ETag 才稳定）', () => {
            const original = buildRichSnapshot();
            const doc = createEmptyDoc({ id: 'x', name: 'x' });
            applySnapshot(doc, original);
            expect(materialize(doc, original.id)).toEqual(materialize(doc, original.id));
            doc.destroy();
        });
    });

    /**
     * CRDT 的核心卖点。
     *
     * 这里专门覆盖「两个客户端同时新建同一个格子」——
     * 用嵌套 Y.Map 的老设计在这个用例上会丢数据，扁平 key 才能过。
     */
    describe('并发合并语义', () => {
        function fork(base: Y.Doc): Y.Doc {
            const doc = new Y.Doc();
            Y.applyUpdate(doc, Y.encodeStateAsUpdate(base));
            return doc;
        }

        function mergeAll(...docs: Y.Doc[]): Y.Doc {
            const merged = new Y.Doc();
            for (const doc of docs) Y.applyUpdate(merged, Y.encodeStateAsUpdate(doc));
            return merged;
        }

        it('同格不同字段的并发编辑都保留（即使格子是两边同时新建的）', () => {
            const base = createEmptyDoc({ id: 'wb', name: '并发测试' });
            const a = fork(base);
            const b = fork(base);

            // 两边都是「第一次写这个格子」，同时改不同字段
            a.transact(() => {
                setCellField(a, 0, 0, 0, 'v', 'A写的值');
                setCellField(a, 0, 0, 0, 't', 1);
            });
            b.transact(() => setCellField(b, 0, 0, 0, 's', 'style-from-b'));

            const merged = mergeAll(base, a, b);
            const cell = materialize(merged, 'wb').sheets['sheet1'].cellData[0][0];

            expect(cell.v).toBe('A写的值');
            expect(cell.t).toBe(1);
            expect(cell.s).toBe('style-from-b');

            [base, a, b, merged].forEach((d) => d.destroy());
        });

        it('合并顺序不影响结果（交换律）', () => {
            const base = createEmptyDoc({ id: 'wb', name: '交换律' });
            const a = fork(base);
            const b = fork(base);

            a.transact(() => setCellField(a, 0, 1, 0, 'v', 'from-a'));
            b.transact(() => setCellField(b, 0, 1, 1, 'v', 'from-b'));

            const ab = mergeAll(a, b);
            const ba = mergeAll(b, a);

            expect(materialize(ab, 'wb')).toEqual(materialize(ba, 'wb'));

            [base, a, b, ab, ba].forEach((d) => d.destroy());
        });

        it('同一字段的并发编辑取最后写入者', () => {
            const base = createEmptyDoc({ id: 'wb', name: 'LWW' });
            const a = fork(base);
            const b = fork(base);

            a.transact(() => setCellField(a, 0, 0, 0, 'v', 'A'));
            b.transact(() => setCellField(b, 0, 0, 0, 'v', 'B'));

            // 两个方向合出来的结果必须一致（不管谁赢，都得赢同一个）
            const ab = materialize(mergeAll(a, b), 'wb').sheets['sheet1'].cellData[0][0].v;
            const ba = materialize(mergeAll(b, a), 'wb').sheets['sheet1'].cellData[0][0].v;
            expect(ab).toBe(ba);
            expect(['A', 'B']).toContain(ab);

            [base, a, b].forEach((d) => d.destroy());
        });

        it('行高和列宽的并发编辑互不影响', () => {
            const base = createEmptyDoc({ id: 'wb', name: '行列' });
            const a = fork(base);
            const b = fork(base);

            a.transact(() => {
                (a.getArray<Y.Map<unknown>>('sheets').get(0).get('rowData') as Y.Map<unknown>).set(
                    '5:h',
                    40
                );
            });
            b.transact(() => {
                (
                    b.getArray<Y.Map<unknown>>('sheets').get(0).get('columnData') as Y.Map<unknown>
                ).set('3:w', 200);
            });

            const snap = materialize(mergeAll(a, b), 'wb').sheets['sheet1'];
            expect(snap.rowData[5]).toEqual({ h: 40 });
            expect(snap.columnData[3]).toEqual({ w: 200 });

            [base, a, b].forEach((d) => d.destroy());
        });
    });

    describe('countCells', () => {
        it('统计的是「格子数」而不是 key 数', () => {
            const doc = createEmptyDoc({ id: 'wb', name: '计数' });
            doc.transact(() => {
                // 3 个格子，但字段一共 5 个 —— 不能把 key 数当格子数
                setCellField(doc, 0, 0, 0, 'v', 1);
                setCellField(doc, 0, 0, 1, 'v', 1);
                setCellField(doc, 0, 0, 1, 's', 'x');
                setCellField(doc, 0, 5, 5, 'v', 1);
                setCellField(doc, 0, 5, 5, 'f', '=1');
            });
            expect(countCells(materialize(doc, 'wb'))).toBe(3);
            doc.destroy();
        });
    });
});
