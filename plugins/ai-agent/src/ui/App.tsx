/**
 * 侧面板 UI。
 *
 * 用 Preact（插件内置，不依赖宿主 React）。面板关闭时会被卸载，
 * 但状态在 AgentController 里，重开直接恢复。
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { AgentController, AgentSnapshot, UiToolCall } from '../controller';
import { renderMarkdown } from './markdown';

const TOOL_LABELS: Record<string, string> = {
    get_document_outline: '读取文档结构',
    get_selection: '读取选区',
    read_range: '读取区域',
    search_cells: '查找单元格',
    compute_stats: '统计区域',
    write_range: '写入区域',
    clear_range: '清空区域',
    format_range: '设置样式',
    sort_range: '排序',
    remove_duplicates: '删除重复行',
    find_replace: '查找替换',
};

const STATUS_LABELS: Record<UiToolCall['status'], string> = {
    pending: '等待',
    running: '执行中',
    'awaiting-approval': '待确认',
    done: '完成',
    error: '失败',
    rejected: '已取消',
};

const STATUS_CLASS: Record<UiToolCall['status'], string> = {
    pending: 'pending',
    running: 'running',
    'awaiting-approval': 'awaiting',
    done: 'done',
    error: 'error',
    rejected: 'rejected',
};

const QUICK_PROMPTS = [
    { label: '总结选区', text: '总结当前选区的内容，列出关键信息和异常。' },
    { label: '填充空值', text: '把当前选区里的空单元格填成 0。' },
    { label: '表头加粗', text: '把当前区域的第一行设为加粗。' },
    { label: '查找重复', text: '找出当前选区里的重复行，并告诉我它们的地址。' },
];

export function App({ controller }: { controller: AgentController }) {
    const state = useControllerState(controller);
    const listRef = useRef<HTMLDivElement>(null);
    const [historyOpen, setHistoryOpen] = useState(false);

    useEffect(() => {
        void controller.ensureInitialized();
    }, [controller]);

    useEffect(() => {
        setHistoryOpen(false);
    }, [state.document?.id]);

    useEffect(() => {
        const element = listRef.current;
        if (element) element.scrollTop = element.scrollHeight;
    }, [state.messages, state.streaming]);

    const ready = Boolean(state.document && state.config?.enabled && !state.loading);

    return (
        <div class="ai-panel">
            <Toolbar
                state={state}
                controller={controller}
                historyOpen={historyOpen}
                onToggleHistory={() => setHistoryOpen((open) => !open)}
            />

            {historyOpen ? (
                <>
                    <div class="ai-history-backdrop" onClick={() => setHistoryOpen(false)} />
                    <HistoryMenu
                        state={state}
                        controller={controller}
                        onClose={() => setHistoryOpen(false)}
                    />
                </>
            ) : null}

            {state.document ? <ContextBar state={state} /> : null}
            {state.error ? (
                <div class="ai-error" role="alert">
                    <span class="ai-error-text">{state.error}</span>
                    {state.document && !state.loading ? (
                        <button
                            type="button"
                            class="ai-btn"
                            onClick={() => void controller.ensureInitialized(true)}
                        >
                            重试
                        </button>
                    ) : null}
                </div>
            ) : null}

            <div class="ai-body" ref={listRef}>
                {state.loading ? <Loading /> : null}

                {!state.loading && !state.document ? (
                    <EmptyState title="请先打开一个文档" detail="AI 助手需要当前表格作为上下文。" />
                ) : null}

                {!state.loading && state.document && state.config && !state.config.enabled ? (
                    <EmptyState
                        title="AI 助手暂不可用"
                        detail={state.config.reason ?? '服务端没有启用该功能。'}
                    />
                ) : null}

                {ready && state.messages.length === 0 ? (
                    <EmptyState
                        title="可以让我读写当前表格"
                        detail="描述你要做的事，我会先读取数据、给出变更预览，确认后再写入。"
                        onPick={(text) => void controller.send(text)}
                    />
                ) : null}

                {state.messages.map((message) => (
                    <MessageView
                        key={message.id}
                        message={message}
                        controller={controller}
                    />
                ))}
            </div>

            <Composer state={state} controller={controller} ready={ready} />
        </div>
    );
}

// ─────────────────────────── 布局 ───────────────────────────

function Toolbar({
    state,
    controller,
    historyOpen,
    onToggleHistory,
}: {
    state: AgentSnapshot;
    controller: AgentController;
    historyOpen: boolean;
    onToggleHistory: () => void;
}) {
    return (
        <div class="ai-toolbar">
            <select
                class="ai-model"
                aria-label="模型"
                value={state.model}
                disabled={!state.config?.enabled || state.streaming}
                onChange={(event) => controller.setModel(event.currentTarget.value)}
            >
                {(state.config?.models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>
                        {model.label}
                    </option>
                ))}
            </select>
            <button
                type="button"
                class="ai-btn"
                aria-expanded={historyOpen}
                disabled={!state.document || state.streaming}
                onClick={onToggleHistory}
            >
                历史
            </button>
            <button
                type="button"
                class="ai-btn"
                disabled={state.streaming || !state.config?.enabled}
                onClick={() => void controller.newConversation()}
            >
                新对话
            </button>
        </div>
    );
}

function HistoryMenu({
    state,
    controller,
    onClose,
}: {
    state: AgentSnapshot;
    controller: AgentController;
    onClose: () => void;
}) {
    return (
        <div class="ai-history" role="menu" aria-label="历史对话">
            <div class="ai-history-head">当前文档的对话</div>
            {state.conversations.length === 0 ? (
                <div class="ai-history-empty">还没有历史对话。发送第一条消息后会自动生成。</div>
            ) : (
                state.conversations.map((conversation) => {
                    const active = conversation.id === state.conversationId;
                    return (
                        <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={active}
                            key={conversation.id}
                            class={`ai-history-item${active ? ' is-active' : ''}`}
                            onClick={() => {
                                onClose();
                                void controller.openConversation(conversation.id);
                            }}
                        >
                            <span class="ai-history-title">
                                {conversation.title || '新对话'}
                            </span>
                            <span class="ai-history-time">
                                {formatTime(conversation.updatedAt)}
                            </span>
                            {active ? <span class="ai-history-dot" /> : null}
                        </button>
                    );
                })
            )}
        </div>
    );
}

function formatTime(iso: string): string {
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return '';

    const diff = Date.now() - time;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
    return new Date(time).toLocaleDateString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
    });
}

function ContextBar({ state }: { state: AgentSnapshot }) {
    return (
        <div class="ai-context">
            <span class="ai-context-doc" title={state.document?.title}>
                {state.document?.title}
            </span>
            <span class="ai-context-sep">·</span>
            <span class="ai-context-range" title={state.selectionLabel}>
                {state.selectionLabel || '未选择区域'}
            </span>
        </div>
    );
}

function EmptyState({
    title,
    detail,
    onPick,
}: {
    title: string;
    detail: string;
    onPick?: (text: string) => void;
}) {
    return (
        <div class="ai-empty">
            <div class="ai-empty-title">{title}</div>
            <div>{detail}</div>
            {onPick ? (
                <div class="ai-quick">
                    {QUICK_PROMPTS.map((prompt) => (
                        <button
                            key={prompt.label}
                            type="button"
                            onClick={() => onPick(prompt.text)}
                        >
                            {prompt.label}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function Loading() {
    return (
        <div class="ai-loading">
            <span class="ai-spinner" />
            正在恢复会话…
        </div>
    );
}

// ─────────────────────────── 消息 ───────────────────────────

function MessageView({
    message,
    controller,
}: {
    message: AgentSnapshot['messages'][number];
    controller: AgentController;
}) {
    if (message.role === 'user') {
        return (
            <div class="ai-msg ai-msg-user">
                <div class="ai-bubble">{message.text}</div>
            </div>
        );
    }

    if (message.role === 'notice') {
        return <div class="ai-notice">{message.text}</div>;
    }

    return (
        <div class="ai-msg ai-msg-assistant">
            <div class="ai-avatar" aria-hidden="true">
                AI
            </div>
            <div class="ai-msg-main">
                {message.text ? (
                    message.status === 'streaming' ? (
                        <div class="ai-msg-text is-streaming">
                            {message.text}
                            <span class="ai-cursor" />
                        </div>
                    ) : (
                        <div
                            class="ai-msg-text ai-md"
                            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }}
                        />
                    )
                ) : message.status === 'streaming' ? (
                    <div class="ai-msg-text is-streaming">
                        <span class="ai-cursor" />
                    </div>
                ) : null}

                {message.toolCalls.map((call) => (
                    <ToolCard key={call.id} call={call} controller={controller} />
                ))}

                {message.status === 'error' ? (
                    <div class="ai-msg-note is-error">本轮生成失败</div>
                ) : null}
                {message.status === 'cancelled' ? (
                    <div class="ai-msg-note">已停止</div>
                ) : null}
            </div>
        </div>
    );
}

// ─────────────────────────── 工具卡片 ───────────────────────────

function ToolCard({
    call,
    controller,
}: {
    call: UiToolCall;
    controller: AgentController;
}) {
    const awaiting = call.status === 'awaiting-approval';
    const summary = call.summary ?? summarizeArgs(call.args);

    return (
        <div
            class={[
                'ai-tool',
                awaiting ? 'is-awaiting' : '',
                call.status === 'error' ? 'is-error' : '',
            ]
                .filter(Boolean)
                .join(' ')}
        >
            <div class="ai-tool-head">
                <span class="ai-tool-name">{TOOL_LABELS[call.name] ?? call.name}</span>
                <span class="ai-tool-summary" title={summary}>
                    {summary}
                </span>
                <span class={`ai-tool-status is-${STATUS_CLASS[call.status]}`}>
                    {STATUS_LABELS[call.status]}
                </span>
            </div>

            <div class="ai-tool-body">
                {awaiting && call.diff ? <DiffTable call={call} /> : null}

                {awaiting ? (
                    <div class="ai-tool-actions">
                        <button
                            type="button"
                            class="ai-btn"
                            onClick={() => controller.reject(call.id)}
                        >
                            取消
                        </button>
                        <button
                            type="button"
                            class="ai-btn ai-btn-primary"
                            onClick={() => controller.approve(call.id)}
                        >
                            应用
                        </button>
                    </div>
                ) : null}

                {call.error ? <div class="ai-tool-error">{call.error}</div> : null}

                {!awaiting && call.resultPreview ? (
                    <details>
                        <summary class="ai-tool-result-summary">查看结果</summary>
                        <pre class="ai-result">{call.resultPreview}</pre>
                    </details>
                ) : null}
            </div>
        </div>
    );
}

function DiffTable({ call }: { call: UiToolCall }) {
    const diff = call.diff ?? [];
    const total = call.plan?.totalChanges ?? diff.length;

    return (
        <div class="ai-diff">
            {diff.map((row) => (
                <div class="ai-diff-row" key={`${row.address}:${row.before}:${row.after}`}>
                    <span class="ai-diff-address">{row.address}</span>
                    <span class="ai-diff-before" title={row.before}>
                        {row.before || '（空）'}
                    </span>
                    <span class="ai-diff-after" title={row.after}>
                        {row.after || '（空）'}
                    </span>
                </div>
            ))}
            {total > diff.length ? (
                <div class="ai-diff-more">还有 {total - diff.length} 处未展示</div>
            ) : null}
        </div>
    );
}

// ─────────────────────────── 输入 ───────────────────────────

function Composer({
    state,
    controller,
    ready,
}: {
    state: AgentSnapshot;
    controller: AgentController;
    ready: boolean;
}) {
    const [text, setText] = useState('');
    const disabled = !ready || state.streaming;

    const submit = (): void => {
        const value = text.trim();
        if (!value || disabled) return;
        setText('');
        void controller.send(value);
    };

    return (
        <div class="ai-composer">
            <textarea
                class="ai-input"
                rows={2}
                value={text}
                placeholder={
                    ready
                        ? '描述你要做的事，Enter 发送，Shift+Enter 换行'
                        : 'AI 助手当前不可用'
                }
                disabled={!ready}
                onInput={(event) => setText(event.currentTarget.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        submit();
                    }
                }}
            />
            <div class="ai-composer-row">
                <span class="ai-hint">
                    {state.streaming
                        ? '正在处理…'
                        : ready
                          ? '写入前会展示变更并等待确认'
                          : (state.config?.reason ?? '请先打开一个文档')}
                </span>
                {state.streaming ? (
                    <button
                        type="button"
                        class="ai-btn ai-btn-danger"
                        onClick={() => controller.cancel()}
                    >
                        停止
                    </button>
                ) : (
                    <button
                        type="button"
                        class="ai-btn ai-btn-primary"
                        disabled={!ready || !text.trim()}
                        onClick={submit}
                    >
                        发送
                    </button>
                )}
            </div>
        </div>
    );
}

// ─────────────────────────── 订阅 ───────────────────────────

function useControllerState(controller: AgentController): AgentSnapshot {
    const [state, setState] = useState(() => controller.getSnapshot());

    useEffect(() => {
        setState(controller.getSnapshot());
        return controller.subscribe(() => setState(controller.getSnapshot()));
    }, [controller]);

    return state;
}

function summarizeArgs(args: unknown): string {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
    const record = args as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof record['sheet'] === 'string') parts.push(record['sheet']);
    if (typeof record['range'] === 'string') parts.push(record['range']);
    if (typeof record['query'] === 'string') parts.push(`“${record['query']}”`);
    if (parts.length > 0) return parts.join(' · ');
    try {
        const text = JSON.stringify(record);
        return text.length > 90 ? `${text.slice(0, 90)}…` : text;
    } catch {
        return '';
    }
}
