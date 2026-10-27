/**
 * 稀疏矩阵 —— 整个表格引擎的地基。
 *
 * 对照 Univer: packages/core/src/shared/object-matrix.ts (821 行)
 *
 * 为什么必须是稀疏的：
 *   一张 10 万行 × 20 列的表实际可能只有 500 个格子有值。
 *   稠密数组要分配 200 万个对象直接爆内存；稀疏矩阵只占实际数据的体积。
 *
 * 存储是最朴素的嵌套对象 { [row]: { [column]: T } }，
 * 行列下标作为 JS 对象的 key（字符串），访问是 O(1) 哈希。
 */

import type { IRange, ObjectMatrixPrimitive } from './types';

export class ObjectMatrix<T> {
    private _matrix: ObjectMatrixPrimitive<T>;

    constructor(matrix: ObjectMatrixPrimitive<T> = {}) {
        this._matrix = matrix;
    }

    get matrix(): ObjectMatrixPrimitive<T> {
        return this._matrix;
    }

    getValue(row: number, column: number): T | undefined {
        return this._matrix[row]?.[column];
    }

    setValue(row: number, column: number, value: T): void {
        const rowMap = (this._matrix[row] ??= {});
        rowMap[column] = value;
    }

    /** 真删除（连空行一起清掉，避免矩阵里残留空壳） */
    realDeleteValue(row: number, column: number): void {
        const rowMap = this._matrix[row];
        if (!rowMap) return;
        delete rowMap[column];
        if (Object.keys(rowMap).length === 0) {
            delete this._matrix[row];
        }
    }

    /** 整行是否存在 */
    hasRow(row: number): boolean {
        return this._matrix[row] !== undefined;
    }

    /** 一行的全部内容（只读，别改） */
    getRow(row: number): Record<number, T> | undefined {
        return this._matrix[row];
    }

    forEach(callback: (row: number, column: number, value: T) => void): void {
        for (const rowKey of Object.keys(this._matrix)) {
            const rowIndex = Number(rowKey);
            const rowMap = this._matrix[rowIndex];
            if (!rowMap) continue;
            for (const colKey of Object.keys(rowMap)) {
                callback(rowIndex, Number(colKey), rowMap[Number(colKey)] as T);
            }
        }
    }

    /**
     * 只遍历矩形内的格子。
     *
     * 这是渲染和命令的关键优化：画第 3000..3020 行时，
     * 不应该先 `forEach` 完 50 万格再 `inView` 过滤掉 99.99%。
     * 这里按行号区间过滤后直接跳过列号区间外的键。
     */
    forEachInRange(
        r: IRange,
        callback: (row: number, column: number, value: T) => void
    ): void {
        for (let row = r.startRow; row <= r.endRow; row++) {
            const rowMap = this._matrix[row];
            if (!rowMap) continue;
            for (const colKey of Object.keys(rowMap)) {
                const column = Number(colKey);
                if (column < r.startColumn || column > r.endColumn) continue;
                callback(row, column, rowMap[column] as T);
            }
        }
    }

    /** 矩阵里实际有多少个格子 —— 用于观测稀疏度 */
    count(): number {
        let n = 0;
        for (const rowKey of Object.keys(this._matrix)) {
            n += Object.keys(this._matrix[Number(rowKey)] ?? {}).length;
        }
        return n;
    }

    toJSON(): ObjectMatrixPrimitive<T> {
        return this._matrix;
    }

    static fromJSON<T>(json: ObjectMatrixPrimitive<T>): ObjectMatrix<T> {
        return new ObjectMatrix(structuredClone(json));
    }
}

/** 稀疏的一维数组 { [index]: T }，用于 rowData / columnData */
export class ObjectArray<T> {
    private _data: Record<number, T>;

    constructor(data: Record<number, T> = {}) {
        this._data = data;
    }

    get(index: number): T | undefined {
        return this._data[index];
    }

    set(index: number, value: T): void {
        this._data[index] = value;
    }

    /** 合并进已有的条目（rowData 的 h 和 s 可以分别设置） */
    merge(index: number, patch: Partial<T>): void {
        this._data[index] = { ...(this._data[index] ?? ({} as T)), ...patch };
    }

    delete(index: number): void {
        delete this._data[index];
    }

    get isEmpty(): boolean {
        return Object.keys(this._data).length === 0;
    }

    forEach(callback: (index: number, value: T) => void): void {
        for (const key of Object.keys(this._data)) {
            callback(Number(key), this._data[Number(key)] as T);
        }
    }

    toJSON(): Record<number, T> {
        return this._data;
    }

    static fromJSON<T>(json: Record<number, T>): ObjectArray<T> {
        return new ObjectArray(structuredClone(json));
    }
}
