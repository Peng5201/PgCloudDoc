#
# PgCloudDoc 前端镜像。
#
# 构建上下文是仓库根目录，原因同 backend/Dockerfile。
# 产物是纯静态文件，用 nginx 托管并顺带做反向代理 ——
# 前端、REST、WebSocket 共用一个 origin。
#
# 同样不写 `# syntax=` —— 见 backend/Dockerfile 的说明

# 基础镜像可覆盖，见 backend/Dockerfile
ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:1.27-alpine

FROM ${NODE_IMAGE} AS base
# 同 backend/Dockerfile：store 指向缓存挂载点
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_store_dir=/pnpm/store \
    CI=true
# pnpm 版本显式锁定，和 backend/Dockerfile 保持一致
ARG PNPM_VERSION=12.14.0
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=${NPM_REGISTRY}
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/package.json
# backend 的 package.json 也要在：pnpm 按 workspace 解析 lockfile，
# 缺一个 importer 会认为锁文件过期
COPY backend/package.json ./backend/package.json
# 插件工作区：frontend 依赖 @pgclouddoc/plugin-api；pnpm 同样需要这些 importer
COPY packages/plugin-api/package.json ./packages/plugin-api/package.json
COPY packages/ai-protocol/package.json ./packages/ai-protocol/package.json
COPY plugins/package.json ./plugins/package.json
COPY plugins/csv-tools/package.json ./plugins/csv-tools/package.json
COPY plugins/ai-agent/package.json ./plugins/ai-agent/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter frontend...

FROM deps AS build
COPY frontend ./frontend
# @pgclouddoc/plugin-api 是 workspace 包，frontend 的 prebuild 会先用它自己的
# typescript 构建 dist，因此源码必须进 build 层
COPY packages/plugin-api ./packages/plugin-api
RUN pnpm --filter frontend build

FROM ${NGINX_IMAGE} AS runtime
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/nginx-proxy-headers.inc /etc/nginx/conf.d/proxy-headers.inc
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
