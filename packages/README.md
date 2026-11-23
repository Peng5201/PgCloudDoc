# packages：跨端共享协议包

这个目录放**跨端共享**的 workspace 包（pnpm workspace 里的独立 package）。
和 `frontend/`、`backend/` 的业务代码不同，这里的包不直接对外提供功能，而是被多个构建单元引用。

目前有两个包：

```text
packages/
  plugin-api/     # @pgclouddoc/plugin-api —— 插件系统接口标准
  ai-protocol/    # @pgclouddoc/ai-protocol —— AI 助手前后端协议
```

两个包都只放**类型、常量和协议**，不含业务实现；`dist/` 不进 git，检出后需要构建。

---

## `@pgclouddoc/plugin-api`

一句话：**它是插件系统的接口标准**，本身不干活。

插件系统有三方要对接：

1. **宿主**（`frontend/src/app/plugins/`）：实现插件 API、加载插件、分发命令；
2. **插件作者**（`plugins/*/`）：写插件时要知道能调用什么、`plugin.json` 怎么声明；
3. **后端**（插件上传接口）：校验上传的插件包是否合法。

三方必须对同一套契约达成一致。`@pgclouddoc/plugin-api` 就是这份契约：
宿主按它实现，插件按它编写，后端按它校验。

可以类比成**插座标准**：宿主是插座，插件是插头，这个包规定插孔尺寸和电压。

### 它不是什么

- 不是插件本身，不包含任何插件逻辑；
- 不是宿主实现，加载、命令分发、文档读写都在 `frontend/src/app/plugins/`；
- 不参与业务运行时。大部分内容是 TypeScript 类型，编译后会被擦除。

### 包里有什么

| 内容 | 文件 | 谁在用 |
| --- | --- | --- |
| `PluginContext`、`DocumentHub`、`SheetDocumentApi`、`NetApi`、`UiApi`、`StorageApi` 等类型 | `src/context.ts`、`src/document.ts`、`src/ui.ts` | 插件作者（类型提示）、宿主（实现契约） |
| `plugin.json` 的 zod schema 与 `parseManifest()` | `src/manifest.ts` | 插件构建脚本、后端上传校验 |
| 插件索引协议 `PluginIndex` / `PluginIndexEntry` | `src/protocol.ts` | 后端（下发）、前端（拉取） |
| 插槽名、权限名、API 版本等常量 | `src/constants.ts` | 宿主、插件、后端 |
| `PluginApiError` 与错误码 | `src/errors.ts` | 插件（按 code 分支）、宿主 |
| 极简 semver 范围判断 | `src/semver.ts` | 宿主（`engines.pgclouddoc` 兼容性） |

文档 API 里与 AI 助手相关的三个增量能力也在 `SheetDocumentApi` 上：
`getSheetInfo()`、`getRangeValuesInSheet()`、`transactInSheet()`。

### 三方分别怎么用

**前端宿主**

只取类型和少量运行时工具，不从根入口拿 schema（避免把 zod 打进浏览器 bundle）：

```ts
import type { PluginContext, SheetDocumentApi } from '@pgclouddoc/plugin-api'; // 类型，构建时擦除
import { satisfiesVersionRange } from '@pgclouddoc/plugin-api/semver';        // 运行时
import { TOOLBAR_SLOTS } from '@pgclouddoc/plugin-api/constants';             // 运行时
import { PluginApiError } from '@pgclouddoc/plugin-api/errors';               // 运行时
```

**插件作者**

插件源码通常只需要类型：

```ts
import type { PluginContext, CellSnapshot } from '@pgclouddoc/plugin-api';

export async function activate(ctx: PluginContext) { … }
```

插件构建时 `@pgclouddoc/plugin-api` 被标记为 external，不会打进插件产物。
宿主暂未提供 import map，因此**不要在插件里做运行时 import**（包括 `constants` / `errors` 子路径）；
需要共享逻辑时，要么只用类型，要么像 `ai-agent` 一样把依赖打进自己的 bundle（Preact）。

**后端**

后端产物是 CommonJS，而本包是纯 ESM。`plugin-api.loader.ts` 通过动态 `import()` 懒加载，
不需要为本包增加 CJS 产物：

```ts
const api = await loadPluginApi();
const manifest = api.parseManifest(pluginJsonFromZip);
```

后端通过 workspace 依赖引用，不走 HTTP：

```json
"@pgclouddoc/plugin-api": "workspace:*"
```

### 构建产物与导出

`packages/plugin-api` 用 `tsc` 直接编译，不打 bundle：

```text
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

`zod` 是外部依赖，不会被打进 `dist`；`frontend` 的 `predev` / `prebuild` 会自动
执行 `pnpm build:plugin-api`，一般不用手动跑。

`package.json` 的 `exports` 决定三方可以引用哪些子路径：

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

### 什么时候该改插件协议

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

---

## `@pgclouddoc/ai-protocol`

一句话：**AI 助手网关与浏览器插件共用的唯一协议**。

模型调用在服务端，工具执行在浏览器插件里，两边必须对同一套消息、工具和 SSE 事件达成一致。
这个包就是那份契约，避免后端和插件各写一份类型后逐渐漂移。

### 包里有什么

| 内容 | 说明 |
| --- | --- |
| `AiToolDefinition` / `AiToolResult` | 工具 Schema 与执行结果 |
| `AiContentBlock` | `text` / `tool_use` / `tool_result` 三种内容块 |
| `AiMessageDto` | 会话消息（角色、状态、用量） |
| `AiDocumentContext` | 每轮提交的文档结构、选区与预览 |
| `AiTurnRequest` | 一轮请求：用户消息或工具结果 + 上下文 + 工具定义 |
| `AiConfigResponse` / `AiLimits` | 服务端能力探测与限额 |
| `AI_SSE` / `AiSsePayloads` | SSE 事件名与 payload 类型 |
| `AI_MAX_*` / `AI_TOOL_NAME_PATTERN` | 工具数量、名称、输入/结果长度上限 |

### 谁在用

- **后端**：`backend/src/features/ai/`（网关、Provider、SSE、会话）；
- **插件**：`plugins/ai-agent/`（Agent 循环、工具执行、面板）；
- **测试**：后端 Provider/Service 测试、插件工具/控制器测试。

### ESM / CJS

包编译为纯 ESM（`"type": "module"`）。后端 Nest 产物是 CommonJS，因此
`exports` 里同时提供了 `require` → `./dist/index.js`，依赖 Node 22 的 `require(esm)`。
本项目要求 Node 22+；如果要兼容更旧的 Node，需要为本包补一份 CJS 产物。

### 构建

```bash
pnpm build:ai-protocol
```

以下命令会自动先构建本包：

- 根 `pnpm typecheck` / `pnpm build:plugin` / `pnpm build:plugin:ai`；
- `backend` 的 `predev` / `prebuild`；
- `plugins/ai-agent` 的 `predev` / `prebuild`。

### 什么时候该改 AI 协议

- 新增工具、消息块类型、SSE 事件或限额；
- 调整文档上下文结构。

规则：**同一主版本只做加法**；改完同时跑后端与插件测试：

```bash
pnpm --filter backend test
pnpm --filter @pgclouddoc/plugin-ai-agent test
pnpm typecheck
```

---

## 常用命令

```bash
pnpm build:plugin-api                 # 编译插件协议包
pnpm build:ai-protocol                # 编译 AI 协议包
pnpm --filter @pgclouddoc/plugin-api typecheck
pnpm --filter @pgclouddoc/ai-protocol typecheck
pnpm typecheck                        # 全 workspace（会先构建两个协议包）
```
