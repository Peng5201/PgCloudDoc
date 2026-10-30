/**
 * 工作簿内容指纹 —— 判断「和上次存档相比内容有没有变」。
 *
 * ## 为什么不用 CRDT 状态向量
 *
 * `Y.encodeStateVector()` 只统计 Struct Store 里**插入类** struct 的时钟，
 * 而删除记录在 DeleteSet 里、不产生 struct。结果是：
 *
 *   - 只做删除（或远端删了内容）：内容变了，状态向量却**不变** → 漏判
 *   - 增了又删：内容没变，状态向量也没变 → 只是碰巧对上
 *
 * 状态向量根本看不见删除，不能当「内容有没有变」的判据。
 * 所以这里比的是物化后的**内容本身**，语义与后端 `documents.content_hash` 一致。
 *
 * ## 视图状态不算内容
 *
 * 滚动位置、缩放比存在 worksheet 上，但它们不是文档内容，
 * 滚一下不应该被判定成「有改动」。算指纹前先剥掉。
 */

import type { IWorkbookData } from '../spreadsheet/engine';

export async function fingerprintWorkbook(workbook: IWorkbookData): Promise<string> {
    const json = JSON.stringify(stripViewState(workbook));

    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
        const digest = await subtle.digest('SHA-256', new TextEncoder().encode(json));
        return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    }

    // 非安全上下文（局域网 http）拿不到 SubtleCrypto：直接拿 JSON 串当指纹，
    // 比较是精确的，代价只是这期间要多留一份字符串
    return json;
}

function stripViewState(workbook: IWorkbookData): unknown {
    const sheets: Record<string, unknown> = {};
    for (const [sheetId, sheet] of Object.entries(workbook.sheets ?? {})) {
        const {
            scrollTop: _scrollTop,
            scrollLeft: _scrollLeft,
            zoomRatio: _zoomRatio,
            ...content
        } = sheet as Record<string, unknown>;
        sheets[sheetId] = content;
    }
    return { ...workbook, sheets };
}
