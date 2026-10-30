# PgCloudDoc

协同电子表格（云文档）。支持多人实时编辑、版本存档与回滚。

技术栈：**NestJS 12** · **PostgreSQL 16** · **Prisma 7** · **Redis 7** · **Kafka** · **Yjs (CRDT)** · **React 19** · **Vite** · **antd 6**

---

## 1. 项目介绍

PgCloudDoc 是一个**实时协同电子表格**：多个用户可以在浏览器里同时编辑同一份文档，彼此的修改实时合并，并支持随时存档、查看历史版本、一键回滚。

核心能力：

| 能力 | 说明 |
| --- | --- |
| 实时协同 | 基于 CRDT（Yjs），多人同时编辑不丢字段、自动收敛 |
| 在线状态 | 顶栏显示当前协作者头像与状态（awareness） |
| 版本管理 | 手动/异步存档，版本历史可回滚 |
| 账户体系 | 邮箱/用户名登录、注册，access + refresh 双 token |
| 安全边界 | 行级权限（越权一律 404）、限流、审计、软删除 |

它同时是一个**生产级单机部署**的完整范例：前后端同源、容器化、健康检查、异步任务、缓存与令牌轮换都做到了可交付的完备度，而不是最小可用。

---

## 2. 快速使用

只想最快跑起来，一条命令即可：

```bash
pnpm deploy:prod
```

它会自动完成「构建镜像 → 起数据层 → 数据库迁移 → 起应用 → 健康检查」全流程。完成后浏览器打开 **<http://localhost>**，注册账号即可使用。

> 前提：装好 Docker（含 Compose）。首次运行会生成 `deploy/.env.production`（随机密钥，权限 600）。

要**改代码调试**（前端/后端热更新），走本地开发路径，见下方「3.2 本地开发启动」。

---

## 3. 部署启动方法

### 3.1 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | **22+** | Nest 12 是纯 ESM 包，依赖 Node 的 `require(esm)` |
| pnpm | **12+** | monorepo 用 pnpm workspace 组织 |
| Docker | 含 Compose | PostgreSQL / Redis / Kafka 全在容器里，本地不用单独装 |

### 3.2 本地开发启动

#### 首次启动（每台机器做一次）

```bash
# 1. 装依赖
pnpm install

# 2. 复制后端配置
cp backend/.env.example backend/.env

# 3. 起 PostgreSQL / Redis / Kafka
pnpm --filter backend infra:up

# 4. 初始化数据库（建表 + 存储过程 + 视图）
pnpm --filter backend db:generate
pnpm --filter backend db:deploy
```

> Windows PowerShell 把第 2 步换成：`Copy-Item backend\.env.example backend\.env`

#### 启动服务

```bash
pnpm dev
```

一条命令同时拉起前后端（前端 5173、后端 3000），日志混在一起输出。想分开看日志就开两个终端：

```bash
pnpm --filter backend dev      # 终端 1：后端 3000
pnpm --filter frontend dev     # 终端 2：前端 5173
```

浏览器打开 **<http://localhost:5173>**，注册一个账号即可使用。

**日常启动**：容器一般保持运行，之后只需 `pnpm dev`。如果重启过机器 / Docker：

```bash
pnpm --filter backend infra:up   # 把三个容器拉回来
pnpm dev
```

### 3.3 端口

| 服务 | 端口 | 说明 |
| --- | --- | --- |
| 前端 (Vite) | **5173** | 浏览器访问入口，`/api` 和 `/collab` 代理到后端 |
| 后端 (Nest) | **3000** | REST `/api/v1` + WebSocket `/collab/:docId` |
| PostgreSQL | 5432 | 业务数据 |
| Redis | 6379 | 缓存 / 限流 / 分布式锁 / 协同广播 |
| Kafka | 9092 | 异步任务（归档、审计）；9094 仅供宿主机调试 |

### 3.4 验证安装

```bash
# 单元测试（不需要任何服务在跑）
pnpm --filter backend test          # 后端纯逻辑
pnpm --filter frontend test         # 前端单测

# 集成冒烟（需要后端、前端都启动好）
pnpm --filter backend test:smoke    # REST 全链路 + 协同全链路
pnpm --filter frontend test:smoke   # 经 vite 代理的完整接入链路
```

冒烟脚本打的是**真实服务**，会建真实用户和文档，多次运行用时间戳做标识、互不干扰。

### 3.5 试一下协同

1. 登录后新建一个文档，点进去
2. 复制地址栏链接，开一个**隐身窗口**登录另一个账号，粘贴打开
3. 两边同时改内容 —— 应该实时互相看到；对方头像会出现在顶栏
4. 点「保存」存一版，右侧「版本历史」里可以回滚

### 3.6 生产部署（一键）

单机 Docker Compose，一条命令：

```bash
pnpm deploy:prod
```

首次运行会依次完成：

1. 生成 `deploy/.env.production` —— 随机数据库/Redis 密码 + JWT 密钥（权限 600，已在 `.gitignore`）
2. 构建镜像 —— backend 多阶段构建（自包含生产依赖、非 root 运行），web 是 nginx + 静态产物
3. 起数据层 PostgreSQL / Redis / Kafka，等健康检查通过
4. 跑 `prisma migrate deploy`（独立 migrator 镜像，跑完即退，**每次发版都会执行**）
5. 起 backend / web，最后轮询 `/health/ready` 确认整条链路就绪

完成后访问 `http://localhost`（或你指定的地址）。对外只暴露 web 的端口，后端和数据层都在内部网络里。

#### 换成你的域名 / 端口

```bash
node deploy/deploy.mjs --origin https://doc.example.com   # 同时把 COOKIE_SECURE 改成 true
node deploy/deploy.mjs --port 8080                        # web 发布到 8080
```

也可以直接改 `deploy/.env.production`，之后跑 `pnpm deploy:prod` 即生效（已有的 env 文件不会被覆盖）。

#### 启用 HTTPS

1. 证书放到 `deploy/certs/`（`fullchain.pem` / `privkey.pem`）
2. 在 `deploy/docker-compose.prod.yml` 的 web 服务里挂载 `./certs:/etc/nginx/certs:ro`，并发布 443
3. 打开 [deploy/nginx.conf](deploy/nginx.conf) 末尾的 TLS server 块，把 80 的 server 改成 301 跳转
4. `PUBLIC_ORIGIN=https://你的域名`、`COOKIE_SECURE=true`

> 生产环境也可用 Caddy / Traefik / 云负载均衡在前终止 TLS，只要它们把 `X-Forwarded-Proto` 和 `X-Forwarded-For` 透传即可 —— 后端已通过 `TRUST_PROXY=1` 信任一跳代理，限流和审计拿到真实客户端 IP。

#### 常用命令

| 目的 | 命令 |
| --- | --- |
| 发布 / 更新（含迁移） | `pnpm deploy:prod` |
| 只重启，不重新构建 | `node deploy/deploy.mjs --no-build` |
| 跟随日志 | `pnpm deploy:logs` |
| 停止（保留数据） | `pnpm deploy:down` |
| 停止并清空所有数据 | `node deploy/deploy.mjs --down --reset` |
| 回滚到上一个镜像 | `node deploy/deploy.mjs --tag <旧标签> --no-build` |

#### 数据备份

```bash
docker exec pgclouddoc-prod-postgres-1 pg_dump -U pgclouddoc pgclouddoc | gzip > backup-$(date +%F).sql.gz
```

数据在命名卷 `pgclouddoc-prod_pgdata` 里，`--down` 不会删除；只有 `--reset` 才会。

#### 这套方案的边界

单机 Compose 能扛中小规模，但这几处是有意留的边界：

- **Kafka 是单节点、副本因子 1** —— 挂了异步任务（归档/审计）会积压，主流程不受影响（`/health/ready` 里 Kafka 只算 degraded）。有高可用要求就换 3 节点集群或托管服务。
- **Yjs 文档状态在进程内存 + PostgreSQL**，多实例之间靠 Redis 广播。要水平扩 backend，必须在前面加**按文档 id 粘性**的负载均衡，否则同一文档的 WebSocket 会落到不同实例。
- **迁移是发版的一部分**，不是自动常驻任务 —— 这样才能保证每次都能应用新迁移，但也意味着不能直接 `docker compose up -d` 绕过 `deploy.mjs` 发版。

---

## 4. 目录结构介绍

```text
PgCloudDoc/
├── backend/          NestJS 服务端
│   ├── prisma/       数据模型 + 迁移（含存储过程、视图）
│   ├── src/
│   │   ├── config/       环境变量 zod 校验 + 分层配置
│   │   ├── common/       横切：中间件 / 异常过滤器 / 拦截器 / Guard / 装饰器 / 错误码
│   │   ├── component/    工作表数据定义（IWorkbookData 示例，旧 /api/testSheet 用）
│   │   ├── infra/        prisma · redis · kafka · yjs
│   │   └── modules/      auth · users · documents · collab · jobs · health
│   ├── kafka/        Kafka 单节点配置（开发用）
│   ├── Dockerfile    多阶段构建：deps → build → prod-deps → migrator → runtime
│   ├── test/         集成冒烟脚本
│   └── README.md     后端架构、接口文档、设计决策
│
├── frontend/         React + Vite 前端
│   ├── src/
│   │   ├── app/api/          HTTP 客户端 + 接口封装
│   │   ├── app/auth/         登录态、登录/注册页
│   │   ├── app/documents/    文档列表
│   │   ├── app/editor/       编辑器页
│   │   ├── app/collab/       CRDT 协同（Y.Doc ↔ 引擎双向桥）
│   │   ├── app/spreadsheet/  自研表格引擎（canvas 渲染 + 撤销重做）
│   │   └── shared/           共享组件（如应用外壳 AppLayout）
│   ├── Dockerfile    nginx + 静态产物
│   └── test/         单测 + 集成冒烟
│
├── deploy/           生产部署
│   ├── deploy.mjs             一键部署脚本
│   ├── docker-compose.prod.yml
│   ├── nginx.conf             静态托管 + /api、/collab 反向代理
│   ├── nginx-proxy-headers.inc 反代公共头（include 片段）
│   ├── kafka/server.properties 双 listener 配置
│   └── .env.production.example 变量模板（真实值部署时生成）
│
└── package.json      pnpm workspace 根
```

---

## 5. 总体技术栈与技术细节

### 5.1 技术栈

| 层 | 技术 | 用途 |
| --- | --- | --- |
| 前端 | React 19 · Vite 6 · antd 6 · TypeScript | 编辑器 UI、自研 canvas 表格引擎 |
| 前端协同 | Yjs + y-protocols | 客户端 CRDT 文档、WebSocket 同步 |
| 后端 | NestJS 12（纯 ESM）· TypeScript | REST + WebSocket 服务 |
| 数据 | PostgreSQL 16 · Prisma 7（driver adapter） | 业务数据、迁移、存储过程/视图 |
| 缓存/协同 | Redis 7（ioredis） | 缓存、限流、分布式锁、Pub/Sub 广播 |
| 消息 | Kafka 3.9（kafkajs） | 异步归档、审计 |
| 部署 | Docker Compose · nginx | 单机容器化、同源反代 |

### 5.2 架构流

```text
浏览器 (React + Yjs)
   │  HTTP /api/v1 + WebSocket /collab/:docId
   ▼
nginx (静态托管 + 同源反代，唯一对外入口)
   ▼
NestJS 后端
   │  Guards / Filters / Interceptors → Controller → Service → Repository
   ├── Prisma ──────────► PostgreSQL
   ├── ioredis ─────────► Redis（缓存 / 限流 / 锁 / 广播）
   ├── Yjs Y.Doc ───────► document_updates（append-only 日志）
   └── Kafka 事件总线 ──► jobs（归档 / 审计，幂等消费）
```

### 5.3 关键设计

更完整的来龙去脉见 [backend/README.md](backend/README.md)，这里摘录要点：

**双 token 与令牌轮换** —— access（15min）无状态 JWT；refresh（30d）走 httpOnly + SameSite cookie，只存 sha256 哈希。每次刷新作废旧令牌、签发新令牌，`replacedById` 串成链；检测到重放就吊销整个 `familyId`，强制重新登录。

**CRDT 扁平 key** —— 协同真源是 Y.Doc，快照只是某一时刻的投影。单元格字段编进 Y.Map 的 key（`"row:col:field"`）而非嵌套 `Y.Map`，避免两个客户端同时新建同一格子时外层 map 冲突、输掉一方整格消失。

**持久化：update 追加日志 + compaction** —— 只追加几十字节的 update，而不是整份几 MB 快照；超阈值（默认 200 条）把 N 条合并成 base update 做 checkpoint。持久化挂在 Y.Doc 上而非连接上，无连接时（回滚、cron 归档）也能落库。

**HTTP 缓存** —— 文档快照用 `private + must-revalidate` + ETag（内容哈希）命中 304；文档详情自动 ETag；用户资料 `max-age=60`；列表不缓存。几 MB 的快照重复打开不再传 body。

**行级安全** —— 每个接口第一步 `assertAccess`，越权返回 **404 而非 403**，避免「凭 id 枚举他人文档」。鉴权必须在缓存**之前**。

**消息队列** —— 消费端 `processed_events` 表保证幂等、`eachBatchAutoResolve: false` 手动提交、指数退避 + 死信 topic，一条坏消息不卡死整个 consumer group。

**缓存层（Redis）** —— Cache-Aside / Read-Through / 滑动窗口限流 / 分布式锁等结构齐全；穿透（空值缓存 + 布隆）、击穿（互斥锁 + 逻辑过期）、雪崩（TTL 抖动）都处理；Redis 挂了通过 `safe()` 包装降级直读 PG。

**为什么没有 supertest 的 e2e** —— Nest 12 是纯 ESM 包，jest 30 在 Node 22 上不支持 `require(esm)`。所以单元测试只测无框架依赖的纯逻辑，端到端走打真实 HTTP 的冒烟脚本，反而更接近生产路径。

---

## 附录：常见问题

**启动报 `Cannot find module './generated/client'`**
忘了跑 Prisma 代码生成。执行 `pnpm --filter backend db:generate`。

**`pnpm install` 报 `ERR_PNPM_IGNORED_BUILDS`**
`prisma` / `@prisma/engines` 需要执行安装脚本，已在 [pnpm-workspace.yaml](pnpm-workspace.yaml) 的 `allowBuilds` 白名单里；若仍报错，再跑一次 `pnpm install`。

**Kafka 容器一直重启（`Restarting`）**
看日志 `docker logs pgclouddoc-kafka`。最常见原因是 [backend/kafka/server.properties](backend/kafka/server.properties) 没挂载 —— 这里刻意用配置文件挂载而非 `KAFKA_*` 环境变量，因为镜像的环境变量映射对 `advertised.listeners` 不生效。

**Vite 提示 `Port 5173 is in use, trying another one`**
5173 上有旧 vite 进程。它会自动换到 5174，但旧进程没有 `/collab` 的 WebSocket 代理，协同连不上。手动访问新端口，或杀掉旧进程：

```powershell
Get-NetTCPConnection -LocalPort 5173 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

**改了 `backend/.env` 不生效**
环境变量只在进程启动时读一次，改完要重启后端。

**`pnpm --filter backend test` 里没有针对 Nest 装配的测试**
已知限制：Nest 12 是纯 ESM，jest 30 在 Node 22 上装不进来。单元测试只覆盖无框架依赖的纯逻辑，端到端走打真实 HTTP 的冒烟脚本。

---

## 附录：一键重来

想清空所有数据重新开始：

```bash
pnpm --filter backend infra:down   # 停容器
docker volume rm pgclouddoc_pgdata pgclouddoc_redisdata pgclouddoc_kafkadata
pnpm --filter backend infra:up     # 起容器（会重新初始化）
pnpm --filter backend db:deploy    # 重新建表
```
