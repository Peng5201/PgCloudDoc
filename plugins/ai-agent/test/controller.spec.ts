/**
 * AgentController 的会话生命周期：
 *   - 首次加载拉取会话列表，默认选最近更新的一条；
 *   - 优先恢复 storage 里记住的会话；
 *   - 切换历史会话会加载对应消息并更新 storage。
 *
 * 用最小 fake PluginContext，不依赖浏览器。
 */

import { describe, expect, it } from 'vitest';
import type { PluginContext, SheetDocumentApi } from '@pgclouddoc/plugin-api';
import { AgentController } from '../src/controller';

interface ConversationFixture {
    id: string;
    title: string;
    updatedAt: string;
    message: string;
}

const CONVERSATIONS: ConversationFixture[] = [
    {
        id: 'conv-1',
        title: '最近的对话',
        updatedAt: '2026-11-01T12:00:00.000Z',
        message: '你好',
    },
    {
        id: 'conv-2',
        title: '旧对话',
        updatedAt: '2026-10-31T12:00:00.000Z',
        message: '旧对话内容',
    },
];

function summary(item: ConversationFixture) {
    return {
        id: item.id,
        title: item.title,
        documentId: 'doc-1',
        model: 'deepseek-v4-flash',
        createdAt: '2026-10-31T00:00:00.000Z',
        updatedAt: item.updatedAt,
    };
}

function detail(item: ConversationFixture) {
    return {
        ...summary(item),
        messages: [
            {
                id: `${item.id}-m1`,
                role: 'user' as const,
                blocks: [{ type: 'text' as const, text: item.message }],
                status: 'complete' as const,
                createdAt: item.updatedAt,
            },
        ],
    };
}

function jsonResponse(data: unknown): Response {
    return new Response(JSON.stringify({ success: true, data, requestId: 'test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function createContext(options: {
    conversations?: ConversationFixture[];
    store?: Map<string, unknown>;
} = {}) {
    const conversations = options.conversations ?? CONVERSATIONS;
    const store = options.store ?? new Map<string, unknown>();

    const document = {
        id: 'doc-1',
        title: '测试文档',
        type: 'sheet',
        readOnly: false,
        canWrite: true,
        getSelection: () => ({
            active: { row: 0, column: 0 },
            ranges: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }],
        }),
        getSheetInfo: () => [
            {
                id: 'sheet1',
                name: 'Sheet1',
                hidden: false,
                rowCount: 100,
                columnCount: 26,
                usedRange: null,
            },
        ],
        getActiveSheetId: () => 'sheet1',
        onDidChangeSelection: () => ({ dispose: () => undefined }),
    } as unknown as SheetDocumentApi;

    const fetchCalls: string[] = [];
    const net = {
        async fetch(path: string): Promise<Response> {
            fetchCalls.push(path);

            if (path === '/api/v1/ai/config') {
                return jsonResponse({
                    enabled: true,
                    defaultModel: 'deepseek-v4-flash',
                    models: [{ id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' }],
                    limits: {
                        maxOutputTokens: 4096,
                        maxToolCallsPerTurn: 8,
                        maxContextChars: 60000,
                        dailyTokenLimit: 200000,
                        maxStepsPerConversation: 20,
                    },
                });
            }
            if (path.startsWith('/api/v1/ai/conversations?')) {
                return jsonResponse(conversations.map(summary));
            }

            const match = /^\/api\/v1\/ai\/conversations\/([^/]+)$/.exec(path);
            if (match) {
                const item =
                    conversations.find((conversation) => conversation.id === match[1]) ??
                    conversations[0];
                return jsonResponse(detail(item));
            }

            throw new Error(`unexpected request: ${path}`);
        },
    };

    const context = {
        pluginId: 'com.test.ai',
        pluginVersion: '1.0.0',
        hostVersion: '1.0.0',
        apiVersion: '1',
        logger: {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
        },
        commands: {
            register: () => ({ dispose: () => undefined }),
            execute: async () => undefined,
        },
        documents: {
            active: () => document,
            onDidOpen: () => ({ dispose: () => undefined }),
            onDidClose: () => ({ dispose: () => undefined }),
        },
        ui: {
            registerPanel: () => ({ dispose: () => undefined }),
            registerToolbarItem: () => ({ dispose: () => undefined }),
            registerStatusBarItem: () => ({ dispose: () => undefined }),
            registerMenuItem: () => ({ dispose: () => undefined }),
            showPanel: () => undefined,
            hidePanel: () => undefined,
            isPanelVisible: () => false,
            showMessage: () => undefined,
        },
        settings: {
            get: (key: string) => (key === 'autoApply' ? false : 2000),
            onChange: () => ({ dispose: () => undefined }),
        },
        storage: {
            get: async (key: string) => (store.has(key) ? store.get(key) : null),
            set: async (key: string, value: unknown) => {
                store.set(key, value);
            },
            delete: async (key: string) => {
                store.delete(key);
            },
            keys: async () => [...store.keys()],
        },
        net,
        subscriptions: [],
        hasPermission: () => true,
    } as unknown as PluginContext;

    return { context, store, fetchCalls };
}

describe('AgentController 历史会话', () => {
    it('首次加载选最近一条，并把选择记进 storage', async () => {
        const { context, store } = createContext();
        const controller = new AgentController(context);

        try {
            await controller.ensureInitialized();
            const state = controller.getSnapshot();

            expect(state.conversations.map((item) => item.id)).toEqual(['conv-1', 'conv-2']);
            expect(state.conversationId).toBe('conv-1');
            expect(state.messages[0]?.text).toBe('你好');
            expect(store.get('lastConversation.doc-1')).toBe('conv-1');
        } finally {
            controller.dispose();
        }
    });

    it('优先恢复 storage 里记住的会话', async () => {
        const store = new Map<string, unknown>([['lastConversation.doc-1', 'conv-2']]);
        const { context } = createContext({ store });
        const controller = new AgentController(context);

        try {
            await controller.ensureInitialized();
            expect(controller.getSnapshot().conversationId).toBe('conv-2');
            expect(controller.getSnapshot().messages[0]?.text).toBe('旧对话内容');
        } finally {
            controller.dispose();
        }
    });

    it('切换历史会话会加载对应消息并更新 storage', async () => {
        const { context, store } = createContext();
        const controller = new AgentController(context);

        try {
            await controller.ensureInitialized();
            await controller.openConversation('conv-2');

            const state = controller.getSnapshot();
            expect(state.conversationId).toBe('conv-2');
            expect(state.messages[0]?.text).toBe('旧对话内容');
            expect(store.get('lastConversation.doc-1')).toBe('conv-2');
        } finally {
            controller.dispose();
        }
    });
});
