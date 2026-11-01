# 插件库

插件源码目录。整体设计方案见 [plugin-system-design.md](plugin-system-design.md)。

插件作者请先读 **[PLUGIN-API.md](PLUGIN-API.md)**：接口按**与文档交互、与界面交互、与服务交互**三类组织，逐个说明作用、副作用、权限、限制；另有 manifest 完整字段和插件依赖的全部外部服务（索引接口、静态产物、管理端接口、etcd、开发服务器等）。

## 目录

```text
plugins/
  package.json              # 工作区根：共享构建依赖
  vite.plugin.config.ts     # 插件 Vite 配置（dev server + 构建共用）
  tsconfig.base.json
  scripts/build-plugin.mjs  # 构建 + 打 zip + 生成哈希
  csv-tools/                # 示例插件：导出 CSV / 写入示例数据
    plugin.json
    src/index.ts
    vite.config.ts
  execl-agent/              # 示例插件：把表格内容输出到控制台
    plugin.json
    src/index.ts
    vite.config.ts
```

每个示例插件的接口说明（命令、权限、调用的文档接口与副作用、外部服务）：

- [csv-tools/README.md](csv-tools/README.md)
- [execl-agent/README.md](execl-agent/README.md)

## 本地开发

1. 安装依赖并构建协议包：

   ```bash
   pnpm install
   pnpm build:plugin-api
   ```

2. 启动插件的 Vite dev server：

   ```bash
   pnpm dev:plugin
   ```

   它会把 `plugin.json` 以 `/plugin.dev.json` 暴露出来，入口改写为 `src/index.ts`。

3. 在宿主的浏览器里配置开发插件（登录后、打开文档前执行）：

   ```js
   localStorage.setItem(
     'pgclouddoc.plugin-dev',
     JSON.stringify({ 'com.pgclouddoc.csv-tools': 'http://localhost:5174/' })
   );
   ```

   也可以给前端设置环境变量 `VITE_PLUGIN_DEV`，值为同一个 JSON 字符串。
   只有 `import.meta.env.DEV` 下才会读取这份配置，生产构建不会加载任意远程插件。

4. 打开任意文档，工具栏右侧应出现「导出 CSV」「填充示例」两个按钮。
   - 「导出 CSV」读取当前选区；
   - 「填充示例」向 A1:C3 写入示例数据，可 Ctrl+Z 整体撤销。

### 另一个示例：输出表格到控制台

```bash
pnpm dev:plugin:excel      # dev server，端口 5175
```

浏览器控制台设置（可与上面的 csv-tools 同时存在）：

```js
localStorage.setItem(
  'pgclouddoc.plugin-dev',
  JSON.stringify({
    'com.pgclouddoc.csv-tools': 'http://localhost:5174/',
    'com.pgclouddoc.excel-agent': 'http://localhost:5175/',
  })
);
```

打开文档后点击「输出表格」，控制台会打印整份工作簿快照。详见
[execl-agent/README.md](execl-agent/README.md)。

## 构建发布包

```bash
pnpm build:plugin
```

产物：

```text
plugins/csv-tools/dist/                         # ESM
plugins/csv-tools/release/<id>-<version>.zip   # plugin.json + dist
plugins/csv-tools/release/<id>-<version>.json  # zip / 每个文件的 SHA-256
```

`pnpm build:plugin` 会构建所有插件；只想构建某一个时：

```bash
pnpm build:plugin:excel                         # 仅 excel-agent
pnpm --filter @pgclouddoc/plugin-csv-tools build # 仅 csv-tools
```

zip 就是服务端上传接口的输入；浏览器不会下载 zip，服务端解包后以静态资源提供。

## 管理端上传

1. 构建插件 zip（`pnpm build:plugin` 或 `pnpm build:plugin:excel`）；
2. 用管理员账号打开 **管理后台 → 插件管理**；
3. 点「上传插件」选择 zip。服务端会校验 `plugin.json`、文件类型、路径与解压体积，
   通过后立即成为当前版本并启用；
4. 列表里可以禁用/启用、查看版本历史、切换当前版本；
5. 客户端登录后拉取 `GET /api/v1/plugins/index`，按索引加载已启用的插件。

说明：

- 同一个 `pluginKey + version` 发布后不可覆盖，修改后请升版本；
- 产物存放在后端 `PLUGIN_STORAGE_DIR`（开发默认 `backend/var/plugins`，生产挂 `/data/plugins` 卷）；
- 开发模式下 `localStorage['pgclouddoc.plugin-dev']` 里的同 id 插件会覆盖服务端版本，方便热更新。

## 插件开发约定

- 只依赖 `@pgclouddoc/plugin-api` 的类型，不 import 宿主内部模块（`spreadsheet/engine`、`collab/*`）；
- 所有注册/监听放进 `context.subscriptions`（`commands.register` / `ui.register*` 会自动放）；
- 文档读写一律走 `context.documents`，不要碰 `window.__sheetEngine` 或 Y.Doc；
- 不在模块顶层持有文档/用户数据（插件停用时模块本身不会被卸载）；
- React / antd 在构建时 external，由宿主提供同一实例（P1 接入 import map）。
