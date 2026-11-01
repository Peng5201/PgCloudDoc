#
# PgCloudDoc 后端镜像。
#
# 构建上下文是**仓库根目录**（pnpm workspace），不是 backend/：
#   docker build -f backend/Dockerfile --target runtime .
# compose 里已配好 context: ..，这里只说明为什么 —— backend 的依赖解析
# 需要根部的 pnpm-lock.yaml / pnpm-workspace.yaml。
#
# 刻意不写 `# syntax=docker/dockerfile:1.7`：
# 那条指令会让 BuildKit 去 Docker Hub 拉一个只用于解析 Dockerfile 的前端镜像，
# 国内网络/镜像加速器不稳时直接卡在 TLS 握手。这里用到的 RUN --mount=type=cache
# 和 COPY --chown 在内置前端里都支持，不需要额外拉镜像。
#
# stage 划分：
#   deps       只装依赖，带 BuildKit 缓存 —— 改业务代码不会触发重装
#   build      生成 Prisma Client + nest build
#   prod-deps  用 pnpm deploy 裁出自包含的生产依赖目录（161MB，不含 CLI/测试工具）
#   migrator   一次性迁移镜像：保留 prisma CLI 和 migrations
#   runtime    最终运行镜像，非 root，只带 dist + 生产依赖

# 基础镜像可覆盖（镜像加速器不可用时可换成能访问的 registry 前缀）：
#   NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
# npm_config_store_dir：把 pnpm store 固定到下面 RUN 里挂载的缓存目录，
# 跨构建复用已下载的包（不设置的话缓存挂载点是个空目录，等于没缓存）
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_store_dir=/pnpm/store \
    CI=true
# pnpm 版本显式锁定：镜像里不依赖开发者本机装了哪个版本
ARG PNPM_VERSION=12.14.0
# 包源可覆盖（国内构建慢时传 --build-arg NPM_REGISTRY=https://registry.npmmirror.com）
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=${NPM_REGISTRY}
# apt 源可覆盖：默认走官方源；国内网络不稳时传 mirrors.aliyun.com 之类
# （compose 会从 deploy/.env.production 的 APT_MIRROR 传进来）
ARG APT_MIRROR=

# Prisma 的 schema engine 依赖 openssl，bookworm-slim 不自带。
# 只装在构建链上：prisma generate 和 migrator 的 migrate deploy 需要它；
# 运行镜像用的是 Prisma 7 的 driver adapter + WASM query compiler，不需要。
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

# 用 npm 全局装 pnpm 而不是 corepack：
# corepack 有自己写死的默认源，不读 npm_config_registry，国内网络会卡在官方源上
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app

# ─────────────────────────── 依赖 ───────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
# 新增 workspace 包后，frozen-lockfile 要求所有 importer 的 package.json 都在
COPY packages/plugin-api/package.json ./packages/plugin-api/package.json
COPY packages/ai-protocol/package.json ./packages/ai-protocol/package.json
COPY plugins/package.json ./plugins/package.json
COPY plugins/csv-tools/package.json ./plugins/csv-tools/package.json
COPY plugins/ai-agent/package.json ./plugins/ai-agent/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter backend...

# ─────────────────────────── 构建 ───────────────────────────
FROM deps AS build
COPY backend ./backend
# backend 依赖 workspace 包 @pgclouddoc/plugin-api；它的 tsc 由 --filter backend...
# 一并安装。dist 必须在 pnpm deploy 之前生成，否则运行镜像里缺协议包。
COPY packages ./packages
# prisma generate 不连库，但 prisma.config.ts 在 CLI 加载时会读 DATABASE_URL，
# 给个占位值，避免因为是 undefined 而报配置错误
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @pgclouddoc/plugin-api build \
 && pnpm --filter @pgclouddoc/ai-protocol build \
 && pnpm --filter backend db:generate \
 && pnpm --filter backend build

# ─────────────────────── 生产依赖（裁剪） ───────────────────────
# pnpm deploy 摊平 node_modules，runtime 里不需要再跑包管理器。
#
# 必须加 node-linker=hoisted：默认的 isolated 布局会在 node_modules 里
# 生成指向 .pnpm 的**绝对路径**软链，跨 stage COPY 到别的目录后全部失效
# （镜像里跑起来就是 MODULE_NOT_FOUND）。hoisted 布局是纯目录树，0 个软链，
# 放哪个路径都能用。
FROM build AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter backend deploy --prod --config.node-linker=hoisted /out

# ─────────────────────────── 迁移 ───────────────────────────
# 单独出镜像，runtime 就能保持精简；compose 里作为一次性任务运行
FROM build AS migrator
CMD ["pnpm", "--filter", "backend", "db:deploy"]

# ─────────────────────────── 运行 ───────────────────────────
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production

WORKDIR /app

# 插件产物目录：named volume 首次挂载会继承镜像目录的属主，
# 不预先 chown 的话，以 node 用户运行的进程写不进 /data/plugins。
RUN mkdir -p /data/plugins && chown node:node /data/plugins

COPY --from=prod-deps --chown=node:node /out ./
COPY --from=build --chown=node:node /app/backend/dist ./dist

# 不用 root 跑应用进程
USER node

EXPOSE 3000

# 直接起 node：不经过 nest start，避免把 CLI 带进生产
CMD ["node", "dist/main.js"]
