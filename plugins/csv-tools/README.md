# CSV 工具（csv-tools）

示例插件：把当前选区导出为 CSV，或向当前工作表 A1:C3 写入示例数据。

宿主通用契约见 [../PLUGIN-API.md](../PLUGIN-API.md)。本文按三类交互组织：**与文档交互、与界面交互、与服务交互**。

## 插件身份与能力

| 项目 | 值 |
| --- | --- |
| id | `com.pgclouddoc.csv-tools` |
| version | `1.0.0` |
| entry | `dist/main.js` |
| 激活事件 | `onCommand:csvTools.exportSelection`、`onCommand:csvTools.fillDemo` |
| 权限 | `document:read`、`document:write` |
| 设置 | `delimiter`（enum，默认 `,`，可选 `,` `;` `\t`） |
| 导出 | `activate(ctx)`；未实现 `deactivate` |

## 接口总览

| 交互对象 | 本插件使用的接口 | 用途 |
| --- | --- | --- |
| 文档 | `documents.active()`、`getSelection()`、`getRangeValues()`、`doc.title`、`canWrite`、`transact()`、`tx.setRangeValues()` | 读取选区导出；写入示例数据 |
| 界面 | manifest 两个命令 + 两个工具栏按钮、`commands.register`、`ui.showMessage` | 提供按钮入口、注册命令、反馈结果 |
| 服务 | `settings.get('delimiter')`、插件索引、`/plugin-assets/`、开发服务器 | 读取服务端配置、发现插件、加载代码 |

---

## 一、与文档交互的接口

### 命令 `csvTools.exportSelection` 使用

| 接口 | 权限 | 同步性 | 作用与副作用 |
| --- | --- | --- | --- |
| `documents.active()` | 无 | 同步 | 取当前文档；无副作用；不在编辑页返回 `null` |
| `doc.getSelection()` | `document:read` | 同步 | 读取选区；只使用 `ranges[0]`；不改文档、不进撤销栈 |
| `doc.getRangeValues(range)` | `document:read` | 异步 | 读取选中范围的单元格快照；无副作用；≤20,000 格 |
| `doc.title` | 无 | 同步 | 用作下载文件名；空标题回退为 `selection` |

读取规则：

- 一次只导出**第一个选区块**（`selection.ranges[0]`），多选区不会合并；
- 范围会先归一化（起止颠倒自动交换）并裁剪到工作表边界；
- 超过 20,000 格抛 `E_PLUGIN_RANGE_TOO_LARGE`；
- 使用 `CellSnapshot.displayText` 作为导出文本：公式导出原文、数字按格式渲染、布尔为 `TRUE`/`FALSE`。

### 命令 `csvTools.fillDemo` 使用

| 接口 | 权限 | 同步性 | 作用与副作用 |
| --- | --- | --- | --- |
| `documents.active()` | 无 | 同步 | 取当前文档；无副作用 |
| `doc.canWrite` | 无 | 同步 | 实时判断当前用户是否可写；只读时提示并结束 |
| `doc.transact(label, fn)` | `document:write` + `canWrite` | 异步 | 把多次写入合成**一个撤销单元**；`fn` 抛错则不落任何改动；写入经 `engine.execute` 参与协同广播 |
| `tx.setRangeValues(range, values)` | 继承事务 | 同步登记 | 登记 A1:C3 的 3×3 矩阵；形状必须与范围严格一致 |

写入内容：

| 范围 | 内容 |
| --- | --- |
| A1:C3 | `名称 / 数量 / 金额`、`示例 A / 10 / 99.5`、`示例 B / 20 / 168` |

- 字符串走宿主值推断，数字按数字写入；
- 整个事务只产生一个撤销单元，Ctrl+Z 可整体撤销；
- 只读文档、无编辑角色或引擎只读时 `canWrite` 为 `false`，不会进入事务。

> 本插件不调用 `getSnapshot()`，也不做任何结构操作（增删/重命名工作表）。

---

## 二、与界面交互的接口

### manifest 入口

| 类型 | id / 插槽 | 作用 |
| --- | --- | --- |
| 命令 | `csvTools.exportSelection` | 标题「导出选区为 CSV」，分类「导出」 |
| 命令 | `csvTools.fillDemo` | 标题「写入示例数据」，分类「示例」 |
| 工具栏 | `sheet.toolbar.end`，`order: 10` | 按钮「导出 CSV」 |
| 工具栏 | `sheet.toolbar.end`，`order: 20` | 按钮「填充示例」；`requiresWrite: true`，只读文档下自动禁用 |

manifest 贡献在插件未激活时就会渲染按钮；用户点击时宿主负责「加载模块 → `activate` → 执行命令」，即懒激活。

### `ctx.commands.register(id, handler)`

| 项目 | 内容 |
| --- | --- |
| 用途 | 注册 `csvTools.exportSelection`、`csvTools.fillDemo` |
| id 约束 | `^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$`；命令表全局唯一 |
| 释放 | 返回值自动进入 `ctx.subscriptions`，停用时自动注销 |
| 错误 | id 非法或与其他插件重复时激活失败 |

### `ctx.ui.showMessage(level, message)`

| 项目 | 内容 |
| --- | --- |
| 权限 | 无（`notifications` 权限当前不校验） |
| 作用 | 调用宿主 antd `message` 弹出全局提示 |
| 使用 | `warning`：无文档/无选区/无内容/只读；`success`：导出完成、写入完成 |

### 运行时辅助

| 接口 | 说明 |
| --- | --- |
| `ctx.subscriptions` | 收集注册返回值；插件停用、退出登录、页面卸载时统一 `dispose()` |
| `ctx.logger.info` | 导出完成后记录行数与分隔符，带 `[plugin:com.pgclouddoc.csv-tools]` 前缀 |
| `ctx.pluginId` / `pluginVersion` / `hostVersion` / `apiVersion` | 插件与宿主版本信息 |
| `ctx.hasPermission()` | 查询 manifest 是否声明了某权限 |

---

## 三、与服务交互的接口

### `ctx.settings.get(key)`

| 项目 | 内容 |
| --- | --- |
| 权限 | 无 |
| 同步性 | 同步 |
| 数据来源 | manifest `settings` 默认值 + 管理端覆盖，由 `GET /api/v1/plugins/index` 随索引下发（只含 `client` scope） |
| 使用 | `get<string>('delimiter') ?? ','` |
| 限制 | v1 只在插件激活时快照，不支持热更新；管理端修改后需刷新页面 |

### 平台/外部服务

| 服务 | 地址 / 方法 | 调用方 | 鉴权 | 用途 |
| --- | --- | --- | --- | --- |
| 插件索引 | `GET /api/v1/plugins/index` | 宿主前端 | 登录 JWT | 发现本插件、当前版本、`delimiter` 设置值 |
| 插件静态产物 | `GET /plugin-assets/com.pgclouddoc.csv-tools/1.0.0/dist/main.js` | 浏览器 `import()` | 无 | 加载插件 ESM 入口 |
| 开发服务器（仅 DEV） | `GET http://localhost:5174/plugin.dev.json`、`GET http://localhost:5174/src/index.ts` | 宿主前端 | 无，CORS `*` | 本地开发时提供 manifest 与转译后的入口 |

### 插件自身的外部调用

**没有。** CSV 通过浏览器本地 Blob + `<a download>` 下载，不与第三方服务通信，也不上传文档内容。导出流程：

```text
displayText → 引号转义 → 行间 \r\n → UTF-8 BOM → Blob → 本地下载
```

---

## 本地开发

```bash
pnpm build:plugin-api      # 首次或协议包变更后
pnpm dev:plugin            # dev server，端口 5174
```

登录后、打开文档前，在浏览器控制台设置开发插件地址：

```js
localStorage.setItem(
  'pgclouddoc.plugin-dev',
  JSON.stringify({ 'com.pgclouddoc.csv-tools': 'http://localhost:5174/' })
);
```

打开任意表格文档，工具栏右侧会出现「导出 CSV」「填充示例」两个按钮：

- 「导出 CSV」读取当前选区并下载；
- 「填充示例」向 A1:C3 写入示例数据，可 Ctrl+Z 整体撤销。

## 构建发布包

```bash
pnpm --filter @pgclouddoc/plugin-csv-tools build
```

产物：

```text
plugins/csv-tools/release/com.pgclouddoc.csv-tools-1.0.0.zip
plugins/csv-tools/release/com.pgclouddoc.csv-tools-1.0.0.json   # 哈希元数据
```

zip 是服务端上传接口的输入；浏览器不会下载 zip。
