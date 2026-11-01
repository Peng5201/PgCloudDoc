# PgCloudDoc 插件 API 与外部服务文档

适用版本：宿主 `HOST_VERSION = 1.0.0`，插件 API 主版本 `pluginApi = "1"`。

本文是插件作者的接口契约，逐项说明：

1. 插件可以调用的**全部文档接口**，以及每个接口的作用、副作用、权限和限制；
2. 插件运行所依赖的**全部外部服务**（浏览器 → 宿主 → 后端 / nginx / etcd / PostgreSQL / 开发服务器），包括地址、鉴权、用途和失效行为；
3. 插件包规范、生命周期、权限、错误码和发布流程。

相关文档：

- 设计与取舍：[plugin-system-design.md](plugin-system-design.md)
- 插件库本地开发与构建：[README.MD](README.MD)
- 协议类型唯一真源：[packages/plugin-api/src](../packages/plugin-api/src/index.ts)
- 文档 API 宿主实现：[frontend/src/app/plugins/api/document-api.ts](../frontend/src/app/plugins/api/document-api.ts)
- 示例插件：[csv-tools](csv-tools/src/index.ts)、[execl-agent](execl-agent/src/index.ts)

> 本文按**当前实现**编写。设计文档中尚未落地的能力（如侧栏面板、菜单渲染、远程 origin）在本文中会明确标注「v1 未接入」，不要按设计稿调用。

---

## 目录

- [1. 运行模型](#1-运行模型)
- [2. 最小插件](#2-最小插件)
- [3. plugin.json 完整参考](#3-pluginjson-完整参考)
- [4. 生命周期与激活](#4-生命周期与激活)
- [5. PluginContext 与三类交互总览](#5-plugincontext-与三类交互总览)
- [6. 与文档交互：文档 API](#6-与文档交互文档-api)
- [7. 与界面交互：命令 API](#7-与界面交互命令-api)
- [8. 与界面交互：UI API](#8-与界面交互ui-api)
- [9. 与服务交互：设置 API](#9-与服务交互设置-api)
- [10. 与服务交互：存储 API](#10-与服务交互存储-api)
- [11. 日志、订阅与上下文属性](#11-日志订阅与上下文属性)
- [12. 权限模型](#12-权限模型)
- [13. 错误码](#13-错误码)
- [14. 与服务交互：外部服务](#14-与服务交互外部服务)
- [15. 开发、构建与发布](#15-开发构建与发布)
- [16. 安全边界](#16-安全边界)
- [17. 开发检查清单](#17-开发检查清单)

---

## 1. 运行模型

插件是一个**原生 ESM 模块**，由宿主在浏览器主线程中通过 `import()` 加载，运行在**与宿主同一个 realm**（不是 iframe、不是 Worker）：

```text
宿主启动（用户已登录）
  → GET /api/v1/plugins/index          拉取插件索引
  → 注册 manifest 静态贡献（按钮先渲染，不执行插件代码）
  → 命中 activationEvent 时 import(入口)
  → activate(context)                  插件拿到 PluginContext
  → 命令 / UI / 文档读写 / 事件
  → 停用或退出登录时 dispose subscriptions、移除 UI、卸载样式
```

由此决定了几条硬约束：

- 插件代码**不能被真正卸载**。停用只释放宿主登记的资源，模块顶层产生的副作用（定时器、全局监听、修改过的 DOM）不会自动回收。
- 插件与宿主共享 `window`、`document`、登录 Cookie 和同源 API。宿主无法在同步死循环中抢占插件线程。
- 插件**只能**通过 `context` 使用宿主能力；不能 import 宿主内部模块（`spreadsheet/engine`、`collab/*`），也不能直接操作 `window.__sheetEngine` 或 Y.Doc。

入口模块必须导出：

```ts
import type { PluginContext } from '@pgclouddoc/plugin-api';

export async function activate(context: PluginContext): Promise<void> {
  // 注册命令、UI、事件，读写文档
}

export function deactivate(): void {
  // 可选。宿主已经 dispose 了 context.subscriptions，
  // 这里只做宿主无法代劳的清理（例如取消自己创建的定时器）。
}
```

---

## 2. 最小插件

`plugin.json`：

```json
{
  "manifestVersion": 1,
  "id": "com.example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "entry": "dist/main.js",
  "engines": {
    "pgclouddoc": ">=1.0.0 <2.0.0",
    "pluginApi": "1"
  },
  "activationEvents": ["onCommand:hello.run"],
  "contributes": {
    "commands": [{ "id": "hello.run", "title": "读取当前选区" }],
    "toolbar": [
      {
        "slot": "sheet.toolbar.end",
        "command": "hello.run",
        "title": "Hello",
        "order": 100
      }
    ]
  },
  "permissions": ["document:read"]
}
```

`src/index.ts`：

```ts
import type { PluginContext } from '@pgclouddoc/plugin-api';

export async function activate(ctx: PluginContext) {
  ctx.subscriptions.push(
    ctx.commands.register('hello.run', async () => {
      const doc = ctx.documents.active();
      if (!doc) {
        ctx.ui.showMessage('warning', '请先打开一个文档');
        return;
      }

      const selection = doc.getSelection();
      const range = selection.ranges[0];
      if (!range) return;

      const rows = await doc.getRangeValues(range);
      ctx.logger.info('选区内容', rows);
      ctx.ui.showMessage('success', `读到 ${rows.length} 行`);
    })
  );
}
```

构建产物为 `dist/main.js`，`plugin.json` 与 `dist/` 一起打成 zip，由管理后台上传。

---

## 3. plugin.json 完整参考

Schema 定义在 [packages/plugin-api/src/manifest.ts](../packages/plugin-api/src/manifest.ts)，**前端宿主、后端上传校验、构建脚本使用同一份 zod schema**，任何一处校验失败都会拒绝加载/上传。

### 3.1 顶层字段

| 字段 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- |
| `manifestVersion` | 是 | 固定 `1` | 清单协议版本 |
| `id` | 是 | `^[a-z0-9][a-z0-9._-]{2,127}$` | 反向域名，全局唯一；同时用作产物目录名 |
| `name` | 是 | 1–80 字符 | 展示名 |
| `version` | 是 | semver | 发布后不可覆盖 |
| `description` | 否 | ≤500 字符 | 描述 |
| `author` | 否 | ≤120 字符 | 作者 |
| `homepage` | 否 | ≤2048 字符 | 主页 |
| `entry` | 是 | 相对路径 | ESM 入口；构建脚本要求位于 `dist/` 下 |
| `style` | 否 | 相对路径 | 全局样式；激活时宿主插入 `<link>`，停用时移除 |
| `icon` | 否 | 相对路径 | 插件图标 |
| `engines.pgclouddoc` | 是 | ≤64 字符 | 宿主版本范围，如 `>=1.0.0 <2.0.0`；不满足则客户端跳过 |
| `engines.pluginApi` | 是 | 固定 `"1"` | 插件 API 主版本 |
| `activationEvents` | 否 | ≤50 项 | 懒激活条件，见 4.2 |
| `contributes` | 否 | 见 3.2 | 静态贡献点 |
| `permissions` | 否 | ≤20 项 | 能力声明，见 12 |
| `settings` | 否 | ≤50 项 | 设置 schema，见 3.3 |

**相对路径约束**（`RELATIVE_PATH_PATTERN`）：不允许绝对路径、`..`、反斜杠；只允许字母、数字、`.`、`_`、`@`、`-` 以及 `/` 分隔。

### 3.2 contributes

```json
{
  "commands": [
    { "id": "hello.run", "title": "运行", "icon": "dist/icons/run.svg", "category": "工具" }
  ],
  "toolbar": [
    { "slot": "sheet.toolbar.end", "command": "hello.run", "title": "运行", "order": 10, "requiresWrite": false }
  ],
  "statusBar": [
    { "slot": "sheet.statusBar.end", "command": "hello.run", "title": "状态" }
  ],
  "menus": [
    { "menu": "sheet.contextMenu", "command": "hello.run", "title": "运行", "group": "tools" }
  ],
  "panels": [
    { "id": "hello.panel", "title": "Hello", "slot": "editor.sidebar" }
  ]
}
```

| 节点 | 上限 | 字段 | 交叉校验 |
| --- | --- | --- | --- |
| `commands` | 100 | `id`、`title`、`icon?`、`category?` | `id` 不能重复 |
| `toolbar` | 50 | `slot`、`command`、`title?`、`icon?`、`order?`、`requiresWrite?` | `command` 必须在 `commands` 中声明 |
| `statusBar` | 20 | 同 `toolbar` | 同上 |
| `menus` | 50 | `menu`、`command`、`title?`、`icon?`、`group?`、`order?` | 同上 |
| `panels` | 20 | `id`、`title`、`slot`、`icon?` | — |

`order` 取值范围 `-1000..1000`，默认 `100`，越小越靠前。

**插槽枚举**：

| 类别 | 取值 | v1 是否渲染 |
| --- | --- | --- |
| 工具栏 | `editor.titleBar.start` | 否（已定义，宿主未接入） |
| 工具栏 | `editor.titleBar.end` | 是 |
| 工具栏 | `sheet.toolbar.start` | 否（已定义，宿主未接入） |
| 工具栏 | `sheet.toolbar.end` | 是 |
| 状态栏 | `sheet.statusBar.start` | 否（已定义，宿主未接入） |
| 状态栏 | `sheet.statusBar.end` | 是 |
| 菜单 | `sheet.contextMenu` | 否（已登记，无渲染方） |
| 菜单 | `editor.more` | 否（已登记，无渲染方） |
| 面板 | `editor.sidebar` | 否（`registerPanel` 为空实现） |

> 当前宿主只渲染 `editor.titleBar.end`、`sheet.toolbar.end`、`sheet.statusBar.end` 三处。其余插槽可以声明，但不会出现在界面上，也不会报错。

### 3.3 settings

```json
{
  "settings": [
    {
      "key": "delimiter",
      "type": "enum",
      "enum": [",", ";", "\t"],
      "default": ",",
      "title": "CSV 分隔符",
      "description": "导出时使用的列分隔符",
      "scope": "client"
    },
    {
      "key": "apiKey",
      "type": "string",
      "title": "服务端密钥",
      "scope": "server"
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `key` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，同一清单内唯一 |
| `type` | `string` / `number` / `boolean` / `enum` |
| `title`、`description` | 管理端表单展示 |
| `default` | 默认值 |
| `scope` | `client`（随索引下发到浏览器）或 `server`（**永不下发**） |
| `enum` | `type: "enum"` 时必填，1–50 个字符串 |
| `min` / `max` | `type: "number"` 时可选 |
| `placeholder` | `type: "string"` 时可选，≤200 字符 |

最终值 = `default` + 管理端覆盖，只下发 `client` scope。插件通过 `context.settings.get(key)` 读取，见 9。

### 3.4 activationEvents

| 事件 | 触发时机 |
| --- | --- |
| `onStartup` | 登录完成、索引加载完成后立即激活（慎用，会拖慢启动） |
| `onDocumentOpen` | 打开任意文档编辑页 |
| `onDocumentOpen:sheet` | 打开表格文档（当前只有表格） |
| `onCommand:<commandId>` | 该命令被声明为激活事件；必须是 `contributes.commands` 里已声明的命令 |
| `onView:<viewId>` | v1 未接入（面板不渲染，不会触发） |

`activationEvents` 可以为空：此时插件不会被自动激活，但用户点击 manifest 里声明的按钮时，宿主仍会先激活再执行命令（懒激活）。

### 3.5 插件包（zip）约束

上传的 zip 是**管理员提交的不可信输入**，服务端会逐项校验：

| 项目 | 限制 |
| --- | --- |
| 根目录 | 必须包含 `plugin.json` |
| 文件数 | ≤ 2000 |
| 单文件解压后 | ≤ 20 MB |
| 解压后总计 | ≤ 100 MB |
| 路径长度 | ≤ 200 字符 |
| 路径 | 禁止绝对路径、盘符、`..`、反斜杠、NUL |
| 扩展名白名单 | `.js` `.mjs` `.css` `.json` `.map` `.svg` `.png` `.jpg` `.jpeg` `.webp` `.woff2` `.txt` `.md` `.wasm`；无扩展名的 `LICENSE` / `README` 允许 |
| 引用完整性 | `entry`、`style`、`icon` 指向的文件必须存在 |
| 版本 | 同一 `id + version` 发布后不可覆盖，重复上传返回 `409` |

`.html`、`.node`、可执行文件一律拒绝。

---

## 4. 生命周期与激活

### 4.1 状态机

```text
discovered ──命中激活条件──> loading ──> active
                                  └──> failed（超时 / import 失败 / activate 抛错）
active ──停用 / 退出登录 / 页面卸载──> disposed
```

- 激活超时 **10 秒**，超时标记失败，不影响其他插件。
- 同一个插件在一个页面生命周期内只 `import` 一次（按 `id@version:baseUrl` 缓存）。
- 插件激活失败后，点击它的按钮会报错；重新加载页面可重试。
- 用户退出登录时宿主整体 `dispose()`，所有插件的 `subscriptions` 被释放，UI 与样式被移除。

### 4.2 激活触发点（按当前实现）

| 触发 | 行为 |
| --- | --- |
| 索引加载完成 | 激活声明了 `onStartup` 的插件 |
| `attachDocument()` | 激活声明了 `onDocumentOpen` 或 `onDocumentOpen:sheet` 的插件；索引晚于文档就绪时会补一次 |
| 点击 manifest 贡献的按钮 | `executeCommand` 前先 `ensureActivated` |
| `context.commands.execute()` | 同上，先确保插件已激活 |
| `onView:*` | 未接入 |
| `onCommand:*` | 宿主不做启动时扫描；命令执行链路本身会激活插件 |

---

## 5. PluginContext 与三类交互总览

`activate(context)` 拿到的是 [context.ts](../packages/plugin-api/src/context.ts) 定义的 `PluginContext`：

| 成员 | 交互对象 | 类型 | 作用 |
| --- | --- | --- | --- |
| `pluginId` | 运行时 | `string` | 当前插件 id |
| `pluginVersion` | 运行时 | `string` | 当前插件版本 |
| `hostVersion` | 运行时 | `string` | 宿主平台版本（当前 `1.0.0`） |
| `apiVersion` | 运行时 | `string` | 插件 API 主版本（当前 `"1"`） |
| `logger` | 运行时 | `PluginLogger` | 带 `[plugin:<id>]` 前缀的 `debug/info/warn/error` |
| `commands` | 界面 | `CommandApi` | 注册/执行命令（见 7） |
| `documents` | 文档 | `DocumentHub` | 访问当前打开的文档（见 6） |
| `ui` | 界面 | `UiApi` | 注册工具栏/状态栏/菜单、弹消息（见 8） |
| `settings` | 服务 | `SettingsApi` | 读取服务端下发的清单设置（见 9） |
| `storage` | 服务 | `StorageApi` | 按插件 + 用户隔离的键值存储（见 10） |
| `subscriptions` | 运行时 | `Disposable[]` | 所有注册/监听的统一释放列表 |
| `hasPermission(permission)` | 运行时 | `(PluginPermission) => boolean` | 查询 manifest 是否声明了某权限 |

### 5.1 三类交互接口

插件对外的能力面按交互对象分成三类。本文后续章节按同一分类组织：

| 交互对象 | 接口 | 说明 | 详见 |
| --- | --- | --- | --- |
| **文档** | `documents.active` / `onDidOpen` / `onDidClose`；`SheetDocumentApi` 的读接口、写接口、事件、`transact`；`DocumentTransaction` | `DocumentHub` 负责文档生命周期，`SheetDocumentApi` 读写选区/工作表/整簿快照，`transact` 合并撤销单元 | 第 6 章 |
| **界面** | `commands.register` / `commands.execute`；`ui.registerToolbarItem` / `registerStatusBarItem` / `registerMenuItem` / `registerPanel` / `showMessage`；manifest `contributes` | 工具栏/状态栏/菜单入口、命令注册与执行、全局消息提示 | 3.2、第 7 章、第 8 章 |
| **服务** | `settings.get` / `settings.onChange`；`storage.get` / `set` / `delete` / `keys`；插件索引、静态产物、管理端、协同、etcd、数据库、插件自身网络请求 | 服务端下发配置、本地键值存储、平台与外部 HTTP / WebSocket 服务 | 第 9 章、第 10 章、第 14 章 |

`logger`、`subscriptions`、`hasPermission`、`pluginId` 等属于运行时辅助，不构成与文档/界面/服务的交互面。

---

## 6. 与文档交互：文档 API

文档 API 的宿主实现在 [document-api.ts](../frontend/src/app/plugins/api/document-api.ts)，类型定义在 [document.ts](../packages/plugin-api/src/document.ts)。本节逐项列出**与文档交互的全部接口**。

### 6.1 DocumentHub

`context.documents` 是文档入口。当前宿主**同一时刻只维护一个活动文档会话**。

| 方法 | 签名 | 权限 | 同步性 | 作用 |
| --- | --- | --- | --- | --- |
| `active()` | `() => SheetDocumentApi \| null` | 无 | 同步 | 返回当前打开的文档；不在编辑页时返回 `null` |
| `onDidOpen(cb)` | `(doc: SheetDocumentApi) => Disposable` | 无 | 同步注册 | 文档打开时回调；**不会补发已打开文档**，需要现状请直接调用 `active()` |
| `onDidClose(cb)` | `(documentId: string) => Disposable` | 无 | 同步注册 | 文档关闭时回调；插件应在这里清理持有该文档的引用 |

行为说明：

- 文档关闭后，旧 `SheetDocumentApi` 的所有方法都会抛 `E_PLUGIN_DISPOSED`。
- `onDidOpen` / `onDidClose` 的回调异常会被宿主捕获并记录，不会中断其他插件。
- 同一个文档、同一个引擎重复 `attach` 是幂等的，不会重复触发 `onDidOpen`。

### 6.2 SheetDocumentApi 属性

| 属性 | 类型 | 只读 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 文档 id |
| `title` | `string` | 是（getter） | 文档标题，实时读取 |
| `type` | `'sheet'` | 是 | 当前只有表格文档 |
| `readOnly` | `boolean` | 是（getter） | 未声明 `document:write`、用户无编辑角色、引擎只读或会话已销毁时为 `true` |
| `canWrite` | `boolean` | 是（getter） | 声明了 `document:write` **且** 当前用户可编辑 **且** 会话未销毁 |

`readOnly` 与 `canWrite` 是互补的实时判断。它们会随用户角色加载、文档权限变化而改变，**不要缓存到模块顶层**。

### 6.3 文档操作的总规则

1. **所有范围操作都作用于「当前活动工作表」**。API 没有 `sheetId` 参数；需要操作其他工作表时先 `setActiveSheet(sheetId)`。
2. **坐标 0-based、闭区间**。`{ startRow: 0, startColumn: 0, endRow: 2, endColumn: 2 }` 表示 A1:C3。
3. 范围会先做归一化：起止颠倒会自动交换（min/max），负数或非整数直接拒绝。
4. 超出工作表边界的部分会被裁剪到有效范围；完全越界抛 `E_PLUGIN_INVALID_RANGE`。
5. 单次读/写最多 **20,000 个单元格**，超过抛 `E_PLUGIN_RANGE_TOO_LARGE`。分批处理时每批都要满足该上限。
6. 所有写操作都走宿主命令管线（`engine.execute`），因此**天然可撤销、可协同、受只读约束**；插件不能绕过它直接改矩阵。
7. 文档关闭后调用任何方法都会抛 `E_PLUGIN_DISPOSED`。

### 6.4 读接口

#### `getSelection(): SelectionSnapshot`

| 项目 | 内容 |
| --- | --- |
| 权限 | `document:read` |
| 同步性 | 同步 |
| 作用 | 读取当前选区（活动单元格 + 所有选区块） |
| 副作用 | 无；不改文档、不进撤销栈、不广播 |
| 返回 | 深拷贝，修改返回值不影响文档 |
| 错误 | `E_PLUGIN_DISPOSED`、`E_PLUGIN_PERMISSION` |

```ts
const { active, ranges } = doc.getSelection();
// active: { row, column }，0-based
// ranges: RangeSnapshot[]，0-based 闭区间
```

#### `setSelection(selection): Promise<void>`

| 项目 | 内容 |
| --- | --- |
| 权限 | `document:read`（实现如此；它不修改文档内容） |
| 同步性 | 异步 |
| 作用 | 设置当前选区；`active` 省略时默认 A1；`ranges` 为空时用 `active` 生成单格选区 |
| 副作用 | 改变本地选区；触发 `selection-change`；宿主的协同桥可能把选区广播给协作者（仅编辑者）；**不进撤销栈，不修改单元格内容** |
| 限制 | 范围归一化（min/max），不做 20,000 格校验；只读文档下也可以调用 |
| 错误 | `E_PLUGIN_DISPOSED`、`E_PLUGIN_PERMISSION` |

#### `getSheets(): SheetSummarySnapshot[]`

| 项目 | 内容 |
| --- | --- |
| 权限 | `document:read` |
| 同步性 | 同步 |
| 作用 | 返回工作簿内所有工作表的摘要（包括隐藏表） |
| 返回 | `Array<{ id: string; name: string; hidden: boolean }>` |
| 副作用 | 无 |
| 错误 | `E_PLUGIN_DISPOSED`、`E_PLUGIN_PERMISSION` |

#### `getActiveSheetId(): string`

| 项目 | 内容 |
| --- | --- |
| 权限 | `document:read` |
| 同步性 | 同步 |
| 作用 | 返回当前活动工作表 id |
| 错误 | 上述错误码，以及没有活动工作表时的 `E_PLUGIN_NO_DOCUMENT` |

#### `setActiveSheet(sheetId: string): Promise<void>`

| 项目 | 内容 |
| --- | --- |
| 权限 | `document:read` |
| 同步性 | 异步 |
| 作用 | 切换当前活动工作表（本地视图状态） |
| 副作用 | 切换后**选区重置为 A1**；依次触发 `sheet-change` 和 `selection-change`；不进撤销栈 |
| 限制 | 未知 `sheetId` **静默忽略**（不抛错、不切换）；传入当前表 id 直接返回；只读文档下也可调用 |
| 错误 | `E_PLUGIN_DISPOSED`、`E_PLUGIN_PERMISSION` |

> 宿主没有单独的「读某个工作表某个范围」接口。正确用法是：`setActiveSheet(id)` → `getRangeValues(range)`。切换是本地视图操作，不会作为一次编辑广播给协作者。

#### `getRangeValues(range): Promise<CellSnapshot[][]>`

| 项目 | 内容 |
| --- | --- |
| 权限 | `document:read` |
| 同步性 | 异步 |
| 作用 | 读取活动工作表指定范围内的单元格快照 |
| 返回 | 二维数组，行优先；形状等于**归一化并裁剪后**的范围 |
| 副作用 | 无 |
| 限制 | 20,000 格上限；范围必须是非负整数，起止颠倒会自动归一化 |
| 错误 | `E_PLUGIN_DISPOSED`、`E_PLUGIN_PERMISSION`、`E_PLUGIN_INVALID_RANGE`、`E_PLUGIN_RANGE_TOO_LARGE` |

`CellSnapshot` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `value` | `string \| number \| boolean \| null` | 原始值 `cell.v`；公式单元格通常为空字符串 |
| `formula` | `string \| null` | 公式原文，如 `=SUM(A1:A3)`；非公式为 `null` |
| `displayText` | `string` | 按引擎规则渲染的显示文本 |

`displayText` 的精确语义：

- 公式单元格显示**公式原文**（引擎只存公式，不做计算）；
- 数字有数字格式时按格式渲染（日期、百分比、千分位等）；
- 布尔值显示 `TRUE` / `FALSE`；
- 空格子显示空字符串。

#### `getSnapshot(): Promise<WorkbookSnapshot>`

| 项目 | 内容 |
| --- | --- |
| 权限 | `document:read` |
| 同步性 | 异步 |
| 作用 | 返回整份工作簿的只读 JSON 快照（导出、调试、整簿分析） |
| 返回 | `Record<string, unknown>`，结构与引擎的 `IWorkbookData` 兼容 |
| 副作用 | 无；快照是一次性拷贝，修改返回值不会影响文档 |
| 限制 | 没有单元格数量限制，但大文档会产生明显的序列化开销；**优先用 `getRangeValues` 读选区** |
| 错误 | `E_PLUGIN_DISPOSED`、`E_PLUGIN_PERMISSION` |

> `getSnapshot()` 的结构只为「读」设计，宿主**不承诺**插件可以依赖全部字段。需要稳定契约时只用单元格/选区接口。

### 6.5 写接口

所有写接口共同的前置检查（按顺序）：

1. 会话存在且文档未关闭 → 否则 `E_PLUGIN_DISPOSED`；
2. manifest 声明 `document:write` → 否则 `E_PLUGIN_PERMISSION`；
3. 当前用户可写、引擎非只读 → 否则 `E_PLUGIN_READ_ONLY`。

#### `setRangeValues(range, values): Promise<void>`

| 项目 | 内容 |
| --- | --- |
| 权限 | `document:write` + `doc.canWrite` |
| 同步性 | 异步（内部同步执行） |
| 作用 | 向活动工作表写入二维值矩阵 |
| 撤销 | **一次调用 = 一个撤销单元**，撤销标签形如 `插件：写入选区` |
| 协同 | 通过 `engine.execute` 触发本地变更钩子，由 DocSync 写入 Y.Doc 并广播 |
| 限制 | 矩阵行数/列数必须**严格等于**归一化后的范围；只允许 `string \| number \| boolean \| null`；≤20,000 格 |
| 错误 | 上述写错误，以及 `E_PLUGIN_INVALID_INPUT`、`E_PLUGIN_INVALID_RANGE`、`E_PLUGIN_RANGE_TOO_LARGE` |

值语义：

| 输入 | 存储结果 |
| --- | --- |
| `null` | **删除该单元格**（稀疏矩阵里「不存在」才是常态），不是写入空串 |
| `''` | 写入空字符串（单元格仍存在） |
| `'42'` / `'1,234.5'` | 走值推断，存为数字 `42` / `1234.5` |
| `'true'` / `'false'` | 存为布尔值 |
| `'=SUM(A1:A3)'` | 存为公式原文（引擎只存不计算，`value` 为空） |
| 其他字符串 | 原样存为字符串（前后空格保留） |
| `number` / `boolean` | 按原类型写入 |
| `undefined` | 非法，抛 `E_PLUGIN_INVALID_INPUT` |

示例：

```ts
await doc.setRangeValues(
  { startRow: 0, startColumn: 0, endRow: 1, endColumn: 1 },
  [
    ['名称', '金额'],
    ['示例', 168],
  ]
);
```

#### `clearRange(range): Promise<void>`

| 项目 | 内容 |
| --- | --- |
| 权限 | `document:write` + `doc.canWrite` |
| 同步性 | 异步（内部同步执行） |
| 作用 | 清空选区内容 |
| 实际行为 | **真删除单元格**：连同值、公式、样式引用一起删除（不是写入空串） |
| 撤销 | 一次调用 = 一个撤销单元，标签形如 `插件：清除选区` |
| 协同 | 同 `setRangeValues` |
| 限制 | ≤20,000 格 |
| 错误 | 写错误 + `E_PLUGIN_INVALID_RANGE`、`E_PLUGIN_RANGE_TOO_LARGE` |

#### `setRangeStyle(range, patch): Promise<void>`

| 项目 | 内容 |
| --- | --- |
| 权限 | `document:write` + `doc.canWrite` |
| 同步性 | 异步（内部同步执行） |
| 作用 | 对选区内每个单元格**基于其当前样式**合并一份样式增量（不是整块统一覆盖） |
| 撤销 | 一次调用 = 一个撤销单元，标签形如 `插件：设置样式` |
| 协同 | 同 `setRangeValues` |
| 限制 | ≤20,000 格；只应用下表白名单字段，未知字段**静默丢弃**；`undefined` 跳过；`null` 清除该字段 |
| 错误 | 写错误 + `E_PLUGIN_INVALID_RANGE`、`E_PLUGIN_RANGE_TOO_LARGE` |

`StylePatch` 白名单（宿主只透传这些键）：

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `bl` | `0 \| 1 \| null` | 加粗 |
| `it` | `0 \| 1 \| null` | 斜体 |
| `ul` | `0 \| 1 \| null` | 下划线（按插件 API 声明） |
| `st` | `0 \| 1 \| null` | 删除线（按插件 API 声明） |
| `fs` | `number \| null` | 字号，单位 pt |
| `cl` | `{ rgb: string } \| null` | 字体颜色 |
| `bg` | `{ rgb: string } \| null` | 背景色 |
| `ht` | `number \| null` | 水平对齐：0 `UNSPECIFIED`、1 `LEFT`、2 `CENTER`、3 `RIGHT`、4 `JUSTIFIED`、5 `BOTH`、6 `DISTRIBUTED` |
| `vt` | `number \| null` | 垂直对齐：0 `UNSPECIFIED`、1 `TOP`、2 `MIDDLE`、3 `BOTTOM` |
| `tb` | `number \| null` | 换行策略：0 `UNSPECIFIED`、1 `OVERFLOW`、2 `CLIP`、3 `WRAP` |

示例：

```ts
await doc.setRangeStyle(
  { startRow: 0, startColumn: 0, endRow: 0, endColumn: 2 },
  { bl: 1, bg: { rgb: '#fff3cd' }, ht: 2 }
);

// null 清除字段
await doc.setRangeStyle(range, { bl: null });
```

> 对空格子套样式会创建「只有样式、没有值」的单元格，这是引擎的既有行为。清除选区（`clearRange`）会把这类单元格一起删掉。

### 6.6 事务：`transact(label, fn)`

| 项目 | 内容 |
| --- | --- |
| 权限 | `document:write` + `doc.canWrite` |
| 同步性 | 异步 |
| 作用 | 把多次写入合成**一个撤销单元**；`fn` 抛错时**不落任何改动** |
| 参数 | `label`：撤销提示里的操作名；`fn(tx)`：在事务对象上登记写入 |
| 返回 | `fn` 的返回值 |
| 错误 | 写错误；`fn` 内部的异常原样抛出，且不应用任何已登记的写入 |

`DocumentTransaction` 只有三个登记方法，**都只登记、不立即执行**：

```ts
interface DocumentTransaction {
  setRangeValues(range: RangeSnapshot, values: CellInput[][]): void;
  clearRange(range: RangeSnapshot): void;
  setRangeStyle(range: RangeSnapshot, patch: StylePatch): void;
}
```

行为细节：

- 每次 `tx.*` 调用会立即做范围、预算、矩阵形状校验；不合法会立刻抛错。
- 所有登记的操作在 `fn` 返回后按登记顺序**同步执行**，然后整体进入一次历史记录。
- `fn` 可以是异步函数；事务期间不要假设表格已经变化，读操作请在事务前后用 `doc.getRangeValues()` 完成。
- 一次事务同样受 20,000 格/次的限制，**每个** `tx` 调用单独校验。

示例：

```ts
await doc.transact('导入数据', (tx) => {
  tx.clearRange({ startRow: 0, startColumn: 0, endRow: 99, endColumn: 9 });
  tx.setRangeValues(
    { startRow: 0, startColumn: 0, endRow: 2, endColumn: 2 },
    [
      ['名称', '数量', '金额'],
      ['A', 10, 99.5],
      ['B', 20, 168],
    ]
  );
  tx.setRangeStyle(
    { startRow: 0, startColumn: 0, endRow: 0, endColumn: 2 },
    { bl: 1 }
  );
});
// 用户按一次 Ctrl+Z 即可整体撤销
```

### 6.7 事件

#### `onDidChange(cb): Disposable`

订阅文档变更。回调参数：

```ts
interface DocumentChangeEvent {
  kind: 'content' | 'selection' | 'sheet';
  origin: 'local' | 'remote' | 'plugin';
}
```

| 项目 | 内容 |
| --- | --- |
| 权限 | 订阅本身不校验权限；读取数据的方法才校验 `document:read` |
| 触发 | `content`：单元格/行列/样式等内容变化；`selection`：选区变化；`sheet`：切换/重命名等表级变化 |
| 合并 | 同一微任务内的同类变更合并为**一次回调**；同一事件循环内多个 kind 会各回调一次 |
| origin | 插件经宿主写入时为 `'plugin'`；其他本地变更、远端协同变更在当前实现中均为 `'local'`；`'remote'` 已预留但 v1 不会发出 |
| 异常 | 回调抛错会被宿主捕获记录，不影响其他监听者 |
| 释放 | 返回 `Disposable` |

事件**不携带变更数据**。收到 `content` 后需要重新调用 `getRangeValues()` 读取当前值。

#### `onDidChangeSelection(cb): Disposable`

选区变化回调，参数为 `{ selection: SelectionSnapshot }`，与 `onDidChange` 的 `selection` 共用同一套合并逻辑。

```ts
ctx.subscriptions.push(
  doc.onDidChangeSelection(({ selection }) => {
    ctx.logger.debug('选区', selection.active, selection.ranges);
  })
);
```

### 6.8 一次写入的完整链路

```text
doc.setRangeValues(range, values)
  → 宿主校验：会话存在 / document:write / canWrite / 范围合法 / ≤20,000 格 / 矩阵形状
  → 构造 IEdit（先捕获旧值）
  → engine.execute(edit)
      → History.push(edit)              一次撤销单元
      → 单元格矩阵变更
      → DocSync 的变更钩子写入 Y.Doc    协同广播
      → engine 发出 content-change
  → 插件的 onDidChange({ kind: 'content', origin: 'plugin' })
  → React UI 与其他协作者收到变更
```

由此得到几条必须遵守的规则：

- **不要直接改 `engine.workbook` / `worksheet.cellData` / Y.Doc**。绕过 `engine.execute` 的写入不进撤销栈，也不会同步给协作者。
- **一次 API 调用 = 一个撤销单元**；多条写入用 `transact` 合并。
- **只读拦截有两层**：宿主在 API 入口抛 `E_PLUGIN_READ_ONLY`，引擎自身的 `readOnly` 兜底。
- **结构操作（增删/重命名工作表）v1 不开放**。现有结构方法没有进入 History，暴露出来会破坏撤销语义。
- **单元格数上限 20,000**；更大的写入请分批，并用 `transact` 合成撤销单元。
- 写入本身在调用时同步执行完毕，Promise 只是 API 形态；并发事务按各自 `fn` 完成顺序依次应用。

### 6.9 文档 API 速查表

| 方法 | 权限 | 同步 | 进撤销栈 | 协同广播 | 主要错误 |
| --- | --- | --- | --- | --- | --- |
| `documents.active()` | — | 是 | — | — | — |
| `documents.onDidOpen()` | — | 是 | — | — | — |
| `documents.onDidClose()` | — | 是 | — | — | — |
| `getSelection()` | read | 是 | 否 | 否 | PERMISSION / DISPOSED |
| `setSelection()` | read | 否 | 否 | 选区 awareness（编辑者） | PERMISSION / DISPOSED |
| `getSheets()` | read | 是 | 否 | 否 | PERMISSION / DISPOSED |
| `getActiveSheetId()` | read | 是 | 否 | 否 | + NO_DOCUMENT |
| `setActiveSheet()` | read | 否 | 否 | 否（本地视图） | PERMISSION / DISPOSED |
| `getRangeValues()` | read | 否 | 否 | 否 | + INVALID_RANGE / RANGE_TOO_LARGE |
| `getSnapshot()` | read | 否 | 否 | 否 | PERMISSION / DISPOSED |
| `setRangeValues()` | write | 否 | **是** | **是** | + READ_ONLY / INVALID_INPUT |
| `clearRange()` | write | 否 | **是** | **是** | + READ_ONLY / INVALID_RANGE |
| `setRangeStyle()` | write | 否 | **是** | **是** | + READ_ONLY / RANGE_TOO_LARGE |
| `transact()` | write | 否 | **是（整体一个）** | **是** | + READ_ONLY / INVALID_INPUT |
| `onDidChange()` | — | 是 | — | — | — |
| `onDidChangeSelection()` | — | 是 | — | — | — |

---

## 7. 与界面交互：命令 API

```ts
interface CommandApi {
  register(id: string, handler: (...args: unknown[]) => unknown | Promise<unknown>): Disposable;
  execute<T = unknown>(id: string, ...args: unknown[]): Promise<T>;
}
```

### `register(id, handler)`

| 项目 | 内容 |
| --- | --- |
| `id` 约束 | `^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$`，建议用插件前缀（如 `csvTools.exportSelection`） |
| 重复 | 命令表是**全局**的；同一 id 被任何插件注册过都会抛 `E_PLUGIN_COMMAND_DUPLICATE`，并导致当前插件激活失败 |
| handler | 任意函数；参数由 `execute` 透传；可以返回 Promise |
| 释放 | 返回 `Disposable`，并自动加入 `context.subscriptions` |
| manifest | 运行时注册的命令**不要求**在 `contributes.commands` 中声明；但 manifest 按钮引用的命令必须声明 |

### `execute(id, ...args)`

| 项目 | 内容 |
| --- | --- |
| 范围 | 只能执行**当前插件自己**注册的命令 |
| 激活 | 执行前会先确保插件已激活；插件激活失败抛 `E_PLUGIN_COMMAND_NOT_FOUND` |
| 返回 | handler 的返回值 |
| 错误 | `E_PLUGIN_COMMAND_NOT_FOUND`（未激活 / 未注册 / 不属于本插件）、`E_PLUGIN_DISPOSED` |

不要在 `activate` 里递归调用 `commands.execute` 自己的命令，容易造成意外重入；直接调用 handler 逻辑即可。

---

## 8. 与界面交互：UI API

```ts
interface UiApi {
  registerToolbarItem(item: ToolbarItemOptions): Disposable;
  registerStatusBarItem(item: StatusBarItemOptions): Disposable;
  registerMenuItem(item: MenuItemOptions): Disposable;
  registerPanel(panel: PanelOptions): Disposable;
  showMessage(level: 'info' | 'success' | 'warning' | 'error', message: string): void;
}
```

### 8.1 通用条目字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 否 | 不传时宿主自动生成；同一插件内唯一即可（宿主内部会加插件前缀） |
| `title` | 是 | 按钮文字 / Tooltip；工具栏和状态栏注册时会校验非空，菜单项建议同样提供 |
| `icon` | 否 | 插件包内相对路径或完整 URL；相对路径会拼上插件 `baseUrl` |
| `order` | 否 | 越小越靠前，默认 `100` |
| `requiresWrite` | 否 | 当前文档只读时宿主自动禁用该按钮 |
| `command` | 二选一 | 点击时执行已注册命令（会先激活插件） |
| `onClick` | 二选一 | 运行时回调；manifest 贡献不支持该字段 |

`command` 与 `onClick` 至少给一个；同时给时 `command` 优先。

### 8.2 各注册方法

| 方法 | 额外必填 | 可用插槽 |
| --- | --- | --- |
| `registerToolbarItem` | `slot` | `editor.titleBar.start` / `editor.titleBar.end` / `sheet.toolbar.start` / `sheet.toolbar.end` |
| `registerStatusBarItem` | `slot` | `sheet.statusBar.start` / `sheet.statusBar.end` |
| `registerMenuItem` | `menu` | `sheet.contextMenu` / `editor.more`；可选 `group` |
| `registerPanel` | `id`、`title`、`slot: 'editor.sidebar'` | v1 **空实现**：只记一条日志并返回空 `Disposable`，不渲染 |

再次强调渲染现状：

- 实际渲染的插槽只有 `editor.titleBar.end`、`sheet.toolbar.end`、`sheet.statusBar.end`。
- `start` 系列、菜单、面板在 v1 都**不会显示**。如果插件必须出现在界面上，请使用 `.end` 插槽。
- 工具栏按钮：有 `icon` 时显示 16×16 图标 + Tooltip；没有 `icon` 时显示文字。

### 8.3 `showMessage(level, message)`

通过宿主 antd 的 `App.useApp()` 实例弹出全局消息，主题/上下文与宿主一致。不要自己 import antd 的静态 `message`。

| level | 表现 |
| --- | --- |
| `info` | 普通提示 |
| `success` | 成功提示 |
| `warning` | 警告提示 |
| `error` | 错误提示 |

---

## 9. 与服务交互：设置 API

```ts
interface SettingsApi {
  get<T>(key: string): T | undefined;
  onChange(cb: (key: string, value: unknown) => void): Disposable;
}
```

| 项目 | 内容 |
| --- | --- |
| 数据来源 | manifest `settings` 默认值 + 管理端覆盖；只有 `scope: 'client'` 的项会下发 |
| `get` | 同步读取；key 不存在返回 `undefined` |
| `onChange` | v1 **空实现**：设置只在插件激活时快照，不支持热更新；返回的 `Disposable` 无副作用 |
| 生效时机 | 管理端修改后，需要重新拉取索引（刷新页面/重新登录）才会生效 |

---

## 10. 与服务交互：存储 API

```ts
interface StorageApi {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}
```

| 项目 | 内容 |
| --- | --- |
| 权限 | 必须声明 `storage`，否则抛 `E_PLUGIN_PERMISSION` |
| 后端 | 浏览器 `localStorage` |
| 命名空间 | `pgclouddoc.plugin.<pluginId>.<userId>.<key>`，插件之间、用户之间互相隔离 |
| 配额 | 单个插件单用户 **1 MB**（按 UTF-16 字符数 ×2 估算 key + value） |
| 序列化 | JSON；不可序列化的值抛 `E_PLUGIN_INVALID_INPUT` |
| `get` | 读不到或 JSON 解析失败返回 `null` |
| `set` | 超配额 / 浏览器存储不可用抛 `E_PLUGIN_STORAGE_QUOTA` |
| `delete` | 删除失败静默忽略 |
| `keys` | 返回去掉命名空间前缀后的插件自己的 key |
| 生命周期 | 退出登录后数据仍保留；宿主不会自动清理 |

> 不要把文档内容、用户隐私或超过 1 MB 的数据放进 `storage`。它适合保存「上次使用的分隔符」「面板展开状态」这类小配置。

---

## 11. 日志、订阅与上下文属性

### logger

```ts
ctx.logger.info('导出 CSV', { rows, delimiter });
```

四个级别 `debug / info / warn / error`，统一加 `[plugin:<pluginId>]` 前缀，输出到浏览器控制台。

### subscriptions

```ts
ctx.subscriptions.push(doc.onDidChange(() => { /* ... */ }));
```

- 插件停用、退出登录、页面卸载时，宿主会逐个 `dispose()`。
- `commands.register`、`ui.register*` 的返回值**已经自动加入**，无需重复 push；重复 push 不会报错，但会重复释放。
- `deactivate()` 里不要把宿主已经代劳的清理再写一遍。

### 其他属性

| 属性 | 用途 |
| --- | --- |
| `pluginId` / `pluginVersion` | 日志、存储 key、上报 |
| `hostVersion` | 运行时判断宿主平台版本（如 `1.0.0`） |
| `apiVersion` | 插件 API 主版本（`"1"`） |
| `hasPermission(p)` | 查询 manifest 是否声明了某权限，避免无谓的调用和报错 |

---

## 12. 权限模型

manifest `permissions` 允许的值：

| 权限 | v1 是否强制 | 作用范围 |
| --- | --- | --- |
| `document:read` | **是** | `getSelection`、`setSelection`、`getSheets`、`getActiveSheetId`、`setActiveSheet`、`getRangeValues`、`getSnapshot` |
| `document:write` | **是** | `setRangeValues`、`clearRange`、`setRangeStyle`、`transact`；同时要求当前用户可编辑 |
| `document:structural` | 否（预留） | 结构操作 v1 不开放 |
| `storage` | **是** | `context.storage` 全部方法 |
| `clipboard:write` | 否（预留） | v1 没有宿主剪贴板 API |
| `notifications` | 否 | `ui.showMessage` 当前不校验该权限 |

补充说明：

- 订阅类接口（`onDidChange`、`onDidChangeSelection`、`onDidOpen`）不做权限校验；插件仍应在 manifest 中声明 `document:read`，不要依赖未声明的能力。
- UI 贡献不做运行时权限控制；`requiresWrite` 只控制「文档只读时禁用按钮」。
- 网络访问**没有对应权限**，也无法在 same-realm 中限制，见 16。

最小权限原则：只声明真正用到的权限；管理端审核页会展示权限清单。

---

## 13. 错误码

所有文档/命令/存储错误都是 `PluginApiError`，带有可编程判断的 `code`：

```ts
import { PluginApiError } from '@pgclouddoc/plugin-api/errors';

try {
  await doc.setRangeValues(range, values);
} catch (err) {
  if (err instanceof PluginApiError && err.code === 'E_PLUGIN_READ_ONLY') {
    ctx.ui.showMessage('warning', '当前文档只读');
  }
}
```

| code | 触发场景 |
| --- | --- |
| `E_PLUGIN_READ_ONLY` | 文档只读、用户无编辑角色或引擎只读时写入 |
| `E_PLUGIN_PERMISSION` | manifest 未声明对应权限 |
| `E_PLUGIN_RANGE_TOO_LARGE` | 单次操作超过 20,000 格 |
| `E_PLUGIN_INVALID_RANGE` | 坐标为负/非整数、范围完全越界、工作表不存在 |
| `E_PLUGIN_INVALID_INPUT` | 矩阵形状不匹配、值类型非法、命令 id/UI 参数非法、存储值不可序列化 |
| `E_PLUGIN_NO_DOCUMENT` | 没有活动工作表（如 `getActiveSheetId` 时工作簿为空） |
| `E_PLUGIN_DISPOSED` | 文档已关闭、插件宿主已销毁 |
| `E_PLUGIN_COMMAND_NOT_FOUND` | 命令未注册、不属于当前插件、插件激活失败 |
| `E_PLUGIN_COMMAND_DUPLICATE` | 命令 id 已被其他插件注册 |
| `E_PLUGIN_STORAGE_QUOTA` | 存储超配额、localStorage 不可用 |

命令 handler 抛出的异常：

- 通过 manifest / 运行时 UI 按钮触发时，宿主捕获异常，写入控制台并通过 `ui` 提示「插件 xxx 执行失败：…」；
- 通过 `context.commands.execute()` 主动调用时，Promise 正常 reject，由调用方处理。

插件不需要为整个命令包一层兜底 try/catch，但应当处理可预期的业务错误（如只读、范围过大）。

---

## 14. 与服务交互：外部服务

插件运行不只依赖宿主 API，还依赖下面这些**外部服务与端点**。按调用方分成三组：宿主前端、管理后台、插件自身。

### 14.1 拓扑

```text
┌──────────────────────────── 浏览器（同一 realm）────────────────────────────┐
│  插件代码 ──context.documents──> 宿主文档会话 ──> engine.execute             │
│     │                              ├─> History（撤销/重做）                  │
│     │                              ├─> DocSync ──WebSocket /collab/──> 协同服务 │
│     │                              └─> React UI                             │
│     ├──context.storage──────────> localStorage                              │
│     └──自身 fetch/XHR/WebSocket──> 同源 REST（携带登录 Cookie）              │
│                                  └> 第三方服务（受 CORS 约束）               │
│                                                                             │
│  宿主前端                                                                   │
│     ├─GET /api/v1/plugins/index──────> NestJS ──> PostgreSQL / etcd         │
│     ├─GET /api/v1/config─────────────> NestJS ──> etcd                      │
│     └─GET /plugin-assets/<id>/<ver>/ > nginx（生产）/ express.static（开发） │
│                                                                             │
│  开发模式                                                                   │
│     └─GET http://localhost:517x/plugin.dev.json + /src/index.ts（Vite）     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 14.2 外部服务总表

除开发服务器外，下表中的地址都是**同源相对路径**；开发环境由 Vite 把 `/api`、`/plugin-assets` 代理到后端 `http://localhost:3000`。

| 服务 | 地址 / 方法 | 调用方 | 鉴权 | 用途 |
| --- | --- | --- | --- | --- |
| 插件索引 | `GET /api/v1/plugins/index` | 宿主前端 | 登录 JWT（全局 `JwtAuthGuard`） | 下发启用且已发布的插件 |
| 公共配置 | `GET /api/v1/config` | 宿主前端启动时 | 匿名 | client scope 配置（品牌等）；`plugins.*` 开关同属该 scope，但由服务端索引接口消费 |
| 插件静态产物 | `GET /plugin-assets/<pluginKey>/<version>/<file>` | 浏览器 `import()` / `<link>` / `<img>` | 无 | ESM、CSS、图标等 |
| 协同 WebSocket | `WS /collab/` | 宿主 DocSync | 文档会话鉴权 | 把本地/插件写入的变更同步给其他协作者 |
| 管理端插件列表 | `GET /api/v1/admin/plugins` | 管理后台 | `ADMIN` 角色 | 插件、版本、启用状态 |
| 管理端上传 | `POST /api/v1/admin/plugins/upload` | 管理后台 | `ADMIN` 角色 | multipart 上传 zip |
| 管理端启停/切版本 | `PUT /api/v1/admin/plugins/:pluginKey/installation` | 管理后台 | `ADMIN` 角色 | `{ enabled?, version? }` |
| 开发清单 | `GET http://localhost:517x/plugin.dev.json` | 宿主前端（仅 DEV） | 无，`Access-Control-Allow-Origin: *` | 开发模式 manifest |
| 开发入口 | `GET http://localhost:517x/src/index.ts` | 宿主前端（仅 DEV） | 无 | Vite 转译的 ESM 入口 |
| 配置中心 | etcd `<ETCD_CONFIG_PREFIX>/client/...` | 后端 | etcd 账号 | `plugins.enabled`、`plugins.blocked` |
| 注册表存储 | PostgreSQL `plugins` / `plugin_versions` / `plugin_installations` / `audit_logs` | 后端 | 数据库账号 | 插件真源、版本、启用关系、审计 |
| 产物存储 | 磁盘 `PLUGIN_STORAGE_DIR` | 后端写入 / nginx 只读 | 文件系统 | zip 与解包后的静态文件 |

> 协同 WebSocket 由宿主 `DocSync` 独占。插件不要自行建立 `/collab/` 连接或直接改 Y.Doc；按 6.8 的方式通过文档 API 写入，宿主会负责撤销与协同广播。

### 14.3 插件索引：`GET /api/v1/plugins/index`

宿主在用户登录后调用一次（每次页面加载一次），用于发现插件。实现：[plugin-registry.ts](../frontend/src/app/plugins/host/plugin-registry.ts)。

请求：

```http
GET /api/v1/plugins/index
Cookie: <登录会话>
```

响应（`PluginIndex`）：

```json
{
  "revision": 1761900000,
  "hostApiVersion": "1",
  "killSwitch": false,
  "plugins": [
    {
      "id": "com.pgclouddoc.csv-tools",
      "version": "1.0.0",
      "baseUrl": "/plugin-assets/com.pgclouddoc.csv-tools/1.0.0/",
      "entry": "dist/main.js",
      "style": "dist/main.css",
      "sha256": "…",
      "engines": { "pgclouddoc": ">=1.0.0 <2.0.0", "pluginApi": "1" },
      "activationEvents": ["onCommand:csvTools.exportSelection"],
      "contributes": { "commands": [], "toolbar": [] },
      "permissions": ["document:read", "document:write"],
      "settings": { "delimiter": "," }
    }
  ]
}
```

服务端行为（[plugin.service.ts](../backend/src/features/plugins/plugin.service.ts)）：

- 只返回 `enabled = true`、版本状态 `PUBLISHED`、`scope = GLOBAL` 的安装记录。
- `plugins.enabled === false`（etcd client 配置）→ 返回 `killSwitch: true` 且插件列表为空。
- `plugins.blocked` 数组中的 id 会被过滤掉。
- `settings` 只合并 `client` scope 的默认值和管理端覆盖。
- 按 id 字典序排序；`revision` 取所有安装记录 `updatedAt` 的最大秒级时间戳。
- 索引变更**不会推送**：管理端启用/禁用/切版本后，客户端要刷新页面（重新拉索引）才生效。

客户端行为：

- 超时 **2 秒**；失败回退到 `localStorage['pgclouddoc.plugin_index.v1']`，缓存有效期 **24 小时**。
- `killSwitch = true` 时不加载任何插件。
- `engines.pluginApi` 必须等于 `"1"`，且 `engines.pgclouddoc` 必须满足宿主版本（当前 `1.0.0`），否则跳过该插件。
- 索引只拉 manifest，不下载插件代码；代码在命中激活条件时才加载。

### 14.4 插件静态产物：`/plugin-assets/...`

- 路径由索引的 `baseUrl + entry` 拼成：`/plugin-assets/<encodeURIComponent(id)>/<encodeURIComponent(version)>/<entry>`。
- 生产：nginx `location /plugin-assets/` 直接 `alias` 到只读卷，`Cache-Control: public, max-age=31536000, immutable`，并带 `X-Content-Type-Options: nosniff`。
- 开发 / 单进程部署：后端 `express.static(PLUGIN_STORAGE_DIR/assets)`，同样长缓存 + nosniff；开发时 Vite 还会把 `/plugin-assets` 代理到后端 3000。
- 版本目录不可变，新版本 = 新 URL，不存在缓存污染。
- **静态产物没有登录校验**：知道 URL 即可下载。插件包里不能放密钥、Token、内部地址。

### 14.5 开发服务器

仅在 `import.meta.env.DEV` 下启用。宿主读取开发映射：

```js
// localStorage['pgclouddoc.plugin-dev']
JSON.stringify({
  'com.pgclouddoc.csv-tools': 'http://localhost:5174/',
  'com.pgclouddoc.excel-agent': 'http://localhost:5175/'
})
```

或设置前端环境变量 `VITE_PLUGIN_DEV` 为同一段 JSON。

| 项目 | 说明 |
| --- | --- |
| manifest | `GET <baseUrl>plugin.dev.json`，由 Vite 中间件实时读取 `plugin.json`，把 `entry` 改写为 `src/index.ts` 并去掉 `style` |
| 入口 | `GET <baseUrl>src/index.ts`，Vite 负责 TS 转换与 HMR |
| CORS | 开发服务器返回 `Access-Control-Allow-Origin: *`，manifest 响应 `Cache-Control: no-store` |
| 端口 | csv-tools 5174，excel-agent 5175；`strictPort: true` |
| 优先级 | 同 id 时开发配置**覆盖**服务端版本 |
| 生产 | 这段逻辑用 `import.meta.env.DEV` 包裹，生产构建不会加载任意远程插件 |

### 14.6 管理端接口

全部要求 `ADMIN` 角色（[AdminGuard](../backend/src/features/users/admin.guard.ts) 在全局 `JwtAuthGuard` 之后校验数据库里的 role）。

| 接口 | 请求 | 说明 |
| --- | --- | --- |
| `GET /api/v1/admin/plugins` | — | 列表：`pluginKey`、`name`、`enabled`、`activeVersion`、`permissions`、`activationEvents`、`versions[]`、`updatedAt` |
| `POST /api/v1/admin/plugins/upload` | `multipart/form-data`，字段名 `file`，`.zip` | 校验 → 解包 → 原子发布 → 写库 → 审计；成功后立即成为当前版本 |
| `PUT /api/v1/admin/plugins/:pluginKey/installation` | `{ "enabled"?: boolean, "version"?: string }` | 至少给一个字段；`version` 必须是已发布版本；用于启停和切换版本 |

上传限制与行为：

- 后端 zip 上限 **50 MB**；nginx 对上传路径单独放宽到 `client_max_body_size 60m`，读超时 120 秒。
- 校验项见 3.5；任何一项失败返回 4xx，不落库。
- 同一 `id + version` 已存在返回 `409`，版本发布后不可覆盖。
- 新版本上传后：
  - 首次上传：创建安装记录并默认 `enabled = true`；
  - 已有安装：只切换当前版本，**保留原有启用状态**。
- 审计动作：`plugin.upload`、`plugin.version_switch`、`plugin.enable`、`plugin.disable`（写 `audit_logs`）。
- 文件布局：`zips/<pluginKey>/<version>.zip`、`assets/<pluginKey>/<version>/...`、`tmp/<uuid>/`；DB 失败会回滚已落盘的产物。

### 14.7 etcd 配置中心（kill switch）

配置中心把 client scope 的键挂在等价的 etcd 路径下：

```text
<ETCD_CONFIG_PREFIX>/client/plugins.enabled   = false        # 全局 kill switch
<ETCD_CONFIG_PREFIX>/client/plugins.blocked    = ["com.x.y"] # 按 id 屏蔽
```

`ETCD_CONFIG_PREFIX` 默认 `/pgclouddoc/dev/config`（见 `backend/.env.example`）。后端读取后直接影响索引响应：

- `plugins.enabled === false` → `killSwitch: true`，客户端不加载任何插件；
- `plugins.blocked` 中的 id → 从索引中剔除；
- 修改通过管理后台的「配置中心」页面完成，**下一次索引请求**生效，不是实时推送。

### 14.8 数据库与磁盘

| 存储 | 内容 |
| --- | --- |
| PostgreSQL `plugins` | 逻辑插件（`pluginKey`、名称、作者、主页） |
| PostgreSQL `plugin_versions` | 不可变版本：manifest、entry、sha256、大小、状态、发布时间 |
| PostgreSQL `plugin_installations` | 当前启用的版本：`scope`（v1 只用 `GLOBAL`）、`enabled`、`settings` 覆盖 |
| PostgreSQL `audit_logs` | 上传、启停、切版本审计 |
| 磁盘 `PLUGIN_STORAGE_DIR` | `zips/` 原始包、`assets/` 解包产物、`tmp/` 上传临时目录 |

部署相关：

- 开发默认 `PLUGIN_STORAGE_DIR=./var/plugins`；
- 生产 compose 使用 `/data/plugins` 持久卷，nginx 只读挂载到 `/var/lib/pgclouddoc/plugins/assets/`；
- nginx 对 `/api/v1/admin/plugins/upload` 单独放宽请求体，其余接口保持默认 8m。

### 14.9 浏览器 localStorage 键

| key | 写入方 | 内容 |
| --- | --- | --- |
| `pgclouddoc.plugin-dev` | 开发者 | 开发插件映射 `{ [pluginId]: baseUrl }`，仅 DEV 读取 |
| `pgclouddoc.plugin_index.v1` | 宿主 | 最近一次成功的插件索引 + `savedAt`，有效期 24 小时 |
| `pgclouddoc.plugin.<pluginId>.<userId>.<key>` | `context.storage` | 插件自身的键值数据，单插件 1 MB |

### 14.10 插件自身调用的外部服务

宿主**不提供**网络 API，也**不限制**插件发起网络请求。插件运行在页面 realm 里，可以直接使用：

- `fetch` / `XMLHttpRequest` / `WebSocket`；
- 同源 `/api/...`：请求会携带当前用户的登录 Cookie，**以该用户的身份和权限执行**；
- 第三方域名：受浏览器 CORS 和目标服务自身鉴权约束。

因此：

1. manifest 没有「网络」权限；审核时只能审代码。**插件必须在自己的 README 里列清楚调用了哪些外部服务**（域名、用途、发送的数据、是否携带凭据），供管理端审核。
2. 插件包的静态文件公开可下载，**禁止在打包产物里写死任何密钥、Token、内部地址**。需要密钥时，把服务放在自己的后端，由插件调用该后端。
3. 同源调用会以登录用户身份进行。不要利用它绕过界面权限读取用户无权访问的数据；所有同源接口仍会执行自己的鉴权。
4. 第三方请求要自己处理超时、失败、重试与用户提示；宿主不会为插件的网络请求兜底。
5. 当前页面没有配置 CSP，宿主也无法在 same-realm 中拦截 `fetch`。这是可信插件层的固有代价；第三方插件进入沙箱层后才会由 iframe CSP 限制 `connect-src`。

外部服务声明示例（写进插件 README）：

```md
## 外部服务

| 服务 | 地址 | 用途 | 发送的数据 | 凭据 |
| --- | --- | --- | --- | --- |
| 汇率 API | https://api.example.com/rates | 汇率换算 | 币种、日期 | 无 |
| 自建代理 | https://proxy.example.com | 隐藏第三方密钥 | 选区数据 | 后端会话 |
```

---

## 15. 开发、构建与发布

### 15.1 本地开发

```bash
pnpm install
pnpm build:plugin-api      # 首次或协议包变更后
pnpm dev:plugin            # csv-tools，5174
pnpm dev:plugin:excel      # excel-agent，5175
```

登录后、打开文档前，在浏览器控制台配置开发映射（见 14.5），然后打开任意文档。开发插件同 id 时覆盖服务端版本。

### 15.2 构建

```bash
pnpm build:plugin                                      # 构建所有插件
pnpm build:plugin:excel                                # 只构建 excel-agent
pnpm --filter @pgclouddoc/plugin-csv-tools build       # 只构建 csv-tools（在仓库根执行）
```

产物：

```text
plugins/<plugin>/dist/                          # ESM（main.js + sourcemap）
plugins/<plugin>/release/<id>-<version>.zip     # plugin.json + dist + README/LICENSE
plugins/<plugin>/release/<id>-<version>.json    # zip 与各文件的 SHA-256、大小
```

构建约定：

- `manifest.entry` 必须在 `dist/` 下；构建文件名固定 `dist/main.js`。
- `react`、`react-dom`、`react/jsx-runtime`、`react-dom/client`、`antd`、`@pgclouddoc/plugin-api` 在构建时 external，由宿主提供同一实例。
- Vite 输出 `format: 'es'`、`target: es2022`、sourcemap。
- zip 即管理端上传接口的输入；浏览器不会下载 zip。

### 15.3 发布与更新语义

1. 用管理员账号进入 **管理后台 → 插件管理 → 上传插件**，选择 zip；
2. 服务端校验 manifest、路径、文件类型与解压体积，原子发布并设为当前版本（新插件默认启用；已有插件保留原启用状态）；
3. 客户端下次加载页面时拉取新索引，命中激活条件后加载新版本代码；
4. 同一 `id + version` 不可覆盖，修改后必须升版本；
5. 版本切换、禁用、kill switch 都需要**刷新页面**才在客户端生效；
6. ESM 模块无法卸载：已在运行的页面继续使用旧模块，重新加载后全部生效。

---

## 16. 安全边界

必须如实理解以下边界，不要向用户承诺宿主能完全隔离插件：

| 边界 | 现状 |
| --- | --- |
| 执行环境 | 与宿主同一 realm，没有 iframe/Worker 沙箱 |
| 同步死循环 | 宿主无法抢占，只能靠审核、失败隔离与刷新页面 |
| DOM / window | 插件可以直接访问和修改 |
| 网络 | 无权限限制；同源请求携带用户 Cookie |
| 同源 API | 以登录用户身份调用，依赖接口自身鉴权 |
| 静态产物 | 公开可读，不能放敏感信息 |
| 错误隔离 | 激活、命令、事件、UI 回调都有 try/catch，单插件失败不影响其他插件与宿主 |
| 模块卸载 | 不支持；停用只释放登记资源 |
| 密钥 | 不能放进插件包；必须放在插件自己的后端 |

插件作者的责任：

- 只声明真正需要的权限；
- 不读取、不持久化与功能无关的文档内容；
- 不在模块顶层持有文档/用户数据；
- 外部服务与数据流向在 README 中声明；
- 所有注册/监听放进 `subscriptions`，在 `onDidClose` 后不再使用旧文档对象。

---

## 17. 开发检查清单

### 包与清单

- [ ] `plugin.json` 通过 `parseManifest` 校验（构建脚本会自动跑）
- [ ] `id` 反向域名、`version` 为 semver，升级版本后再发布
- [ ] `entry` / `style` / `icon` 指向的文件都在 zip 内
- [ ] `permissions` 最小化；需要存储才声明 `storage`
- [ ] manifest 按钮引用的命令都在 `contributes.commands` 中声明
- [ ] 使用了 `.end` 插槽（v1 的 `.start`、菜单、面板不渲染）

### 代码

- [ ] 只 import `@pgclouddoc/plugin-api` 的类型，不 import 宿主内部模块
- [ ] 所有注册/监听放进 `context.subscriptions`
- [ ] 写操作前检查 `doc.canWrite`，并处理 `E_PLUGIN_READ_ONLY`
- [ ] 多条写入用 `transact` 合成一次撤销
- [ ] 单次读写 ≤ 20,000 格，大批量分批
- [ ] 优先 `getRangeValues`，避免对大文档频繁 `getSnapshot`
- [ ] 文档关闭后不再使用旧 `SheetDocumentApi`
- [ ] 不在模块顶层持有文档、用户、定时器或全局监听
- [ ] 外部服务在 README 中列明，插件包内没有密钥

### 发布

- [ ] 本地 `pnpm typecheck` / 构建通过
- [ ] zip 体积、文件类型符合 3.5
- [ ] 管理端上传后，刷新页面验证索引、激活、按钮、读写、撤销与协同
- [ ] 只读用户、未登录、索引失败（断网）三种场景都有降级表现
