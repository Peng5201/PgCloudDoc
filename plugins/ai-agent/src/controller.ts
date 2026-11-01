/**
 * Agent 控制器。
 *
 * 生命周期比面板视图长：侧面板关闭会卸载 React 树，但控制器仍持有会话状态，
 * 重新打开时可以直接恢复；文档切换 / 关闭时才重置。
 *
 * Agent 循环在这里：streamTurn → 执行工具 → 把 tool_results 再发回去。
 * 工具本身只通过文档 API 读写，保证撤销、协同和只读约束由宿主兜底。
 */

import type {
    AiConfigResponse,
    AiContentBlock,
    AiConversationSummary,
    AiMessageDto,
    AiToolCallEvent,
    AiToolResult,
    AiTurnInput,
} from '@pgclouddoc/ai-protocol';
import type { Disposable, PluginContext, SheetDocumentApi } from '@pgclouddoc/plugin-api';
import { toA1, toA1Cell } from './agent/a1';
import { buildDocumentContext } from './agent/context';
import { ToolError, type DiffCell, type WritePlan } from './agent/types';
import { AiApiClient, AiApiError } from './api/client';
import { getTool, toolDefinitions } from './tools/registry';

export type ToolStatus =
    | 'pending'
    | 'running'
    | 'awaiting-approval'
    | 'done'
    | 'error'
    | 'rejected';

export interface UiToolCall {
    id: string;
    name: string;
    args: unknown;
    status: ToolStatus;
    summary?: string;
    diff?: DiffCell[];
    resultPreview?: string;
    error?: string;
    plan?: WritePlan;
}

export interface UiMessage {
    id: string;
    role: 'user' | 'assistant' | 'notice';
    text: string;
    status: 'streaming' | 'complete' | 'cancelled' | 'error';
    toolCalls: UiToolCall[];
    createdAt: string;
}

export interface AgentSnapshot {
    initialized: boolean;
    loading: boolean;
    document: { id: string; title: string } | null;
    config: AiConfigResponse | null;
    model: string;
    conversationId: string | null;
    /** 当前文档的历史会话，按 updatedAt 倒序 */
    conversations: AiConversationSummary[];
    messages: UiMessage[];
    streaming: boolean;
    error: string | null;
    selectionLabel: string;
    autoApply: boolean;
}

const DEFAULT_CELL_LIMIT = 2_000;
const MAX_CELL_LIMIT = 20_000;

export class AgentController implements Disposable {
    private readonly api: AiApiClient;
    private state: AgentSnapshot = createInitialState();
    private readonly listeners = new Set<() => void>();

    private docId: string | null = null;
    private initialized = false;
    private initialization: Promise<void> | null = null;
    private docDisposable: Disposable | null = null;
    private abortController: AbortController | null = null;
    private pendingApproval: { callId: string; resolve: (approved: boolean) => void } | null =
        null;
    private aborted = false;
    private disposed = false;

    constructor(private readonly ctx: PluginContext) {
        this.api = new AiApiClient(ctx);

        // 文档切换：关闭时重置，打开时重新绑定会话
        ctx.subscriptions.push(
            ctx.documents.onDidOpen(() => {
                void this.ensureInitialized(true);
            })
        );
        ctx.subscriptions.push(
            ctx.documents.onDidClose(() => this.handleDocumentClosed())
        );
    }

    // ─────────────────────────── 订阅 ───────────────────────────

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    getSnapshot = (): AgentSnapshot => this.state;

    // ─────────────────────────── 初始化 ───────────────────────────

    async ensureInitialized(force = false): Promise<void> {
        if (this.disposed) return;
        if (this.initialization) {
            await this.initialization;
            return;
        }

        const task = this.initialize(force);
        this.initialization = task;
        try {
            await task;
        } finally {
            if (this.initialization === task) this.initialization = null;
        }
    }

    private async initialize(force: boolean): Promise<void> {
        if (this.disposed) return;

        const doc = this.ctx.documents.active();
        if (!doc) {
            this.setState({
                initialized: true,
                loading: false,
                document: null,
                conversationId: null,
                conversations: [],
                messages: [],
                error: null,
            });
            return;
        }

        if (!force && this.initialized && this.docId === doc.id) {
            this.refreshSelectionLabel(doc);
            return;
        }

        this.cancel();
        this.docId = doc.id;
        // 只有真正拿到 config / 会话后才算初始化成功；
        // 网络失败时保持 false，下次打开面板或点「重试」会重新加载。
        this.initialized = false;
        this.setState({
            ...createInitialState(),
            initialized: true,
            loading: true,
            document: { id: doc.id, title: doc.title },
            autoApply: this.autoApply(),
        });
        this.bindDocument(doc);

        try {
            const config = await this.api.getConfig();
            if (this.docId !== doc.id) return;

            const storedModel = await this.ctx.storage.get<string>('model');
            if (this.docId !== doc.id) return;

            const model =
                storedModel && config.models.some((item) => item.id === storedModel)
                    ? storedModel
                    : config.defaultModel;
            this.setState({ config, model });

            if (!config.enabled) {
                this.initialized = true;
                this.setState({ loading: false });
                return;
            }

            const conversations = await this.api.listConversations(doc.id);
            if (this.docId !== doc.id) return;
            this.setState({ conversations });

            // 恢复当前文档上次选中的会话；找不到（已删除）就退回最近更新的一条
            const storedId = await this.ctx.storage.get<string>(`lastConversation.${doc.id}`);
            if (this.docId !== doc.id) return;
            const target = conversations.find((item) => item.id === storedId) ?? conversations[0];

            if (target) {
                const detail = await this.api.getConversation(target.id);
                if (this.docId !== doc.id) return;
                this.initialized = true;
                this.setState({
                    conversationId: detail.id,
                    messages: restoreMessages(detail),
                    loading: false,
                });
                void this.rememberConversation(doc.id, detail.id);
                return;
            }

            const created = await this.api.createConversation(doc.id);
            if (this.docId !== doc.id) return;
            this.initialized = true;
            this.setState({
                conversationId: created.id,
                conversations: [created, ...conversations],
                loading: false,
            });
            void this.rememberConversation(doc.id, created.id);
        } catch (err) {
            if (this.docId !== doc.id) return;
            // initialized 保持 false —— 允许重试
            this.setState({ loading: false, error: messageOf(err) });
        }
    }

    async newConversation(): Promise<void> {
        const doc = this.ctx.documents.active();
        if (!doc || this.state.streaming || !this.state.config?.enabled) return;

        try {
            this.cancel();
            const created = await this.api.createConversation(doc.id);
            this.setState({
                conversationId: created.id,
                conversations: [created, ...this.state.conversations],
                messages: [],
                error: null,
            });
            void this.rememberConversation(doc.id, created.id);
        } catch (err) {
            this.setState({ error: messageOf(err) });
        }
    }

    /** 切换到一条历史会话 */
    async openConversation(conversationId: string): Promise<void> {
        if (this.disposed || this.state.streaming) return;
        const doc = this.ctx.documents.active();
        if (!doc || conversationId === this.state.conversationId) return;

        try {
            const detail = await this.api.getConversation(conversationId);
            if (this.docId !== doc.id) return;
            this.setState({
                conversationId: detail.id,
                messages: restoreMessages(detail),
                error: null,
            });
            void this.rememberConversation(doc.id, detail.id);
        } catch (err) {
            this.setState({ error: messageOf(err) });
        }
    }

    /** 重新拉取当前文档的会话列表（标题 / 更新时间会在首轮对话后变化） */
    async refreshConversations(): Promise<void> {
        const doc = this.ctx.documents.active();
        if (!doc) return;
        try {
            const conversations = await this.api.listConversations(doc.id);
            if (this.docId === doc.id) this.setState({ conversations });
        } catch {
            // 列表刷新失败不影响当前对话
        }
    }

    private rememberConversation(documentId: string, conversationId: string): Promise<void> {
        return this.ctx.storage
            .set(`lastConversation.${documentId}`, conversationId)
            .catch(() => undefined);
    }

    setModel(model: string): void {
        if (!this.state.config?.models.some((item) => item.id === model)) return;
        this.setState({ model });
        void this.ctx.storage.set('model', model).catch(() => undefined);
    }

    // ─────────────────────────── 发送 ───────────────────────────

    async send(text: string): Promise<void> {
        if (this.disposed) return;
        await this.ensureInitialized();

        const content = text.trim();
        if (
            this.disposed ||
            this.state.streaming ||
            !content ||
            !this.state.config?.enabled ||
            !this.state.conversationId
        ) {
            return;
        }

        const doc = this.ctx.documents.active();
        if (!doc) {
            this.setState({ error: '请先打开一个文档' });
            return;
        }

        this.aborted = false;
        this.setState({
            streaming: true,
            error: null,
            messages: [
                ...this.state.messages,
                {
                    id: newId(),
                    role: 'user',
                    text: content,
                    status: 'complete',
                    toolCalls: [],
                    createdAt: new Date().toISOString(),
                },
            ],
        });

        try {
            await this.runLoop({ type: 'user', text: content });
        } catch (err) {
            if (this.aborted || isAbortError(err)) {
                this.markLastStreaming('cancelled');
            } else {
                this.setState({ error: messageOf(err) });
                this.markLastStreaming('error');
            }
        } finally {
            this.abortController = null;
            this.setState({ streaming: false });
            // 首轮结束后服务端会自动给会话起标题，刷新一下历史列表
            void this.refreshConversations();
        }
    }

    async startPrompt(text: string): Promise<void> {
        await this.ensureInitialized();
        await this.send(text);
    }

    cancel(): void {
        this.aborted = true;
        this.abortController?.abort();
        this.abortController = null;

        const pending = this.pendingApproval;
        this.pendingApproval = null;
        pending?.resolve(false);

        this.setState({ streaming: false });
        this.markLastStreaming('cancelled');
    }

    approve(callId: string): void {
        this.resolveApproval(callId, true);
    }

    reject(callId: string): void {
        this.resolveApproval(callId, false);
    }

    /** 侧面板关闭：中止在途请求和待确认写入，但保留会话内容 */
    onPanelUnmounted(): void {
        if (this.state.streaming || this.pendingApproval) this.cancel();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.cancel();
        this.docDisposable?.dispose();
        this.docDisposable = null;
        this.listeners.clear();
    }

    // ─────────────────────────── Agent 循环 ───────────────────────────

    private async runLoop(firstInput: AiTurnInput): Promise<void> {
        const maxSteps = this.state.config?.limits.maxStepsPerConversation ?? 8;
        let input = firstInput;

        for (let step = 0; step < maxSteps; step++) {
            if (this.aborted) return;

            const assistantId = this.appendAssistantMessage();
            const outcome = await this.streamTurn(input, assistantId);

            if (this.aborted || outcome.finishReason === 'cancelled') {
                this.finishMessage(assistantId, 'cancelled');
                return;
            }
            if (outcome.finishReason === 'error' || outcome.error) {
                this.finishMessage(assistantId, 'error');
                if (outcome.error) this.setState({ error: outcome.error.message });
                return;
            }

            if (outcome.finishReason !== 'tool_calls' || outcome.toolCalls.length === 0) {
                this.finishMessage(assistantId, 'complete');
                return;
            }

            this.finishMessage(assistantId, 'complete');

            const results: AiToolResult[] = [];
            let rejected = false;
            for (const call of outcome.toolCalls) {
                if (this.aborted) return;
                const result = await this.executeToolCall(call, assistantId);
                results.push(result);

                if (
                    result.error?.code === 'USER_REJECTED' ||
                    result.error?.code === 'CANCELLED'
                ) {
                    rejected = true;
                    break;
                }
            }

            if (rejected || this.aborted) return;
            input = { type: 'tool_results', results };
        }

        this.setState({
            error: `工具调用步数超过上限（${maxSteps}），请重新提问`,
        });
    }

    private async streamTurn(input: AiTurnInput, messageId: string) {
        const doc = this.ctx.documents.active();
        const conversationId = this.state.conversationId;
        if (!doc || !conversationId) {
            throw new Error('文档或对话已关闭');
        }

        const context = await buildDocumentContext(doc, this.cellLimit());
        const controller = new AbortController();
        this.abortController = controller;

        try {
            return await this.api.streamTurn(
                conversationId,
                {
                    requestId: newId(),
                    input,
                    context,
                    tools: toolDefinitions(doc.canWrite),
                    model: this.state.model,
                },
                {
                    onText: (delta) => this.appendText(messageId, delta),
                    onToolCall: (call) => this.appendToolCall(messageId, call),
                    onUsage: () => undefined,
                    onTurnEnd: (event) => {
                        if (event.finishReason === 'error') {
                            this.setMessageStatus(messageId, 'error');
                        } else if (event.finishReason === 'cancelled') {
                            this.setMessageStatus(messageId, 'cancelled');
                        } else {
                            this.setMessageStatus(messageId, 'complete');
                        }
                    },
                    onError: (event) => {
                        this.setState({ error: event.message });
                        this.setMessageStatus(messageId, 'error');
                    },
                },
                controller.signal
            );
        } finally {
            if (this.abortController === controller) this.abortController = null;
        }
    }

    private async executeToolCall(
        call: AiToolCallEvent,
        messageId: string
    ): Promise<AiToolResult> {
        const doc = this.ctx.documents.active();
        if (!doc) {
            return this.toolFailure(
                call,
                messageId,
                'NO_DOCUMENT',
                '文档已关闭'
            );
        }

        const handler = getTool(call.name);
        if (!handler) {
            return this.toolFailure(
                call,
                messageId,
                'UNKNOWN_TOOL',
                `未知工具：${call.name}`
            );
        }

        const args = asArgs(call.arguments);
        this.updateToolCall(messageId, call.id, { status: 'running' });

        const context = {
            doc,
            ctx: this.ctx,
            signal: this.abortController?.signal ?? new AbortController().signal,
        };

        try {
            if (handler.kind === 'write') {
                if (!handler.prepare) {
                    throw new ToolError('TOOL_ERROR', '写工具缺少 prepare 实现');
                }
                if (!doc.canWrite) {
                    throw new ToolError('E_PLUGIN_READ_ONLY', '当前文档只读，无法写入');
                }

                const plan = await handler.prepare(args, context);
                this.updateToolCall(messageId, call.id, {
                    status: this.autoApply() ? 'running' : 'awaiting-approval',
                    summary: plan.summary,
                    diff: plan.diff,
                    plan,
                });

                if (!this.autoApply()) {
                    const approved = await this.waitForApproval(call.id);
                    if (!approved) {
                        this.updateToolCall(messageId, call.id, {
                            status: 'rejected',
                            error: '用户取消了这次修改',
                        });
                        return {
                            toolCallId: call.id,
                            name: call.name,
                            ok: false,
                            error: {
                                code: 'USER_REJECTED',
                                message: '用户取消了这次修改，请询问下一步',
                            },
                        };
                    }
                }

                this.updateToolCall(messageId, call.id, { status: 'running' });
                const result = await plan.apply();
                this.updateToolCall(messageId, call.id, {
                    status: 'done',
                    resultPreview: previewJson(result),
                });
                return { toolCallId: call.id, name: call.name, ok: true, result };
            }

            if (!handler.run) {
                throw new ToolError('TOOL_ERROR', '读工具缺少 run 实现');
            }
            const result = await handler.run(args, context);
            this.updateToolCall(messageId, call.id, {
                status: 'done',
                resultPreview: previewJson(result),
            });
            return { toolCallId: call.id, name: call.name, ok: true, result };
        } catch (err) {
            const { code, message } = describeToolError(err);
            this.updateToolCall(messageId, call.id, {
                status: code === 'CANCELLED' ? 'rejected' : 'error',
                error: message,
            });
            return {
                toolCallId: call.id,
                name: call.name,
                ok: false,
                error: { code, message },
            };
        }
    }

    private toolFailure(
        call: AiToolCallEvent,
        messageId: string,
        code: string,
        message: string
    ): AiToolResult {
        this.updateToolCall(messageId, call.id, { status: 'error', error: message });
        return {
            toolCallId: call.id,
            name: call.name,
            ok: false,
            error: { code, message },
        };
    }

    private waitForApproval(callId: string): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.pendingApproval = { callId, resolve };
        });
    }

    private resolveApproval(callId: string, approved: boolean): void {
        const pending = this.pendingApproval;
        if (!pending || pending.callId !== callId) return;
        this.pendingApproval = null;
        pending.resolve(approved);
    }

    // ─────────────────────────── 状态 ───────────────────────────

    private bindDocument(doc: SheetDocumentApi): void {
        this.docDisposable?.dispose();
        this.docDisposable = doc.onDidChangeSelection(() => this.refreshSelectionLabel(doc));
        this.refreshSelectionLabel(doc);
    }

    private handleDocumentClosed(): void {
        this.cancel();
        this.docDisposable?.dispose();
        this.docDisposable = null;
        this.initialization = null;
        this.docId = null;
        this.initialized = false;
        this.setState({
            ...createInitialState(),
            initialized: true,
            autoApply: this.autoApply(),
        });
    }

    private refreshSelectionLabel(doc: SheetDocumentApi): void {
        try {
            const selection = doc.getSelection();
            const sheets = doc.getSheetInfo();
            const activeId = doc.getActiveSheetId();
            const sheet = sheets.find((item) => item.id === activeId);
            const address = selection.ranges[0]
                ? toA1(selection.ranges[0])
                : toA1Cell(selection.active.row, selection.active.column);
            const label = sheet ? `${sheet.name} · ${address}` : address;
            if (label !== this.state.selectionLabel) this.setState({ selectionLabel: label });
        } catch {
            // 文档关闭过程中的瞬时错误，忽略
        }
    }

    private autoApply(): boolean {
        return this.ctx.settings.get<boolean>('autoApply') === true;
    }

    private cellLimit(): number {
        const value = this.ctx.settings.get<number>('contextCellLimit');
        const limit = typeof value === 'number' ? value : DEFAULT_CELL_LIMIT;
        return Math.max(100, Math.min(MAX_CELL_LIMIT, Math.floor(limit)));
    }

    private appendAssistantMessage(): string {
        const id = newId();
        this.setState({
            messages: [
                ...this.state.messages,
                {
                    id,
                    role: 'assistant',
                    text: '',
                    status: 'streaming',
                    toolCalls: [],
                    createdAt: new Date().toISOString(),
                },
            ],
        });
        return id;
    }

    private appendText(messageId: string, delta: string): void {
        this.updateMessage(messageId, (message) => ({
            ...message,
            text: message.text + delta,
        }));
    }

    private appendToolCall(messageId: string, call: AiToolCallEvent): void {
        this.updateMessage(messageId, (message) => ({
            ...message,
            toolCalls: [
                ...message.toolCalls,
                {
                    id: call.id,
                    name: call.name,
                    args: call.arguments,
                    status: 'pending',
                },
            ],
        }));
    }

    private updateToolCall(
        messageId: string,
        callId: string,
        patch: Partial<UiToolCall>
    ): void {
        this.updateMessage(messageId, (message) => ({
            ...message,
            toolCalls: message.toolCalls.map((call) =>
                call.id === callId ? { ...call, ...patch } : call
            ),
        }));
    }

    private setMessageStatus(
        messageId: string,
        status: UiMessage['status']
    ): void {
        this.updateMessage(messageId, (message) => ({ ...message, status }));
    }

    private finishMessage(messageId: string, status: UiMessage['status']): void {
        this.setMessageStatus(messageId, status);
    }

    private markLastStreaming(status: UiMessage['status']): void {
        const index = [...this.state.messages]
            .reverse()
            .findIndex((message) => message.role === 'assistant' && message.status === 'streaming');
        if (index < 0) return;
        const target = this.state.messages[this.state.messages.length - 1 - index];
        this.setMessageStatus(target.id, status);
    }

    private updateMessage(
        messageId: string,
        updater: (message: UiMessage) => UiMessage
    ): void {
        const messages = this.state.messages.map((message) =>
            message.id === messageId ? updater(message) : message
        );
        this.setState({ messages });
    }

    private setState(patch: Partial<AgentSnapshot>): void {
        this.state = { ...this.state, ...patch };
        this.emit();
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch {
                // 订阅者异常不能反过来影响控制器
            }
        }
    }
}

// ─────────────────────────── 辅助 ───────────────────────────

function createInitialState(): AgentSnapshot {
    return {
        initialized: false,
        loading: false,
        document: null,
        config: null,
        model: '',
        conversationId: null,
        conversations: [],
        messages: [],
        streaming: false,
        error: null,
        selectionLabel: '',
        autoApply: false,
    };
}

function restoreMessages(detail: { messages: AiMessageDto[] }): UiMessage[] {
    const toolResults = new Map<
        string,
        { ok: boolean; content: string }
    >();
    for (const message of detail.messages) {
        for (const block of message.blocks) {
            if (block.type === 'tool_result') {
                toolResults.set(block.toolUseId, {
                    ok: block.ok,
                    content: block.content,
                });
            }
        }
    }

    const restored: UiMessage[] = [];
    for (const message of detail.messages) {
        const text = message.blocks
            .filter((block): block is Extract<AiContentBlock, { type: 'text' }> => block.type === 'text')
            .map((block) => block.text)
            .join('\n');

        if (message.role === 'assistant') {
            const toolCalls: UiToolCall[] = message.blocks
                .filter(
                    (block): block is Extract<AiContentBlock, { type: 'tool_use' }> =>
                        block.type === 'tool_use'
                )
                .map((block) => {
                    const result = toolResults.get(block.id);
                    return {
                        id: block.id,
                        name: block.name,
                        args: block.input,
                        status: result ? (result.ok ? 'done' : 'error') : 'pending',
                        resultPreview: result ? truncate(result.content, 1_500) : undefined,
                        error:
                            result && !result.ok
                                ? truncate(result.content, 1_500)
                                : undefined,
                    } satisfies UiToolCall;
                });

            if (text || toolCalls.length > 0) {
                restored.push({
                    id: message.id,
                    role: 'assistant',
                    text,
                    status: 'complete',
                    toolCalls,
                    createdAt: message.createdAt,
                });
            }
            continue;
        }

        if (text) {
            restored.push({
                id: message.id,
                role: 'user',
                text,
                status: 'complete',
                toolCalls: [],
                createdAt: message.createdAt,
            });
        }
    }

    return restored;
}

function asArgs(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function previewJson(value: unknown): string {
    try {
        return truncate(JSON.stringify(value) ?? '', 1_500);
    } catch {
        return String(value);
    }
}

function truncate(text: string, maxLength: number): string {
    return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function describeToolError(err: unknown): { code: string; message: string } {
    if (err instanceof ToolError) return { code: err.code, message: err.message };
    if (err instanceof AiApiError) return { code: err.code, message: err.message };
    if (isAbortError(err)) return { code: 'CANCELLED', message: '已取消' };
    return {
        code: 'TOOL_ERROR',
        message: err instanceof Error ? err.message : '工具执行失败',
    };
}

function messageOf(err: unknown): string {
    if (err instanceof AiApiError) return err.message;
    if (err instanceof Error) return err.message;
    return String(err);
}

function isAbortError(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        (err as { name?: string }).name === 'AbortError'
    );
}

function newId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
