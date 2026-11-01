#!/usr/bin/env node
/**
 * 插件构建与打包。
 *
 *   pnpm build:plugin                      # 仓库根目录，构建 csv-tools
 *   node scripts/build-plugin.mjs csv-tools
 *   cd plugins/csv-tools && node ../scripts/build-plugin.mjs
 *
 * 产物：
 *   <plugin>/dist/                       Vite 输出的 ESM
 *   <plugin>/release/<id>-<version>.zip  plugin.json + dist
 *   <plugin>/release/<id>-<version>.json 元数据（zip 哈希 + 每个文件哈希）
 *
 * zip 里的结构就是服务端解包后的结构，前端不会拿到 zip。
 */

import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import { build } from 'vite';
import { parseManifest } from '@pgclouddoc/plugin-api';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGINS_ROOT = resolve(SCRIPT_DIR, '..');

const pluginDir = resolve(process.cwd(), process.argv[2] ?? '.');
if (!existsSync(join(pluginDir, 'plugin.json'))) {
  console.error(`[build-plugin] 找不到 ${join(pluginDir, 'plugin.json')}`);
  process.exit(1);
}

const manifestPath = join(pluginDir, 'plugin.json');
const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
const distDir = join(pluginDir, 'dist');
const releaseDir = join(pluginDir, 'release');
const zipName = `${manifest.id}-${manifest.version}.zip`;
const zipPath = join(releaseDir, zipName);

if (!manifest.entry.startsWith('dist/')) {
  console.error('[build-plugin] manifest.entry 必须位于 dist/ 下（zip 只包含 dist/）');
  process.exit(1);
}

console.log(`[build-plugin] ${manifest.id}@${manifest.version} (${relative(PLUGINS_ROOT, pluginDir)})`);

rmSync(distDir, { recursive: true, force: true });

await build({
  root: pluginDir,
  configFile: false,
  logLevel: 'warn',
  // 插件内置 Preact 时使用 automatic JSX；不依赖宿主 React 运行时
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: resolve(pluginDir, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'main.js',
    },
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

if (!existsSync(join(pluginDir, manifest.entry))) {
  console.error(`[build-plugin] 构建产物缺少入口：${manifest.entry}`);
  process.exit(1);
}

mkdirSync(releaseDir, { recursive: true });
await createZip(zipPath, manifestPath, distDir);

const zipSha256 = await hashFile(zipPath);
const files = walk(distDir).map((absolutePath) => ({
  path: relative(pluginDir, absolutePath).split(sep).join('/'),
  sha256: hashFileSync(absolutePath),
  bytes: statSync(absolutePath).size,
}));

const metadata = {
  id: manifest.id,
  version: manifest.version,
  sha256: zipSha256,
  zipBytes: statSync(zipPath).size,
  builtAt: new Date().toISOString(),
  manifest,
  files,
};
writeFileSync(
  join(releaseDir, `${manifest.id}-${manifest.version}.json`),
  JSON.stringify(metadata, null, 2) + '\n',
  'utf8'
);

console.log(`[build-plugin] 完成：${relative(pluginDir, zipPath)}`);
console.log(`[build-plugin] sha256=${zipSha256}`);

// ─────────────────────────── 工具 ───────────────────────────

function createZip(outputPath, manifestFile, assetsDir) {
  return new Promise((resolvePromise, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolvePromise);
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);
    archive.file(manifestFile, { name: 'plugin.json' });
    archive.directory(assetsDir, 'dist');

    for (const optional of ['README.md', 'LICENSE']) {
      const file = join(pluginDir, optional);
      if (existsSync(file)) archive.file(file, { name: optional });
    }

    void archive.finalize();
  });
}

function hashFile(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function hashFileSync(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const absolute = join(dir, name);
    const stat = statSync(absolute);
    if (stat.isDirectory()) out.push(...walk(absolute));
    else if (stat.isFile()) out.push(absolute);
  }
  return out;
}
