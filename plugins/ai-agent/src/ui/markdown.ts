/**
 * Markdown 渲染。
 *
 * 模型输出可能复述单元格内容，而单元格内容是不可信输入，
 * 所以必须经过 DOMPurify 再进 innerHTML，绝不能直接塞 marked 的结果。
 */

import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({
    gfm: true,
    breaks: true,
});

export function renderMarkdown(text: string): string {
    const html = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick'],
    });
}
