# packages：共享协议包

这个目录放**跨端共享**的 workspace 包（pnpm workspace 里的独立 package）。
和 `frontend/`、`backend/` 的业务代码不同，这里的包不直接对外提供功能，而是被多个构建单元引用。

目前只有一个包：

```
packages/
  plugin-api/        # @pgclouddoc/plugin-api
```

---

## `@pgclouddoc/plugin-api` 是干什么的

一句话：**它是插件系统的接口标准**，本身不干活。

插件系统有三方要对接：

1. **宿主**（`frontend/src/app/plugins/`）：实现插件 API、加载插件、分发命令；
2. **插件作者**（`plugins/*/`）：写插件时要知道能调用什么、`plugin.json` 怎么声明；
3. **后端**（P1 的插件上传接口）：校验上传的插件包是否合法。

三方必须对同一套契约达成一致。`@pgclouddoc/plugin-api` 就是这份契约：
宿主按它实现，插件按它编写，后端按它校验。

可以类比成**插座标准**：宿主是插座，插件是插头，这个包规定插孔尺寸和电压。

### 它不是什么

- 不是插件本身，不包含任何插件逻辑；
- 不是宿主实现，加载、命令分发、文档读写都在 `frontend/src/app/plugins/`；
- 不参与业务运行时。大部分内容是 TypeScript 类型，编译后会被擦除。

---

## 包里有什么

| 内容 | 文件 | 谁在用 |
| --- | --- | --- |
| `PluginContext`、`DocumentHub`、`SheetDocumentApi`、`UiApi`、`StorageApi` 等类型 | `src/context.ts`、`src/document.ts`、`src/ui.ts` | 插件作者（类型提示）、宿主（实现契约） |
| `plugin.json` 的 zod schema 与 `parseManifest()` | `src/manifest.ts` | 插件构建脚本、后端上传校验 |
| 插件索引协议 `PluginIndex` / `PluginIndexEntry` | `src/protocol.ts` | 后端（P1 下发）、前端（拉取） |
| 插槽名、权限名、API 版本等常量 | `src/constants.ts` | 宿主、插件、后端 |
| `PluginApiError` 与错误码 | `src/errors.ts` | 插件（按 code 分支）、宿主 |
| 极简 semver 范围判断 | `src/semver.ts` | 宿主（`engines.pgclouddoc` 兼容性） |

---

## 三方分别怎么用

### 前端宿主

只取类型和少量运行时工具，不从根入口拿 schema（避免把 zod 打进浏览器 bundle）：

```ts
import type { PluginContext, SheetDocumentApi } from '@pgclouddoc/plugin-api'; // 类型，构建时擦除
import { satisfiesVersionRange } from '@pgclouddoc/plugin-api/semver';        // 运行时
import { TOOLBAR_SLOTS } from '@pgclouddoc/plugin-api/constants';             // 运行时
import { PluginApiError } from '@pgclouddoc/plugin-api/errors';               // 运行时
```

### 插件作者

插件源码通常只需要类型：

```ts
import type { PluginContext, CellSnapshot } from '@pgclouddoc/plugin-api';

export async function activate(ctx: PluginContext) { … }
```

插件构建时 `@pgclouddoc/plugin-api` 被标记为 external，不会打进插件产物；
P1 会通过宿主 import map 提供同一份运行时实例。

### 后端（P1）

上传 zip 时，用同一份 schema 校验 `plugin.json`，避免前后端规则漂移：

```ts
import { parseManifest } from '@pgclouddoc/plugin-api/manifest';

const manifest = parseManifest(pluginJsonFromZip); // 非法时抛带字段路径的错误
// manifest.id / version / engines / permissions / entry …
```

后端通过 workspace 依赖引用，不走 HTTP：

```json
"@pgclouddoc/plugin-api": "workspace:*"
```

pnpm 会在 `backend/node_modules/@pgclouddoc/plugin-api` 建软链，指向上面的包。

> **注意（P1 处理）**：本包目前编译为纯 ESM（`"type": "module"`），
> 而后端 Nest 产物是 CommonJS，`require()` 一个 ESM 包会失败。
> 接入后端时需要在两种方案中选一个：
> 1. 给本包增加 CJS 产物（`exports` 同时提供 `import` / `require`），推荐；
> 2. 后端上传服务使用动态 `import()` 懒加载。

---

## 构建产物

`packages/plugin-api` 用 `tsc` 直接编译，不打 bundle：

```
packages/plugin-api/dist/
  index.js / index.d.ts
  manifest.js / manifest.d.ts        # zod schema + parseManifest
  constants.js / constants.d.ts
  semver.js / semver.d.ts
  errors.js / errors.d.ts
  document.js / document.d.ts
  context.js / context.d.ts
  protocol.js / protocol.d.ts
  ui.js / ui.d.ts
  *.js.map / *.d.ts.map
```

- `zod` 是**外部依赖**，不会被打进 `dist`；
- `dist/` 不进 git（根 `.gitignore` 的 `dist/` 规则），检出后需要构建；
- `frontend` 的 `predev` / `prebuild` 会自动执行 `pnpm build:plugin-api`，一般不用手动跑。

### 导出入口

`package.json` 的 `exports` 决定了三方可以引用哪些子路径：

```json
"exports": {
  ".":           { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./manifest":  { "types": "./dist/manifest.d.ts", "import": "./dist/manifest.js" },
  "./constants": { "types": "./dist/constants.d.ts", "import": "./dist/constants.js" },
  "./semver":    { "types": "./dist/semver.d.ts", "import": "./dist/semver.js" },
  "./errors":    { "types": "./dist/errors.d.ts", "import": "./dist/errors.js" }
}
```

前端刻意不从 `.` 根入口做运行时 import：根入口会 `export * from './manifest.js'`，
一执行就会加载 zod。需要运行时工具时走上面的子路径。

---

## 什么时候该改这里

只有**契约**变化才改这个包：

- 新增插件 API 能力（例如 `documents.onDidSave`）；
- 新增 manifest 字段 / 插槽 / 权限；
- 插件索引协议变化；
- 新增错误码。

规则：

1. **同一主版本只做加法**。破坏性变更必须提升 `PLUGIN_API_VERSION`（当前 `"1"`），
   并让宿主至少并行支持一个旧主版本；
2. 改 schema 时同步检查三处使用方：前端宿主、后端上传、插件构建脚本；
3. 改完跑 `pnpm typecheck` 和 `pnpm --filter frontend test`。

如果只是宿主内部实现变化（例如文档 API 的底层换实现），不要改这里 ——
类型不变，插件就不该感知。

---

## 常用命令

```bash
pnpm build:plugin-api                 # 编译本包（tsc → dist）
pnpm --filter @pgclouddoc/plugin-api typecheck
pnpm typecheck                        # 全 workspace（会先构建本包）
```
