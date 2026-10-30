# PgCloudDoc

协同电子表格（云文档）。支持多人实时编辑、版本存档与回滚。

技术栈：**NestJS 12** · **PostgreSQL 16** · **Prisma 7** · **Redis 7** · **Kafka** · **Yjs (CRDT)** · **React 19** · **Vite** · **antd**

---

## 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | **22+** | Nest 12 是纯 ESM 包，依赖 Node 的 `require(esm)` |
| pnpm | **12+** | monorepo 用 pnpm workspace 组织 |
| Docker | 含 Compose | PostgreSQL / Redis / Kafka 全在容器里，本地不用单独装 |

---

## 快速启动

### 首次启动（每台机器做一次）

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

### 启动服务

```bash
pnpm dev
```

一条命令同时拉起前后端（前端 5173、后端 3000），日志混在一起输出。

想分开看日志就开两个终端：

```bash
# 终端 1
pnpm --filter backend dev

# 终端 2
pnpm --filter frontend dev
```

然后浏览器打开 **<http://localhost:5173>**，注册一个账号就能用了。

### 日常启动

容器一般保持运行，之后只需要：

```bash
pnpm dev
```

如果重启过机器 / Docker：

```bash
pnpm --filter backend infra:up   # 把三个容器拉回来
pnpm dev
```

---

## 端口

| 服务 | 端口 | 说明 |
| --- | --- | --- |
| 前端 (Vite) | **5173** | 浏览器访问入口，`/api` 和 `/collab` 代理到后端 |
| 后端 (Nest) | **3000** | REST `/api/v1` + WebSocket `/collab/:docId` |
| PostgreSQL | 5432 | 业务数据 |
| Redis | 6379 | 缓存 / 限流 / 分布式锁 / 协同广播 |
| Kafka | 9092 | 异步任务（归档、审计） |

---

## 验证安装

```bash
# 单元测试（不需要任何服务在跑）
pnpm --filter backend test          # 24 个
pnpm --filter frontend test         # 11 个

# 集成冒烟（需要后端、前端都启动好）
pnpm --filter backend test:smoke    # REST 全链路 + 协同全链路
pnpm --filter frontend test:smoke   # 经 vite 代理的完整接入链路
```

冒烟脚本打的是**真实服务**，会建真实用户和文档。多次运行不会互相干扰（用时间戳做标识）。

---

## 试一下协同

1. 登录后新建一个文档，点进去
2. 复制地址栏链接，开一个**隐身窗口**登录另一个账号，粘贴打开
3. 两边同时改内容 —— 应该实时互相看到；对方的头像会出现在顶栏
4. 点「保存」存一版，右侧「版本历史」里可以回滚

---

## 目录结构

```
PgCloudDoc/
├── backend/          NestJS 服务端
│   ├── prisma/       数据模型 + 迁移（含存储过程、视图）
│   ├── src/
│   │   ├── config/       环境变量校验 + 分层配置
│   │   ├── common/       中间件 / 异常过滤器 / 拦截器 / Guard
│   │   ├── infra/        prisma · redis · kafka · yjs
│   │   └── modules/      auth · users · documents · collab · jobs · health
│   ├── kafka/        Kafka 单节点配置
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
│   │   └── app/spreadsheet/  自研表格引擎（canvas 渲染 + 撤销重做）
│   └── test/         单测 + 集成冒烟
│
└── package.json      pnpm workspace 根
```

**想了解设计**看 [backend/README.md](backend/README.md) —— 里面有数据模型、接口清单、以及双 token 轮换 / CRDT 扁平 key / 缓存策略 / 消息队列这些决策的来龙去脉。

---

## 常见问题

**启动报 `Cannot find module './generated/client'`**
忘了跑 Prisma 代码生成。执行 `pnpm --filter backend db:generate`。

**`pnpm install` 报 `ERR_PNPM_IGNORED_BUILDS`**
`prisma` / `@prisma/engines` 需要执行安装脚本。这两个已经在 [pnpm-workspace.yaml](pnpm-workspace.yaml) 的 `allowBuilds` 白名单里，正常 `pnpm install` 就会通过；如果还是报，跑一次 `pnpm install` 即可。

**Kafka 容器一直重启（`Restarting`）**
看日志 `docker logs pgclouddoc-kafka`。最常见的原因是 [backend/kafka/server.properties](backend/kafka/server.properties) 没挂载进去 —— 这里刻意用**配置文件挂载**而不是 `KAFKA_*` 环境变量，因为镜像的环境变量映射对 `advertised.listeners` 不生效，会导致 Kafka 拒绝启动（`advertised.listeners cannot use the nonroutable meta-address 0.0.0.0`）。

**Vite 提示 `Port 5173 is in use, trying another one`**
说明 5173 上有旧的 vite 进程（改过 vite 配置后重启最容易撞上）。它会自动换到 5174 —— 但**旧进程没有 `/collab` 的 WebSocket 代理**，协同会连不上。手动访问新端口，或者杀掉旧进程重开：

```powershell
Get-NetTCPConnection -LocalPort 5173 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

**改了 `backend/.env` 不生效**
环境变量只在进程启动时读一次，改完要重启后端。

**`pnpm --filter backend test` 里没有针对 Nest 装配的测试**
已知限制。Nest 12 发布的是纯 ESM 包，jest 30 在 Node 22 上装不进来（`require(esm)` 未支持）。所以单元测试只覆盖无框架依赖的纯逻辑，端到端走打真实 HTTP 的冒烟脚本 —— 反而更接近生产路径。

---

## 一键重来

想清空所有数据重新开始：

```bash
pnpm --filter backend infra:down   # 停容器
docker volume rm pgclouddoc_pgdata pgclouddoc_redisdata pgclouddoc_kafkadata
pnpm --filter backend infra:up     # 起容器（会重新初始化）
pnpm --filter backend db:deploy    # 重新建表
```
