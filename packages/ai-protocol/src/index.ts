/**
 * AI 助手协议 —— 后端网关与浏览器插件共用的唯一真源。
 *
 * 约束：
 *   - 只放纯类型和常量，不依赖 DOM / Node / React；
 *   - 所有跨进程数据都是普通 JSON（沙箱 / RPC 可以直接复用）；
 *   - A1 记法（`Sheet1!A1:C10`）是工具层的对外地址格式。
 */

// ─────────────────────────── 工具 ───────────────────────────

export interface AiToolDefinition {
  /** `^[a-z][a-z0-9_]{0,63}$`，前后端都校验 */
  name: string;
  description: string;
  /** JSON Schema（type: object） */
  parameters: Record<string, unknown>;
}

export interface AiToolError {
  code: string;
  message: string;
}

/** 工具执行结果。result 必须是可 JSON 序列化的值，体积由宿主截断 */
export interface AiToolResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  result?: unknown;
  error?: AiToolError;
}

// ─────────────────────────── 消息 / 内容块 ───────────────────────────

export type AiRole = 'user' | 'assistant';

export type AiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; ok: boolean; content: string };

export type AiMessageStatus = 'complete' | 'streaming' | 'cancelled' | 'error' | 'interrupted';

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}

export interface AiMessageDto {
  id: string;
  role: AiRole;
  blocks: AiContentBlock[];
  status: AiMessageStatus;
  createdAt: string;
  usage?: AiUsage;
}

// ─────────────────────────── 文档上下文 ───────────────────────────

export interface AiSheetContext {
  id: string;
  name: string;
  hidden: boolean;
  rowCount: number;
  columnCount: number;
  /** 有效区域的 A1 地址，如 `A1:C30`；空表为 null */
  usedRange: string | null;
}

export interface AiSelectionRangeContext {
  /** A1 地址，如 `A1:C10` */
  address: string;
  rows: number;
  columns: number;
}

/**
 * 客户端每轮提交的文档上下文。
 *
 * 服务端不做字段级校验（只限制序列化后的总长度），
 * 因为它是给模型的提示数据，不是业务真源。
 */
export interface AiDocumentContext {
  documentId: string;
  title: string;
  activeSheet: { id: string; name: string };
  sheets: AiSheetContext[];
  selection: {
    /** 活动单元格 A1 地址 */
    active: string;
    ranges: AiSelectionRangeContext[];
    /** 选区预览（受客户端预算裁剪）；null 表示没有预览 */
    preview: (string | number | boolean | null)[][] | null;
    previewAddress: string | null;
    truncated: boolean;
  };
  capabilities: { canWrite: boolean };
}

// ─────────────────────────── 请求 / 响应 ───────────────────────────

export interface AiTurnUserInput {
  type: 'user';
  text: string;
}

export interface AiTurnToolResultsInput {
  type: 'tool_results';
  results: AiToolResult[];
}

export type AiTurnInput = AiTurnUserInput | AiTurnToolResultsInput;

export interface AiTurnRequest {
  /** 客户端生成，用于日志与去重；同一轮重试应保持不变 */
  requestId: string;
  input: AiTurnInput;
  context: AiDocumentContext;
  tools: AiToolDefinition[];
  /** 不传则用服务端默认模型 */
  model?: string;
}

export interface AiModelInfo {
  id: string;
  label: string;
  contextWindow?: number;
}

export interface AiLimits {
  maxOutputTokens: number;
  maxToolCallsPerTurn: number;
  maxContextChars: number;
  dailyTokenLimit: number;
  /** 一次用户提问最多允许连续多少轮工具调用 */
  maxStepsPerConversation: number;
}

export interface AiConfigResponse {
  enabled: boolean;
  /** 服务端不可用原因（仅用于展示，不包含密钥） */
  reason?: string;
  defaultModel: string;
  models: AiModelInfo[];
  limits: AiLimits;
}

export interface AiConversationSummary {
  id: string;
  title: string;
  documentId: string | null;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiConversationDetail extends AiConversationSummary {
  messages: AiMessageDto[];
}

// ─────────────────────────── SSE ───────────────────────────

export const AI_SSE = {
  turnStart: 'turn_start',
  textDelta: 'text_delta',
  toolCall: 'tool_call',
  usage: 'usage',
  turnEnd: 'turn_end',
  error: 'error',
} as const;

export type AiSseEventName = (typeof AI_SSE)[keyof typeof AI_SSE];

export type AiFinishReason = 'stop' | 'tool_calls' | 'length' | 'cancelled' | 'error';

export interface AiTurnStartEvent {
  turnId: string;
  model: string;
}

export interface AiTextDeltaEvent {
  delta: string;
}

export interface AiToolCallEvent {
  id: string;
  name: string;
  arguments: unknown;
}

export type AiUsageEvent = AiUsage;

export interface AiTurnEndEvent {
  turnId: string;
  finishReason: AiFinishReason;
}

export interface AiErrorEvent {
  code: string;
  message: string;
  retryable: boolean;
}

/** 服务端事件名 → payload 类型。客户端解析时用它做类型收窄 */
export interface AiSsePayloads {
  turn_start: AiTurnStartEvent;
  text_delta: AiTextDeltaEvent;
  tool_call: AiToolCallEvent;
  usage: AiUsageEvent;
  turn_end: AiTurnEndEvent;
  error: AiErrorEvent;
}

// ─────────────────────────── 工具限制 ───────────────────────────

export const AI_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** 单次请求最多带多少工具定义 */
export const AI_MAX_TOOLS = 32;
/** 工具定义 JSON 序列化后的总长度上限 */
export const AI_MAX_TOOLS_CHARS = 64 * 1024;
/** 单条用户消息长度上限 */
export const AI_MAX_USER_TEXT_CHARS = 32_000;
/** 单次工具结果序列化后的长度上限；超出由客户端/服务端截断 */
export const AI_MAX_TOOL_RESULT_CHARS = 32 * 1024;
