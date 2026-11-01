import { definePluginConfig } from '../vite.plugin.config';

// csv-tools 默认占用 5174，这里用 5175，两个插件可以同时开发
export default definePluginConfig({ port: 5175 });
