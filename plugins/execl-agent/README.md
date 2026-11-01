# 表格内容输出（excel-agent）

一个最小只读插件：在表格工具栏右侧新增「输出表格」按钮，点击后读取当前工作簿的完整快照，并输出到浏览器控制台。

宿主通用契约见 [../PLUGIN-API.md](../PLUGIN-API.md)。本文按三类交互组织：**与文档交互、与界面交互、与服务交互**。

## 插件身份与能力

| 项目 | 值 |
| --- | --- |
| id | `com.pgclouddoc.excel-agent` |
| version | `0.1.0` |
| entry | `dist/main.js` |
| 激活事件 | `onCommand:excelAgent.dumpToConsole` |
| 权限 | `document:read` |
| 设置 | 无 |
| 导出 | `activate(ctx)`；未实现 `deactivate` |

## 接口总览

| 交互对象 | 本插件使用的接口 | 用途 |
| --- | --- | --- |
| 文档 | `documents.active()`、`doc.title`、`doc.getSnapshot()` | 找到当前文档并读取整簿快照 |
| 界面 | manifest 命令 + 工具栏贡献、`commands.register`、`ui.showMessage` | 提供按钮入口、注册命令、反馈结果 |
| 服务 | 插件索引、`/plugin-assets/` 静态产物、开发服务器 | 发现插件、加载代码、本地调试 |

---

## 一、与文档交互的接口

### `ctx.documents.active()`

| 项目 | 内容 |
| --- | --- |
| 权限 | 无 |
| 同步性 | 同步 |
| 作用 | 取当前打开的文档 |
| 返回 | 有文档时返回 `SheetDocumentApi`；不在编辑页时返回 `null` |
| 副作用 | 无：不写文档、不进撤销栈、不协同广播 |
| 错误 | 无 |

返回 `null` 时插件提示「请先打开一个文档」并结束。

### `doc.title`

| 项目 | 内容 |
| --- | --- |
| 权限 | 无 |
| 作用 | 读取文档标题 |
| 用途 | 控制台输出「文档「xxx」内容」 |
| 副作用 | 无 |

### `doc.getSnapshot()`

| 项目 | 内容 |
| --- | --- |
| 权限 | `document:read` |
| 同步性 | 异步 |
| 作用 | 返回整份工作簿的只读 JSON 快照 |
| 返回 | `Record<string, unknown>`，结构兼容引擎的 `IWorkbookData` |
| 副作用 | **无**：不写文档、不进撤销栈、不触发协同广播 |
| 限制 | 没有单元格数量上限；大文档序列化开销明显 |
| 错误 | `E_PLUGIN_PERMISSION`、`E_PLUGIN_DISPOSED` |

快照说明：

- 包含工作簿 id / 名称 / 所有工作表 / 共享样式表 / 原样保留的 `resources`；
- 公式只存原文，不计算结果；
- 快照是一次性拷贝，修改它不会影响文档；
- 文档关闭后再调用会抛 `E_PLUGIN_DISPOSED`。

> 本插件不调用任何写接口，因此不会产生撤销记录，也不参与协同写入；只读文档、无编辑角色的用户都可以使用。

---

## 二、与界面交互的接口

### manifest 入口

| 类型 | id / 插槽 | 作用 |
| --- | --- | --- |
| 命令 | `excelAgent.dumpToConsole` | 标题「输出表格内容到控制台」，分类「调试」 |
| 工具栏 | `sheet.toolbar.end`，`order: 30` | 按钮「输出表格」；未设置 `requiresWrite`，只读文档下也可点击 |

manifest 贡献在插件未激活时就会渲染按钮；用户点击时宿主负责「加载模块 → `activate` → 执行命令」，即懒激活。

### `ctx.commands.register(id, handler)`

| 项目 | 内容 |
| --- | --- |
| 用途 | 注册 `excelAgent.dumpToConsole` |
| id 约束 | `^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$`；命令表全局唯一 |
| 释放 | 返回值自动进入 `ctx.subscriptions`，停用时自动注销 |
| 错误 | id 非法或与其他插件重复时激活失败 |

### `ctx.ui.showMessage(level, message)`

| 项目 | 内容 |
| --- | --- |
| 权限 | 无（`notifications` 权限当前不校验） |
| 作用 | 调用宿主 antd `message` 弹出全局提示 |
| 使用 | `warning`：没有打开文档；`success`：输出完成 |

### 浏览器控制台

| 接口 | 用途 |
| --- | --- |
| `console.log` | 输出 `[excel-agent] 文档「xxx」内容：<snapshot>`，供 F12 Console 展开查看 |

这里直接用 `console.log` 而不是 `ctx.logger`，目的是让整份快照在控制台里可展开；`ctx.logger` 只适合短日志。

### 运行时辅助

| 接口 | 说明 |
| --- | --- |
| `ctx.subscriptions` | 收集注册返回值；插件停用、退出登录、页面卸载时统一 `dispose()` |
| `ctx.pluginId` / `pluginVersion` / `hostVersion` / `apiVersion` | 插件与宿主版本信息，可用于日志和兼容分支 |
| `ctx.hasPermission()` | 查询 manifest 是否声明了某权限 |

---

## 三、与服务交互的接口

### 宿主服务

本插件**不使用** `ctx.settings`、`ctx.storage`，也不调用任何同源 REST 接口或第三方服务。

### 平台/外部服务

| 服务 | 地址 / 方法 | 调用方 | 鉴权 | 用途 |
| --- | --- | --- | --- | --- |
| 插件索引 | `GET /api/v1/plugins/index` | 宿主前端 | 登录 JWT | 发现本插件及其当前版本 |
| 插件静态产物 | `GET /plugin-assets/com.pgclouddoc.excel-agent/0.1.0/dist/main.js` | 浏览器 `import()` | 无 | 加载插件 ESM 入口 |
| 开发服务器（仅 DEV） | `GET http://localhost:5175/plugin.dev.json`、`GET http://localhost:5175/src/index.ts` | 宿主前端 | 无，CORS `*` | 本地开发时提供 manifest 与转译后的入口 |

### 插件自身的外部调用

**没有。** 插件不访问第三方域名，不上传文档内容，不发送任何网络请求。

---

## 本地开发

```bash
pnpm build:plugin-api      # 首次需要，或根目录 pnpm typecheck 会自动构建
pnpm dev:plugin:excel      # dev server，端口 5175
```

登录后、打开文档前，在浏览器控制台设置开发插件地址：

```js
localStorage.setItem(
  'pgclouddoc.plugin-dev',
  JSON.stringify({ 'com.pgclouddoc.excel-agent': 'http://localhost:5175/' })
);
```

打开任意文档：

1. 工具栏右侧出现「输出表格」按钮；
2. 点击后浏览器控制台输出当前工作簿内容（F12 → Console）；
3. 页面右下角提示「表格内容已输出到控制台」。

> 5175 是本插件专用的 dev 端口，可以和 csv-tools 的 5174 同时运行。

## 构建发布包

```bash
pnpm build:plugin:excel
```

产物：

```text
plugins/execl-agent/release/com.pgclouddoc.excel-agent-0.1.0.zip
plugins/execl-agent/release/com.pgclouddoc.excel-agent-0.1.0.json   # 哈希元数据
```

zip 是服务端上传接口的输入；浏览器不会下载 zip。
