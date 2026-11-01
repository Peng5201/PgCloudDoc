/**
 * 协议常量与枚举。
 *
 * 刻意和 manifest schema 分开：宿主只做运行时校验时可以从
 * `@pgclouddoc/plugin-api/constants` 引用，不必把 zod 打进前端 bundle。
 */

export const PLUGIN_API_VERSION = '1' as const;
export const MANIFEST_VERSION = 1 as const;

export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/;
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/;
/** 相对路径：不允许绝对路径、..、反斜杠 */
export const RELATIVE_PATH_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*$/;

export const PLUGIN_PERMISSIONS = [
  'document:read',
  'document:write',
  'document:structural',
  'storage',
  'clipboard:write',
  'notifications',
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** 工具栏/标题栏共用同一套插槽（都渲染成图标按钮） */
export const TOOLBAR_SLOTS = [
  'editor.titleBar.start',
  'editor.titleBar.end',
  'sheet.toolbar.start',
  'sheet.toolbar.end',
] as const;

export type ToolbarSlot = (typeof TOOLBAR_SLOTS)[number];

export const STATUS_BAR_SLOTS = ['sheet.statusBar.start', 'sheet.statusBar.end'] as const;

export type StatusBarSlot = (typeof STATUS_BAR_SLOTS)[number];

export const MENU_IDS = ['sheet.contextMenu', 'editor.more'] as const;

export type MenuId = (typeof MENU_IDS)[number];

export const PANEL_SLOTS = ['editor.sidebar'] as const;

export type PanelSlot = (typeof PANEL_SLOTS)[number];

export type ActivationEvent =
  | 'onStartup'
  | 'onDocumentOpen'
  | 'onDocumentOpen:sheet'
  | `onCommand:${string}`
  | `onView:${string}`;

export const ACTIVATION_EVENT_PATTERN =
  /^(onStartup|onDocumentOpen|onDocumentOpen:sheet|onCommand:[A-Za-z0-9][A-Za-z0-9._-]{1,127}|onView:[A-Za-z0-9][A-Za-z0-9._-]{1,127})$/;
