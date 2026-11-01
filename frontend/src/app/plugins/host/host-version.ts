/**
 * 宿主平台版本。
 *
 * 用于校验 manifest 的 engines.pgclouddoc。宿主 API 版本则是 PLUGIN_API_VERSION，
 * 两者独立演进：平台可以有 1.4.0 / 1.5.0，API 仍然保持主版本 1。
 */
export const HOST_VERSION = '1.0.0';
