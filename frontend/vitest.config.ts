import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

/**
 * 测试继承应用构建配置（TS / 路径解析），只额外加 Node 环境垫片。
 * 单独放 vitest.config.ts，避免把 test 配置混进生产构建配置。
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      setupFiles: ['./test/setup.ts'],
    },
  })
);
