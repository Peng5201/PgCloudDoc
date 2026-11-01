# AI 助手（ai-agent）

在编辑器右侧面板里用自然语言读写当前表格：查看结构、读取/搜索/统计、解释公式、填充空值、清洗数据、设置样式、排序、去重、查找替换。

它是 **Agent 能力的"手脚"**：模型在服务端，工具在浏览器里执行。所有写入都通过宿主文档 API 走 `engine.execute`，因此天然可撤销、可协同、受只读约束。

宿主通用契约见 [../PLUGIN-API.md](../PLUGIN-API.md)。

## 插件身份

| 项目 | 值 |
| --- | --- |
| id | `com.pgclouddoc.ai-agent` |
| version | `0.2.1` |
| entry | `dist/main.js` |
| 激活事件 | `onView:aiAgent.panel`、`onCommand:aiAgent.open` |
| 权限 | `document:read`、`document:write`、`storage` |
| 面板 | `editor.sidebar` → `aiAgent.panel` |
| 工具栏 | `sheet.toolbar.end` → 「AI 助手」 |

## 它做什么

```text
用户输入
  → 插件读取文档结构 + 选区 → 发到 /api/v1/ai/conversations/:id/turns（SSE）
  → 服务端调模型，流式返回文本 / tool_use
  → 插件执行工具（读工具直接执行；写工具先生成 diff，用户确认后应用）
  → 工具结果回传 → 模型继续，直到结束
```

Agent 循环在插件里，因为工具必须操作**实时文档**；模型调用在服务端，因为密钥不能进公开的插件包。

## 支持的表格操作

### 读取与理解

| 能力 | 说明 | 对应工具 |
| --- | --- | --- |
| 查看工作簿结构 | 所有工作表名称、行列数、有效数据区域、当前活动表 | `get_document_outline` |
| 读取当前选区 | 活动单元格、所有选区地址、第一块选区预览 | `get_selection` |
| 读取任意区域 | 指定工作表/区域，支持 `maxRows` 分页；**不切换用户视图** | `read_range` |
| 跨表读取 | 读非活动工作表，不改变当前表与选区 | `read_range` + `getRangeValuesInSheet` |
| 搜索单元格 | 在区域或有效数据区域查找文本，支持区分大小写、整格匹配 | `search_cells` |
| 统计 | 非空/数值/文本/布尔/公式数量；求和、平均、最小、最大；按列统计 | `compute_stats` |
| 解释公式 | 读取公式原文并解释；引擎不计算公式 | `read_range` / `compute_stats` |

### 数据编辑

写操作默认需要用户确认，一次应用 = 一次撤销（`Ctrl+Z` 可整体回退），并实时同步给协作者。

| 能力 | 说明 | 对应工具 |
| --- | --- | --- |
| 批量写入 | 写入二维值矩阵；字符串以 `=` 开头存为公式；`null` 删除单元格 | `write_range` |
| 填充空值 / 补列 | 模型先读取、计算，再把结果写回指定区域 | `write_range` |
| 清空区域 | 删除区域内的值、公式和样式 | `clear_range` |
| 查找替换 | 替换文本或公式原文；支持大小写、全部/首个；**只写命中的单元格** | `find_replace` |
| 排序 | 单列或多列、升序/降序；默认第一行是表头，不参与排序 | `sort_range` |
| 去重 | 按指定列判重，保留首次出现的行，清空重复行 | `remove_duplicates` |

### 格式设置

| 能力 | 取值 |
| --- | --- |
| 加粗 / 斜体 / 下划线 / 删除线 | 开 / 关 |
| 字体颜色 / 背景色 | `#RRGGBB` |
| 字号 | pt |
| 水平对齐 | left / center / right |
| 垂直对齐 | top / middle / bottom |
| 自动换行 | 开 / 关 |

对应工具：`format_range`。

### 典型请求示例

- 「总结当前选区，指出异常值」
- 「把 C 列的空值填成 0」
- 「按金额降序排序，第一行是表头」
- 「把 A 列重复的行删掉，保留第一次出现的」
- 「把表头加粗，背景色改成浅灰」
- 「统计 B 列的合计、平均、最大」
- 「把这一列里的『北京』替换成『北京市』」
- 「读一下 Sheet2 的 A1:C20」
- 「解释 D2 的公式」
- 「检查当前选区里的空值、重复和格式不一致」

### 目前不支持

- 增删行/列、合并单元格、调整行高列宽、冻结窗格
- 插入图表、图片、批注、超链接
- 筛选、透视表、条件格式、数据验证
- 数字格式（日期/百分比/千分位）—— 样式白名单不含 `n`
- 读取或复制已有样式（只能设置样式，不能读取）
- 计算公式／重算（引擎只存公式原文）
- 跨工作簿操作（只作用于当前打开的文档）

## 工具清单

| 工具 | 类型 | 说明 | 撤销 |
| --- | --- | --- | --- |
| `get_document_outline` | 读 | 工作表、行列数、有效区域 | — |
| `get_selection` | 读 | 当前选区与预览 | — |
| `read_range` | 读 | 读取区域，支持 `maxRows` 分页 | — |
| `search_cells` | 读 | 区域查找 | — |
| `compute_stats` | 读 | 数量/求和/平均/最值 | — |
| `write_range` | 写 | 写入二维值矩阵 | 一次事务 = 一次撤销 |
| `clear_range` | 写 | 清空区域 | 同上 |
| `format_range` | 写 | 加粗、颜色、对齐、换行等 | 同上 |
| `sort_range` | 写 | 多列排序（表头不参与） | 同上 |
| `remove_duplicates` | 写 | 按列去重 | 同上 |
| `find_replace` | 写 | 查找替换（只写命中单元格） | 同上 |

写工具的规则：

1. 先读取目标区域作为基线，生成变更摘要和 diff；
2. 面板展示「应用 / 取消」，默认必须确认（可在插件设置里打开 `autoApply`）；
3. 应用前重新读取并比对基线，确认期间被改过则返回 `CONFLICT`，让模型重新读取；
4. 应用走 `doc.transactInSheet(...)`，一次事务 = 一个撤销单元；
5. 只读文档下写工具不会发给模型，执行层也会再拦一次。

## 用到的宿主接口

### 文档

| 接口 | 用途 |
| --- | --- |
| `documents.active()` | 取当前文档 |
| `documents.onDidOpen/onDidClose` | 切换文档时重建会话 / 中止在途请求 |
| `doc.getSheetInfo()` | 工作表尺寸、有效区域（**不切换视图**） |
| `doc.getSelection()` | 选区与活动单元格 |
| `doc.getRangeValuesInSheet()` | 读取任意工作表（**不切换用户视图**） |
| `doc.transactInSheet()` | 在指定工作表上写入，一次撤销 |
| `doc.transact()` / `tx.setRangeValues/clearRange/setRangeStyle` | 当前表写入 |
| `doc.onDidChangeSelection()` | 更新面板顶部的选区提示 |

### 界面

- manifest 面板 + 工具栏按钮；
- `ctx.ui.registerPanel({ mount })` 挂载 Preact 树；
- `ctx.ui.showPanel()` 由命令打开面板；
- 命令：打开面板、总结选区、解释公式、清洗选区。

### 服务

- `ctx.net.fetch()`：同源 HTTP + SSE，复用宿主登录态与 401 单飞刷新；
- `ctx.settings.get()`：`autoApply`、`contextCellLimit`；
- `ctx.storage`：记住用户选择的模型（单键，远小于 1 MB）。

## 外部服务与数据流

| 服务 | 地址 | 用途 | 发送的数据 | 凭据 |
| --- | --- | --- | --- | --- |
| PgCloudDoc AI 网关 | `/api/v1/ai/*`（同源） | 会话与模型调用 | 用户输入、文档结构、选区预览、工具结果 | 登录会话（由宿主注入） |
| 模型供应商 | 由服务端 `AI_BASE_URL` 决定（当前 DeepSeek Anthropic 兼容端点） | 生成回复与工具调用 | 服务端转发上述上下文 | **只存在服务端**，插件拿不到 |

插件**不直接访问任何第三方域名**。密钥、配额、审计、供应商切换全部在服务端。

> 注意：文档内容会发送到模型供应商。是否启用、使用哪个供应商、每日额度、保留期都由服务端环境变量控制（后续可接配置中心开关）。

## 关键设计

### 上下文不整簿 dump

每轮只带：文档标题、工作表结构、当前选区、第一块选区的预览（受 `contextCellLimit` 与 12k 字符预算裁剪）。需要更多数据时由模型调用 `read_range` 分页读取。

这避免了两个问题：大文档每轮序列化整簿；把几十万 token 一次性塞给模型。

### 公式不会自动计算

引擎只保存公式原文，不计算公式。因此：

- `compute_stats` 只统计已存储的数值，公式单独计数；
- 模型需要结果时应自己算好写数值；
- 用户明确要公式时，写入公式并说明它不会自动计算。

### 排序 / 去重的样式边界

`sort_range` 和 `remove_duplicates` 会重写数据行，表头不参与。由于插件 API 没有样式读取接口，被重写的数据行里「只有样式、没有值」的单元格可能丢失样式。`find_replace` 只写命中的单元格，不受影响。

### 历史会话

会话和消息保存在服务端（`ai_conversations` / `ai_messages`），面板顶部「历史」列出**当前文档**的会话：

- 点击任意一条恢复它的完整消息与工具卡片；
- 每个文档会在 `ctx.storage` 里记住上次选中的会话，刷新/重开后自动回到那一条；
- 首条用户消息会由服务端自动生成标题，列表按最近更新时间排序；
- 「新对话」创建新会话，旧会话仍保留在历史里。

会话按当前文档隔离：一个关于文档 A 的对话不会在文档 B 的上下文里被误用。

### 面板生命周期

侧面板关闭会卸载 Preact 树，但 `AgentController` 仍在插件作用域内：关闭时中止在途请求和待确认写入，重新打开时从服务端恢复最近会话。切换文档会重置会话并重新绑定。

## 本地开发

```bash
pnpm build:plugin-api
pnpm build:ai-protocol
pnpm dev:plugin:ai          # dev server，端口 5175
```

宿主（前端）需要配置开发插件地址：

```js
localStorage.setItem(
  'pgclouddoc.plugin-dev',
  JSON.stringify({ 'com.pgclouddoc.ai-agent': 'http://localhost:5175/' })
);
```

后端至少需要以下变量（`backend/.env`）：

```dotenv
AI_ENABLED=true
AI_PROVIDER=mock                 # 本地联调先用 mock，不调外部服务
# 接真实模型时：
# AI_PROVIDER=anthropic
# AI_BASE_URL=https://api.deepseek.com/anthropic
# AI_API_KEY=<key>
# AI_MODEL=deepseek-v4-flash
```

接真实模型前，先用探针确认「流式 + 原生工具调用」正常：

```bash
cd backend && pnpm ai:probe
```

打开文档 → 点击工具栏「AI 助手」或右侧活动栏图标 → 面板出现。

## 构建发布

```bash
pnpm build:plugin:ai
```

产物：

```text
plugins/ai-agent/release/com.pgclouddoc.ai-agent-0.2.1.zip
plugins/ai-agent/release/com.pgclouddoc.ai-agent-0.2.1.json
```

zip 由管理后台「插件管理 → 上传插件」上传；版本号不可复用。

## 已知限制

- 不能增删行/列、合并单元格、插入图表：这些结构操作尚未进入引擎的撤销/协同事务，插件 API 不开放。
- 单次读写上限 20,000 格；更大的区域需要模型分批，或用户缩小选区。
- 公式不计算、排序不重写相对引用（公式作为文本移动）。
- 插件 UI 使用内置 Preact，不依赖宿主 React；宿主暂未提供 React import map。
