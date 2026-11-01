/**
 * 插件 API 错误。
 *
 * 插件拿到的错误必须可编程判断（按 `code` 分支），而不是靠字符串匹配。
 */
export type PluginApiErrorCode =
  | 'E_PLUGIN_READ_ONLY'
  | 'E_PLUGIN_PERMISSION'
  | 'E_PLUGIN_RANGE_TOO_LARGE'
  | 'E_PLUGIN_INVALID_RANGE'
  | 'E_PLUGIN_INVALID_INPUT'
  | 'E_PLUGIN_NO_DOCUMENT'
  | 'E_PLUGIN_DISPOSED'
  | 'E_PLUGIN_COMMAND_NOT_FOUND'
  | 'E_PLUGIN_COMMAND_DUPLICATE'
  | 'E_PLUGIN_STORAGE_QUOTA';

export class PluginApiError extends Error {
  readonly code: PluginApiErrorCode;

  constructor(code: PluginApiErrorCode, message: string) {
    super(message);
    this.name = 'PluginApiError';
    this.code = code;
  }
}
