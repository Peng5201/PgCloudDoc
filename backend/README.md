# PgCloudDoc 后端

云文档（电子表格）服务端。提供用户系统、文档 CRUD 与存档、以及基于 **CRDT 的实时协同**。

技术栈：NestJS 12 · PostgreSQL 16 · Prisma 7 · Redis 7 · Kafka · Yjs · WebSocket

---

## 快速开始

```bash
# 1. 起依赖（PG / Redis / Kafka 全在 Docker 里）
pnpm --filter backend infra:up

# 2. 初始化数据库（建表 + 存储过程 + 视图）
pnpm --filter backend db:generate
pnpm --filter backend db:deploy

# 3. 起服务（默认 http://localhost:3000）
pnpm --filter backend dev
```

配置从 `backend/.env` 读，模板见 [.env.example](.env.example)。第一次用先 `cp .env.example .env`。

**验证**

```bash
pnpm --filter backend test                  # 单元测试（纯逻辑，不需要任何服务）
pnpm --filter backend test:smoke:http       # REST 全链路（需要服务在跑）
pnpm --filter backend test:smoke:collab     # 协同全链路（需要服务在跑）
```

---

## 架构

```
HTTP (REST /api/v1)  ──┐
WS  (/collab/:docId) ──┼──> Guards / Filters / Interceptors ──> Controller ──> Service ──> Repository(DAO)
                       │                                              │              │
Kafka (producer/consumer) <── 事件总线 ───────────────────────────────┘              │
                                                                                     ▼
                                                                    Prisma(ORM) ── PostgreSQL
                                                                    ioredis    ── Redis
                                                                    Yjs Y.Doc  ── DocumentUpdate 日志
```

**分层约定**（每个模块都遵守）

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `*.controller.ts` | 路由 + DTO 绑定 + 调 Service | 不写业务 |
| `*.dto.ts` | 入参/出参契约，class-validator 校验 | 不含实体 |
| `*.service.ts` | 业务逻辑 + 事务边界 | 不写 Prisma 查询 |
| `*.repository.ts` | DAO，只封装 Prisma 查询 | 不写业务规则 |

```
src/
  config/          环境变量 zod 校验 + 分层配置 + AppConfigService
  shared/          横切：中间件 / 异常过滤器 / 拦截器 / Guard / 装饰器 / 统一错误码 / 请求上下文
  infrastructure/  外部系统适配（端口实现）
    prisma/        PrismaService（driver adapter + 显式连接池）
    redis/         缓存(含穿透/击穿/雪崩) + 限流 + 分布式锁 + Pub/Sub
    kafka/         生产者 / 消费者 / 事务性发件箱 / 事件契约 / 幂等
    yjs/           Y.Doc 结构、materialize/applySnapshot、update 日志持久化
    etcd/          配置中心客户端（前缀快照 / CAS / 历史重放 / watch）
  features/        业务能力（垂直切片）
    auth/          注册 登录 刷新 登出 + 双 token + OAuth2
    users/         资料
    documents/     CRUD + 快照 + 版本历史/回滚 + 成员权限/申请 + 导入导出
      formats/     工作簿文件格式注册表（xlsx 读写；加 csv 只需实现 WorkbookFormat）
    collab/        WebSocket 协同服务（y-protocols sync + awareness）
    jobs/          Kafka 消费者（归档/审计/死信）+ cron 清理
    notifications/ 站内信 + WS 推送
    config-center/ 配置中心（etcd 读写 + 公共配置快照 + 管理接口）
    health/        liveness / readiness / 依赖详情
test/              单元测试在 src/ 里随模块；冒烟脚本在 test/
```

---

## 接口

统一响应体：

```jsonc
// 成功
{ "success": true,  "data": ..., "requestId": "..." }
// 失败
{ "success": false, "code": "NOT_FOUND", "message": "文档不存在", "requestId": "..." }
```

客户端按 `code` 分支，不按 `message`（message 会被翻译/改写，code 是契约）。
完整错误码见 [src/shared/errors/app-error.ts](src/shared/errors/app-error.ts)。

### 认证 `POST /api/v1/auth`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/register` | 注册，返回 token 对 |
| POST | `/login` | 登录（identifier 支持邮箱或用户名） |
| POST | `/refresh` | 轮换 refresh token（cookie 优先） |
| POST | `/logout` | 吊销整族 token + 拉黑 access token |
| GET | `/me` | 当前用户 |
| POST | `/change-password` | 改密码（自动吊销所有会话） |
| POST | `/profile` | 更新当前用户资料 |
| GET | `/oauth/:provider` | 取第三方授权链接 |
| GET | `/oauth/:provider/callback` | OAuth2 回调 |

### 用户 `/api/v1/users`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/me` | 当前用户资料 |
| GET | `/:id` | 其他用户的公开资料（需登录，ETag + `max-age=60`） |
| POST | `/me` | 更新资料 |

### 文档 `/api/v1/documents`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 游标分页列表（`cursor` / `limit` / `keyword` / `status`） |
| POST | `/` | 新建 |
| POST | `/import` | **导入工作簿**（multipart `file`，≤20MB，格式由 `formats/` 注册表决定），导入即新建文档 |
| GET | `/:id/export.xlsx` | **导出工作簿**（二进制流，不走统一信封） |
| GET | `/:id` | 详情 |
| PATCH | `/:id` | 改名 / 描述 / 归档状态 |
| DELETE | `/:id` | 软删除 |
| POST | `/:id/duplicate` | 复制 |
| GET | `/:id/snapshot` | **工作簿快照**（前端 IWorkbookData），带 ETag |
| POST | `/:id/archive` | 手动归档一版 |
| GET | `/:id/versions` | 版本列表 |
| POST | `/:id/versions/:v/restore` | 回滚到某版本 |
| POST | `/:id/refresh-snapshot` | 异步触发归档（走 Kafka，返回 202） |
| GET | `/:id/members` | 协作者列表 |
| PATCH | `/:id/members/:userId` | 调整成员角色 |
| DELETE | `/:id/members/:userId` | 移除成员 |
| POST | `/:id/access-requests` | 申请访问权限 |
| GET | `/:id/access-requests` | 待审批申请 |
| POST | `/:id/access-requests/:requestId/approve` | 通过申请（指定角色） |
| POST | `/:id/access-requests/:requestId/reject` | 拒绝申请 |

### 通知 `/api/v1/notifications`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 通知列表 |
| GET | `/unread-count` | 未读数 |
| POST | `/read` | 标记指定通知已读（`ids`） |
| POST | `/read-all` | 全部标记已读 |

### 配置中心 `/api/v1/config` · `/api/v1/admin/config`

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/v1/config` | 公开 | 浏览器首屏配置（仅 client scope），`Cache-Control: no-store` |
| GET | `/api/v1/admin/config` | ADMIN | 全部配置（client + server） |
| PUT | `/api/v1/admin/config/:scope/:key` | ADMIN | 新建/更新；`expectedRevision` 做 CAS，冲突 409 |
| DELETE | `/api/v1/admin/config/:scope/:key` | ADMIN | 删除 |
| GET | `/api/v1/admin/config/:scope/:key/history` | ADMIN | 历史 revision（从 etcd watch 重放） |
| POST | `/api/v1/admin/config/:scope/:key/rollback` | ADMIN | 回滚到指定 revision（写成新版本） |

### AI 助手 `/api/v1/ai`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/ai/config` | 是否启用、模型列表、调用限制 |
| POST | `/api/v1/ai/conversations` | 建会话（可绑定文档） |
| GET | `/api/v1/ai/conversations?documentId=` | 会话列表 |
| GET | `/api/v1/ai/conversations/:id` | 会话 + 消息 |
| PATCH | `/api/v1/ai/conversations/:id` | 改标题 |
| DELETE | `/api/v1/ai/conversations/:id` | 软删除 |
| POST | `/api/v1/ai/conversations/:id/turns` | SSE 推进一轮 |

`turns` 的 SSE 事件：`turn_start` / `text_delta` / `tool_call` / `usage` / `turn_end` / `error`。
工具在浏览器插件里执行；服务端只做模型调用、会话持久化、配额与审计。

供应商配置见 `AI_*` 环境变量。`AI_PROVIDER=mock` 可以在不接外部模型的情况下跑通全链路；
接真实模型前用 `pnpm ai:probe` 验证流式 + 原生工具调用。

### 其它

- `GET /health` · `GET /health/ready` · `GET /health/deps`
- `WS  ws://host/collab/:documentId?access_token=...` —— 协同入口，协议与 [y-websocket](https://github.com/yjs/y-websocket) 完全兼容，前端可直接用 `WebsocketProvider`
- `WS  ws://host/notifications?access_token=...` —— 用户级通知推送（纯 JSON 文本帧，客户端只收；已读走 REST）

---

## 工作簿导入导出

格式层是一个**可扩展注册表**，不在 controller 里写死 xlsx：

| 位置 | 职责 |
|---|---|
| [formats/types.ts](src/features/documents/formats/types.ts) | `WorkbookFormat` 契约：`extensions` / `contentType` / `read()` / `write()` |
| [formats/index.ts](src/features/documents/formats/index.ts) | 注册表 + 按扩展名分发（`readWorkbook` / `writeWorkbook`） |
| [formats/xlsx/](src/features/documents/formats/xlsx/) | xlsx 实现（ExcelJS） |

加一种格式（如 csv / ods）只需新建 `formats/<id>/`、实现 `WorkbookFormat`、在 `FORMATS` 里登记一行；
导入/导出调用方不用改。

**流程**

- **导入**：`POST /api/v1/documents/import` → 按文件名分发 → `readXlsx` → `applySnapshot` 写入 Y.Doc → 归档 → 返回新文档详情
- **导出**：`GET /api/v1/documents/:id/export.xlsx` → `materialize` 读服务端 Y.Doc → `writeXlsx` → 二进制流

以服务端 Y.Doc 为导出真源，客户端手里的数据可能落后于别人的实时编辑。

**体量与降级**

- 上传 20MB（`MAX_XLSX_BYTES`）；单元格 200 万（`MAX_IMPORT_CELLS`），超限 413
- 解析在请求线程同步执行；更大体量应改为异步队列 + 任务状态查询
- 富文本压平、超链接只留文本等降级会写进 `warnings` 并记录日志（当前不返回给客户端）
- 逐类型边界见 [formats/xlsx/DATA-TYPES.md](src/features/documents/formats/xlsx/DATA-TYPES.md)，实现取舍见 [formats/xlsx/README.md](src/features/documents/formats/xlsx/README.md)

---

## 关键设计

### 双 token 与令牌轮换

- **access**（15min）：`Authorization: Bearer`，无状态 JWT，签名即验
- **refresh**（30d）：httpOnly + SameSite cookie，**只存 sha256 哈希**，path 收窄到 `/api/v1/auth`

每次刷新都作废旧令牌、签发新令牌，`replacedById` 串成一条链。
**重放检测**：已撤销的令牌又被拿来刷新，正常流程下不可能发生 —— 唯一解释是令牌泄漏了，
此时吊销整个 `familyId`（这次登录产生的所有令牌），强制重新登录。

代价是用户要多登录一次，但攻击者也被关在门外。只作废当前令牌是不够的：攻击者手里那张新的还活着。

### CRDT 数据结构：扁平 key

协同真源是 Y.Doc，快照只是它某一时刻的投影（`materialize()`）。

单元格字段**编进 Y.Map 的 key**（`"row:col:field"`），而不是 `row:col` → 嵌套 `Y.Map{v,t,f,s}`：

> 嵌套 Y.Map 在「格子已存在」时确实能按字段合并，但**两个客户端同时新建同一个格子**时，
> 各自创建的内层 Y.Map 会在外层 key 上冲突，Yjs 取 LWW —— 输掉那方的整个内层 map 连同
> 里面所有字段一起消失。表现为「A 改内容、B 改样式，最后样式没了」。
>
> 字段名编进 key 之后，`0:0:v` 和 `0:0:s` 是两个不同的 map 条目，不存在冲突。
> 同一字段的并发编辑才走 LWW —— 这正是想要的粒度。

这条被 [ydoc.spec.ts](src/infrastructure/yjs/ydoc.spec.ts) 的「并发合并语义」用例钉住了，改坏会立刻红。

### 持久化：update 追加日志 + compaction

一次编辑可能只改 3 个格子，存整份快照是几 MB，追加一条 update 只有几十字节 —— 写放大差两个数量级。
`document_updates` 表 append-only 收 Yjs update，`seq` 由 `pg_advisory_xact_lock` 串行分配。

超过阈值（默认 200 条）就把 N 条合并成一条 base update，删掉被吸收的行 —— 相当于给日志做 checkpoint。

**持久化挂在 Y.Doc 上，不是挂在 WebSocket 连接上**：没有连接时（服务端执行回滚、cron 归档）数据一样要落库。

### HTTP 缓存

| 接口 | 策略 |
|---|---|
| 文档快照 | `private, max-age=0, must-revalidate` + ETag（内容哈希）→ 命中 304，一个字节不传 |
| 文档详情 | `private + must-revalidate`，自动 ETag |
| 用户资料 | 公开资料页 `GET /users/:id`：`public, max-age=60` + 自动 ETag |
| 文档列表 | 不缓存 |

几 MB 的快照是最值钱的一处优化：重复打开同一个文档不再传 body。

### 行级安全

每个接口第一步都是 `assertAccess`，**越权返回 404 而不是 403** ——
403 等于告诉攻击者「这个 id 存在，只是不是你的」，凭 id 可以枚举出别人有哪些文档。

⚠️ 鉴权必须在缓存**之前**。缓存命中时 loader 根本不会执行，
把鉴权写进 loader 等于「命中缓存就跳过鉴权」。这条被冒烟脚本的热缓存场景覆盖。

### AI 网关：模型在服务端，工具在浏览器

- 服务端不执行文档写入，也不持有引擎；它只把用户输入、历史与文档上下文发给模型，
  流式返回文本 / `tool_use`，并负责会话持久化、配额与审计。
- 工具由浏览器插件执行，写入走 `engine.execute`，撤销、协同、只读约束全部由宿主保证。
- 会话按用户隔离；绑定文档时每轮校验访问权。密钥只存在服务端环境变量，插件包里没有。
- `sanitizeHistory` 会剔除没有配对结果的 `tool_use`，避免客户端中途关闭导致整轮 400；
  `trimHistory` 按字符预算丢弃最旧消息，防止长对话撑爆模型上下文。

### 消息队列

| topic | 用途 | 生产方式 |
|---|---|---|
| `doc.snapshot.requested` | 触发异步归档（写路径不被「物化 + gzip + 写库」拖慢） | 发件箱 |
| `doc.snapshot.completed` | 归档完成通知 | 与版本写入**同事务** |
| `doc.update.persisted` | 变更审计（契约预留） | — |
| `audit.user.activity` | 用户行为审计 | 发件箱 |
| `pgclouddoc.dead-letter` | 重试耗尽的事件 | 发件箱 |

**生产端：事务性发件箱（Outbox）**

- 业务代码不直接发 Kafka，先写 `outbox_events`；需要时传入业务事务，做到「业务提交了，事件一定留下」
- `OutboxDispatcher` 每秒认领 PENDING 记录投递；`FOR UPDATE SKIP LOCKED` 保证多实例不重复领取
- 失败指数退避，超过 10 次标记 `FAILED`（人工介入）；Kafka 不可用时事件留在表里，恢复后自动补发
- 启动时 Kafka 没起来也没关系：生产者与消费者都会周期性 `ensureConnected`，恢复后自动接上
- Kafka 生产者幂等（`idempotent: true`）+ `acks=-1`

**消费端**

- `processed_events` 表保证幂等：**先只读检查，处理成功后再写标记**。
  先标记再处理的话，处理到一半进程崩溃，重投时会被误判为已处理而**永久丢消息**
- 审计落库额外用事件 id 唯一索引兜底：同一条消息重复投递只落一条
- `eachBatchAutoResolve: false` 手动提交；指数退避重试 + 死信 topic，一条坏消息不卡死 consumer group
- **死信有消费者**：落到 `audit_logs`（`action = kafka.dead_letter`），不会成为没人看的黑洞；死信自身失败时不再套娃
- 事件信封带 `schemaVersion` 与 `correlationId`；消费时把 `correlationId` 灌进请求上下文，日志能和 HTTP 请求串起来
- 发件箱与幂等表由 cron 定期清理（已投递 7 天 / 失败 30 天 / 幂等记录 7 天）

### 配置中心（etcd）

- **键位**：`<ETCD_CONFIG_PREFIX>/client/<key>` 下发给浏览器，`/server/<key>` 仅服务端可见。公开接口只扫 `client/`，从存储结构上杜绝误暴露。
- **值**：JSON 文本；管理后台写入时带信封（`__meta/value/description/updatedBy/updatedAt`），也兼容 etcdctl 直接写的裸 JSON。
- **首屏**：`ConfigCenterService` 启动后维护内存快照，`GET /api/v1/config` 直接返回快照（不走 etcd 往返），并 watch 前缀 + 60s 兜底轮询保持最新；etcd 挂掉时回退上一份快照，失败 5s 内不再重试，避免首屏排队等超时。
- **并发**：写配置带 etcd modRevision 做 CAS；两个管理员同时编辑时后提交方得到 409，不静默覆盖。
- **历史/回滚**：etcd 没有「列某键所有版本」的接口，从 `createRevision` 起重放 watch、到当前 revision 立即取消；回滚取历史 revision 的值后写成新版本，回滚本身也可追溯。
- **可用性**：`ETCD_ENDPOINTS` 留空即关闭；etcd 不参与 `/health/ready` 的致命判定（degraded），应用启动不依赖它。

### 缓存层（Redis）

| 场景 | 结构 | 策略 |
|---|---|---|
| 文档元信息 | String(JSON) | Cache-Aside，写后 `DEL` |
| 用户资料 | String(JSON) | `getOrSet`：空值缓存 + 互斥锁 + TTL 抖动 |
| access token 黑名单 | String | TTL = token 剩余寿命 |
| OAuth state | String | 5 分钟 TTL |
| 令牌族吊销 | Set | 重放检测时整族拉黑 |
| 分布式锁 | String(SET NX PX) + Lua | 归档 / compaction 互斥 |
| 限流计数 | ZSet | **滑动窗口**（不是固定窗口 —— 固定窗口在边界会放行 2 倍流量） |
| 变更流水 | Stream | 调试回放 |

三类缓存问题都处理：穿透（空值缓存）、击穿（互斥锁 + 短轮询）、雪崩（TTL ±20% 抖动）。
**Redis 挂了系统要能继续跑** —— 所有命令 `safe()` 包装，失败降级直读 PG。

---

## 测试

**单元测试**（`pnpm test`，32 用例，不需要任何外部服务）
覆盖 Yjs 结构的往返一致性与并发合并语义（13）、双 token 的签发/校验/哈希（11）、
xlsx 往返/样式去重/共享公式/单元格上限（8）。

**冒烟脚本**（`pnpm test:smoke`，打真实服务）
- `test/http.smoke.mjs` —— 43 项：健康检查、注册登录、CRUD、ETag/304、版本回滚、越权 404、令牌轮换与重放检测、软删除
- `test/collab.smoke.mjs` —— 双客户端双向同步 + 并发同格不同字段 + 落库一致性

### 为什么没有 supertest 的 e2e

Nest 12 发布的是**纯 ESM 包**（`package.json` 里 `type: module`，无 CJS 入口）。
jest 30 在 Node 22 上的 `require()` 实现不支持 `require(esm)`，
`Test.createTestingModule` 装不进来（transform 帮不上忙 —— jest 是按 package.json 的
`type` 决定加载方式的）。Node 24.9+ 才原生支持。

所以单元测试只测**无框架依赖的纯逻辑**（`TokenIssuer` 因此从 `TokenService` 里抽了出来），
端到端走打真实 HTTP 的冒烟脚本 —— 反而更接近生产路径，中间件/Guard/过滤器/缓存头全都真跑。

---

## 明确不做（以及为什么）

| 项目 | 状态 | 理由 |
|---|---|---|
| 微服务拆分 | 不做 | 单体规模下拆微服务是负收益（网络开销、分布式事务、部署复杂度）。模块边界 + Kafka 事件契约已经把「可拆性」留好 |
| ClickHouse / TiDB | 不做 | 没有对应的分析型/HTAP 负载。`DocumentVersionStore`、`DocumentRepository` 已是接口化的，将来要换只改实现 |
| 分库分表 | 不做 | 单表还没到需要分的量级。索引已按查询路径设计，游标分页不用 OFFSET |
| OAuth2 多 provider | 预留 | `OAuthProvider` 接口 + Google 实现已就位，再接一个 provider 只写一个类 |
| 协同冲突的字段级版本 | 不做 | CRDT 已经保证并发字段不丢失，再加版本是过度设计 |

---

## 目录导航

- 数据模型：[prisma/schema.prisma](prisma/schema.prisma)
- 存储过程与视图：[prisma/migrations/20261027083138_init/migration.sql](prisma/migrations/20261027083138_init/migration.sql)
- 统一错误码：[src/shared/errors/app-error.ts](src/shared/errors/app-error.ts)
- CRDT 结构设计：[src/infrastructure/yjs/ydoc.ts](src/infrastructure/yjs/ydoc.ts)
- 令牌轮换与重放检测：[src/features/auth/auth.service.ts](src/features/auth/auth.service.ts)
- 事务性发件箱：[src/infrastructure/kafka/outbox.service.ts](src/infrastructure/kafka/outbox.service.ts)
- 文件格式契约：[src/features/documents/formats/types.ts](src/features/documents/formats/types.ts)
- xlsx 实现说明：[src/features/documents/formats/xlsx/README.md](src/features/documents/formats/xlsx/README.md)
- xlsx 类型边界：[src/features/documents/formats/xlsx/DATA-TYPES.md](src/features/documents/formats/xlsx/DATA-TYPES.md)
