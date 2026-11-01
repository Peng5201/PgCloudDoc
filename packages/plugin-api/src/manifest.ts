/**
 * 插件清单（plugin.json）。
 *
 * 这里是**唯一真源**：前端宿主、后端上传校验、插件构建脚本都使用同一份 schema。
 * 字段语义见 plugins/plugin-system-design.md 第 3 节。
 */

import { z } from 'zod';
import {
  ACTIVATION_EVENT_PATTERN,
  COMMAND_ID_PATTERN,
  MANIFEST_VERSION,
  MENU_IDS,
  PANEL_SLOTS,
  PLUGIN_API_VERSION,
  PLUGIN_ID_PATTERN,
  PLUGIN_PERMISSIONS,
  RELATIVE_PATH_PATTERN,
  SEMVER_PATTERN,
  STATUS_BAR_SLOTS,
  TOOLBAR_SLOTS,
} from './constants.js';

const commandContributionSchema = z.object({
  id: z.string().regex(COMMAND_ID_PATTERN, '命令 id 只能包含字母、数字、点、下划线、短横线'),
  title: z.string().min(1).max(80),
  icon: z.string().regex(RELATIVE_PATH_PATTERN, 'icon 必须是插件包内相对路径').optional(),
  category: z.string().max(40).optional(),
});

const toolbarContributionSchema = z.object({
  slot: z.enum(TOOLBAR_SLOTS),
  command: z.string().regex(COMMAND_ID_PATTERN),
  title: z.string().min(1).max(80).optional(),
  icon: z.string().regex(RELATIVE_PATH_PATTERN).optional(),
  order: z.number().int().min(-1000).max(1000).optional(),
  /** 文档只读时宿主会自动禁用 */
  requiresWrite: z.boolean().optional(),
});

const statusBarContributionSchema = z.object({
  slot: z.enum(STATUS_BAR_SLOTS),
  command: z.string().regex(COMMAND_ID_PATTERN),
  title: z.string().min(1).max(80).optional(),
  icon: z.string().regex(RELATIVE_PATH_PATTERN).optional(),
  order: z.number().int().min(-1000).max(1000).optional(),
  requiresWrite: z.boolean().optional(),
});

const menuContributionSchema = z.object({
  menu: z.enum(MENU_IDS),
  command: z.string().regex(COMMAND_ID_PATTERN),
  title: z.string().min(1).max(80).optional(),
  icon: z.string().regex(RELATIVE_PATH_PATTERN).optional(),
  group: z.string().max(40).optional(),
  order: z.number().int().min(-1000).max(1000).optional(),
});

const panelContributionSchema = z.object({
  id: z.string().regex(COMMAND_ID_PATTERN),
  title: z.string().min(1).max(80),
  slot: z.enum(PANEL_SLOTS),
  icon: z.string().regex(RELATIVE_PATH_PATTERN).optional(),
});

const contributesSchema = z.object({
  commands: z.array(commandContributionSchema).max(100).optional(),
  toolbar: z.array(toolbarContributionSchema).max(50).optional(),
  statusBar: z.array(statusBarContributionSchema).max(20).optional(),
  menus: z.array(menuContributionSchema).max(50).optional(),
  panels: z.array(panelContributionSchema).max(20).optional(),
});

const settingBase = z.object({
  key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, '设置 key 不合法'),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  /** client 随索引下发；server 只留在服务端，永不下发给浏览器 */
  scope: z.enum(['client', 'server']).default('client'),
});

const settingSchema = z.discriminatedUnion('type', [
  settingBase.extend({
    type: z.literal('string'),
    default: z.string().optional(),
    placeholder: z.string().max(200).optional(),
  }),
  settingBase.extend({
    type: z.literal('number'),
    default: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  settingBase.extend({
    type: z.literal('boolean'),
    default: z.boolean().optional(),
  }),
  settingBase.extend({
    type: z.literal('enum'),
    enum: z.array(z.string().min(1)).min(1).max(50),
    default: z.string().optional(),
  }),
]);

export const pluginManifestSchema = z
  .object({
    manifestVersion: z.literal(MANIFEST_VERSION),
    id: z.string().regex(PLUGIN_ID_PATTERN, 'id 必须是反向域名（小写，如 com.example.tools）'),
    name: z.string().min(1).max(80),
    version: z.string().regex(SEMVER_PATTERN, 'version 必须是 semver（如 1.0.0）'),
    description: z.string().max(500).optional(),
    author: z.string().max(120).optional(),
    homepage: z.string().max(2048).optional(),
    entry: z.string().regex(RELATIVE_PATH_PATTERN, 'entry 必须是插件包内相对路径'),
    style: z.string().regex(RELATIVE_PATH_PATTERN).optional(),
    icon: z.string().regex(RELATIVE_PATH_PATTERN).optional(),
    engines: z.object({
      pgclouddoc: z.string().min(1).max(64),
      pluginApi: z.literal(PLUGIN_API_VERSION),
    }),
    activationEvents: z
      .array(z.string().regex(ACTIVATION_EVENT_PATTERN, 'activationEvents 含不合法事件'))
      .max(50)
      .default([]),
    contributes: contributesSchema.optional(),
    permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(20).default([]),
    settings: z.array(settingSchema).max(50).default([]),
  })
  .superRefine((manifest, ctx) => {
    const commands = new Set<string>();
    for (const [index, command] of (manifest.contributes?.commands ?? []).entries()) {
      if (commands.has(command.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `命令 ${command.id} 重复声明`,
          path: ['contributes', 'commands', index, 'id'],
        });
      }
      commands.add(command.id);
    }

    const requireDeclared = (commandId: string, path: (string | number)[]) => {
      if (!commands.has(commandId)) {
        ctx.addIssue({
          code: 'custom',
          message: `命令 ${commandId} 未在 contributes.commands 中声明`,
          path,
        });
      }
    };

    (manifest.contributes?.toolbar ?? []).forEach((item, index) =>
      requireDeclared(item.command, ['contributes', 'toolbar', index, 'command'])
    );
    (manifest.contributes?.statusBar ?? []).forEach((item, index) =>
      requireDeclared(item.command, ['contributes', 'statusBar', index, 'command'])
    );
    (manifest.contributes?.menus ?? []).forEach((item, index) =>
      requireDeclared(item.command, ['contributes', 'menus', index, 'command'])
    );

    for (const [index, event] of manifest.activationEvents.entries()) {
      if (event.startsWith('onCommand:')) {
        requireDeclared(event.slice('onCommand:'.length), ['activationEvents', index]);
      }
    }

    const settingKeys = new Set<string>();
    for (const [index, setting] of manifest.settings.entries()) {
      if (settingKeys.has(setting.key)) {
        ctx.addIssue({
          code: 'custom',
          message: `设置 ${setting.key} 重复声明`,
          path: ['settings', index, 'key'],
        });
      }
      settingKeys.add(setting.key);
    }
  });

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginContributions = NonNullable<PluginManifest['contributes']>;
export type PluginSettingSchema = PluginManifest['settings'][number];

/** 解析并校验 manifest；失败时抛带路径的可读错误（服务端直接转 422） */
export function parseManifest(input: unknown): PluginManifest {
  const result = pluginManifestSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('；');
    throw new Error(`plugin.json 校验失败：${details}`);
  }
  return result.data;
}
