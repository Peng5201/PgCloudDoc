/**
 * 插件本地开发服务器（Vite）。
 *
 * 开发时不做打包：宿主从 `http://localhost:5174/plugin.dev.json` 拿 manifest，
 * 直接 import `/src/index.ts`。Vite 负责 TS 转换与 HMR。
 *
 * `/plugin.dev.json` 是开发专用的 manifest：把 entry 改成 src/index.ts、去掉
 * style（开发态 CSS 由 Vite 注入），其余字段与 plugin.json 完全一致。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const DEV_MANIFEST_PATH = '/plugin.dev.json';

function devManifestPlugin(): Plugin {
  return {
    name: 'pgclouddoc-plugin-dev-manifest',
    configureServer(server) {
      server.middlewares.use(DEV_MANIFEST_PATH, (_req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Access-Control-Allow-Origin', '*');
        try {
          const manifest = JSON.parse(
            readFileSync(resolve(server.config.root, 'plugin.json'), 'utf8')
          ) as Record<string, unknown>;
          const devManifest: Record<string, unknown> = { ...manifest, entry: 'src/index.ts' };
          delete devManifest.style;
          res.statusCode = 200;
          res.end(JSON.stringify(devManifest));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

/** 插件 vite.config.ts 统一调用：definePluginConfig({ port }) */
export function definePluginConfig(options: { port?: number } = {}) {
  return defineConfig({
    // 插件不能依赖宿主 React（没有 import map），需要组件时内置 Preact。
    // 全局配置成 automatic 模式，.tsx 直接写 JSX 即可。
    esbuild: {
      jsx: 'automatic',
      jsxImportSource: 'preact',
    },
    server: {
      port: options.port ?? 5174,
      strictPort: true,
      cors: true,
      headers: { 'Access-Control-Allow-Origin': '*' },
    },
    plugins: [devManifestPlugin()],
    build: {
      target: 'es2022',
      outDir: 'dist',
      emptyOutDir: true,
      lib: {
        entry: resolve(process.cwd(), 'src/index.ts'),
        formats: ['es'],
        fileName: () => 'main.js',
      },
      // 宿主共享依赖：插件产物里绝不能出现第二份 React/antd
      rollupOptions: {
        external: [
          'react',
          'react-dom',
          'react/jsx-runtime',
          'react-dom/client',
          'antd',
          '@pgclouddoc/plugin-api',
        ],
      },
      sourcemap: true,
    },
  });
}
