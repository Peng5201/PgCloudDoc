# xlsx 读写（服务端）

Excel 文件 ↔ 协同快照（`SnapshotWorkbook`）的映射。

| 动作 | 接口 | 流程 |
| --- | --- | --- |
| 导入 | `POST /api/v1/documents/import`（multipart `file`） | 按扩展名分发 → `readXlsx` → `applySnapshot` 写入 Y.Doc → 归档 → 返回新文档 |
| 导出 | `GET /api/v1/documents/:id/export.xlsx` | `materialize` 读服务端 Y.Doc → `writeXlsx` → 二进制流 |

> 逐类型的能力边界（含显示层与降级行为）见 **[DATA-TYPES.md](DATA-TYPES.md)**。

## 为什么在服务端

1. 协同真源是服务端 Y.Doc，导出必须基于它；前端手里的数据可能落后于别人的编辑
2. ExcelJS 不打进浏览器包（省掉一个 ~1MB 的懒加载 chunk）
3. 导入是「数据摄取」流程，天然属于服务端：解析 → 写 Y.Doc → 落库

## 格式注册表

xlsx 不是写死在 controller 里的，`formats/` 用统一契约分发：

| 文件 | 职责 |
| --- | --- |
| [`../types.ts`](../types.ts) | `WorkbookFormat` 契约：`id` / `extensions` / `contentType` / `read()` / `write()` |
| [`../index.ts`](../index.ts) | 注册表 + `readWorkbook` / `writeWorkbook` / `findFormat` |
| [`index.ts`](index.ts) | 把 xlsx 实现包成 `WorkbookFormat`（`.xlsx / .xlsm`） |

加 csv / ods 时：新建 `formats/<id>/` → 实现 `WorkbookFormat` → 在 `FORMATS` 里登记，调用方不用改。
导出接口目前固定产出 xlsx（`defaultFormat`）。

## 覆盖范围（P0 + P1 + 低成本 P2）

| 能力 | 读 | 写 |
| --- | :---: | :---: |
| 文本 / 数字 / 布尔 | ✅ | ✅ |
| 公式 + 缓存值 | ✅ | ✅ |
| 日期（序列号 + `n.pattern`） | ✅ | ✅ |
| 数字格式（千分位/百分比/小数位） | ✅ | ✅ |
| 合并单元格 | ✅ | ✅（引擎只存不渲染） |
| 行高 / 列宽 | ✅ | ✅ |
| 字体 / 填充 / 对齐 / 换行 / 边框 | ✅ | ✅ |
| 行列隐藏、默认宽高、网格线 | ✅ | ✅ |
| sheet 名 / 顺序 / 隐藏 / tabColor | ✅ | ✅ |
| 冻结窗格 | ✅ | ✅（只存不渲染） |

## 已知限制

| 项 | 现状 |
| --- | --- |
| 富文本 | 压平成纯文本（快照 `p` 占位，未使用） |
| 超链接 | 只保留显示文本 |
| 主题色 / 渐变填充 | 不解析（宁可默认色也不写错色） |
| 条件格式 / 数据验证 / 批注 / 图片 / 图表 / 命名区域 | 不解析（可后续塞进 `resources`） |
| 共享公式 | 读取时按格翻译成各自的公式；导出拆成独立公式，不保留共享组 |
| 合并区从属格 | 不写入值（ExcelJS 会把主格值复制到每一格），只保留左上角 + `mergeData` |
| 仅样式无值的单元格 | 不导入（`eachCell({ includeEmpty: false })` 会跳过） |
| 缩放 | 不保留（导入恒为 1，导出不写） |
| `.xls`（BIFF） | **不支持**，只承诺 `.xlsx / .xlsm`；`.xlsm` 的宏导出时丢弃 |

## 体量与防护

- 上传大小：`FileInterceptor` 限制 20MB（`documents.controller.ts` 的 `MAX_XLSX_BYTES`）
- 单元格总数：`MAX_IMPORT_CELLS = 2_000_000`（`document.service.ts`），超限返回 413
- 解析在当前请求线程里做；若将来出现更大的文件，应改为异步队列 + 任务状态查询
- 解析器对畸形文件只抛通用错误，不把 ExcelJS 的内部异常透给客户端

## 降级提示（warnings）

`readXlsx` 返回 `{ workbook, warnings, cellCount }`。当前 `warnings` 只写日志，不返回给客户端：

- 富文本已压平为纯文本
- 超链接已降级为纯文本
- 未识别的单元格值类型，已跳过：`<字段名>`
- 全部工作表都是隐藏状态，已显示第一张

## 设计要点

- **日期存序列号 + 格式串**：导出时仍是数字，不会退化成字符串；显示由前端 `cellText` 按 `n.pattern` 渲染
- **样式去重**：`StyleRegistry` 按内容指纹（键排序后的规范 JSON）合并进共享样式表
- **稀疏遍历**：导出只遍历实际单元格，不按 `rowCount × columnCount` 铺满
- **共享公式取翻译后的公式**：用 `cell.formula` getter，而不是 `cell.value.sharedFormula`（后者是主格地址，会存成 `=A1`）
- **日期格式兜底**：单元格值是 `Date` 但没有可用格式时，补 `yyyy-mm-dd`（有时间则带 `hh:mm:ss`）

## 测试

[xlsx.spec.ts](xlsx.spec.ts) 覆盖 8 个用例：

- 值 / 公式 / 合并 / 宽高 / 样式往返
- 共享样式表按内容去重
- 空表读写
- 超过单元格上限抛 `CellLimitExceededError`
- 共享公式翻译成每格独立公式
- 日期 / 时间 / 数字 / 千分位 / 百分比格式渲染
