/**
 * SSE 解析（浏览器侧）。
 *
 * 与后端 same-realm 无关：这里读的是 fetch 返回的 ReadableStream，
 * 需要自己处理跨 chunk 的半行。
 */

export interface SseEvent {
    event: string;
    data: string;
}

export async function consumeSse(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: SseEvent) => void
): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            buffer = buffer.replace(/\r\n/g, '\n');

            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
                const block = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const event = parseBlock(block);
                if (event) onEvent(event);
                boundary = buffer.indexOf('\n\n');
            }
        }
    } finally {
        reader.releaseLock();
    }
}

function parseBlock(raw: string): SseEvent | null {
    let event = 'message';
    const data: string[] = [];

    for (const line of raw.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator >= 0 ? line.slice(0, separator) : line;
        let value = separator >= 0 ? line.slice(separator + 1) : '';
        if (value.startsWith(' ')) value = value.slice(1);

        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
    }

    return data.length > 0 ? { event, data: data.join('\n') } : null;
}
