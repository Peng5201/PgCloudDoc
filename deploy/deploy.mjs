#!/usr/bin/env node
/**
 * PgCloudDoc 一键部署。
 *
 *   node deploy/deploy.mjs                      # 首次或日常发布（构建 → 起依赖 → 迁移 → 起应用）
 *   node deploy/deploy.mjs --origin https://doc.example.com
 *   node deploy/deploy.mjs --no-build            # 只重启，不动镜像
 *   node deploy/deploy.mjs --down                # 停服务（保留数据）
 *   node deploy/deploy.mjs --down --reset        # 停服务并删除数据卷
 *   node deploy/deploy.mjs --logs                # 跟随日志
 *
 * 为什么不用 `docker compose up --wait` 一把梭：
 *   迁移是**每次发版都要跑**的一次性任务，做成常驻 service 的话，
 *   第二次 `up -d` 不会重新执行它，新迁移就永远不会应用。
 *   所以顺序是脚本显式编排的：先起数据层 → 跑迁移 → 再起应用层。
 *
 * 首次运行会自动生成 deploy/.env.production（含随机密钥，权限 600），
 * 之后再跑不会覆盖你的修改。
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const composeFile = join(here, 'docker-compose.prod.yml');
const exampleFile = join(here, '.env.production.example');
const envFile = process.env.DEPLOY_ENV_FILE
    ? resolve(process.env.DEPLOY_ENV_FILE)
    : join(here, '.env.production');

// ─────────────────────────── 参数 ───────────────────────────

const HELP = `
PgCloudDoc 一键部署

用法：
  node deploy/deploy.mjs [选项]

选项：
  --origin <url>   对外访问地址，如 https://doc.example.com（首次生成配置时写入）
  --port <n>       web 发布到宿主机的端口，默认 80
  --tag <tag>      镜像标签，默认 latest（回滚用：--tag <旧标签>）
  --no-build       跳过镜像构建
  --down           停止并删除容器（保留数据卷）
  --reset          配合 --down 删除数据卷：所有数据清空
  --logs           跟随全部服务日志
  -h, --help       显示本帮助

环境变量：
  DEPLOY_ENV_FILE  指定 env 文件路径，默认 deploy/.env.production
`;

const opts = {
    origin: null,
    port: null,
    tag: null,
    build: true,
    down: false,
    reset: false,
    logs: false,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
        const v = argv[++i];
        if (!v || v.startsWith('--')) fail(`参数 ${arg} 缺少取值`);
        return v;
    };
    switch (arg) {
        case '--origin':
            opts.origin = next().replace(/\/+$/, '');
            break;
        case '--port':
            opts.port = next();
            break;
        case '--tag':
            opts.tag = next();
            break;
        case '--no-build':
            opts.build = false;
            break;
        case '--down':
            opts.down = true;
            break;
        case '--reset':
            opts.reset = true;
            break;
        case '--logs':
            opts.logs = true;
            break;
        case '-h':
        case '--help':
            console.log(HELP.trim());
            process.exit(0);
            break;
        default:
            fail(`未知参数：${arg}\n${HELP.trim()}`);
    }
}

if (opts.origin && !/^https?:\/\/[^\s/]+$/.test(opts.origin)) {
    fail(`--origin 格式不对：${opts.origin}（应形如 https://doc.example.com，不带结尾斜杠）`);
}
if (opts.port && !/^\d+$/.test(opts.port)) {
    fail(`--port 必须是数字：${opts.port}`);
}
if (opts.reset && !opts.down) {
    fail('--reset 必须和 --down 一起用，避免误删数据');
}

// ─────────────────────────── 环境文件 ───────────────────────────

/** 生成 env 文件（仅首次），<generate> 替换为随机密钥 */
function ensureEnvFile() {
    if (!existsSync(envFile)) {
        if (!existsSync(exampleFile)) fail(`找不到模板：${exampleFile}`);
        let text = readFileSync(exampleFile, 'utf8');
        text = text.replace(/<generate>/g, () => randomBytes(32).toString('base64url'));
        writeFileSync(envFile, text, { mode: 0o600 });
        console.log(`已生成 ${envFile}（含随机密钥，权限 600）`);
    } else {
        try {
            chmodSync(envFile, 0o600);
        } catch {
            // Windows 上 chmod 基本无效，忽略
        }
    }

    if (opts.origin || opts.port) {
        let text = readFileSync(envFile, 'utf8');
        if (opts.origin) {
            text = setKey(text, 'PUBLIC_ORIGIN', opts.origin);
            // 走 HTTPS 时 refresh cookie 必须带 Secure，否则浏览器会拒收
            text = setKey(text, 'COOKIE_SECURE', opts.origin.startsWith('https://') ? 'true' : 'false');
        }
        if (opts.port) text = setKey(text, 'WEB_PORT', opts.port);
        writeFileSync(envFile, text);
    }
}

function setKey(text, key, value) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) return text.replace(re, `${key}=${value}`);
    return `${text.replace(/\s*$/, '')}\n${key}=${value}\n`;
}

function readEnv() {
    const env = {};
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) env[m[1]] = m[2];
    }
    return env;
}

// ─────────────────────────── docker ───────────────────────────

function docker(args, extraEnv = {}) {
    const result = spawnSync('docker', args, {
        cwd: repoRoot,
        stdio: 'inherit',
        env: { ...process.env, ...extraEnv },
    });
    if (result.error) {
        fail(`执行 docker 失败：${result.error.message}`);
    }
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function compose(args, extraEnv = {}) {
    docker(['compose', '--env-file', envFile, '-f', composeFile, ...args], extraEnv);
}

function assertDockerRunning() {
    const probe = spawnSync('docker', ['info'], { stdio: 'ignore' });
    if (probe.status !== 0) {
        fail('连不上 Docker 守护进程。请先启动 Docker Desktop / dockerd 再重试。');
    }
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
    // 先把配置准备好：这一步不依赖 Docker，配置有问题也能立刻暴露
    ensureEnvFile();
    assertDockerRunning();
    const imageEnv = opts.tag ? { IMAGE_TAG: opts.tag } : {};

    if (opts.down) {
        step(opts.reset ? '停止服务并删除数据卷' : '停止服务（保留数据）');
        compose(['down', ...(opts.reset ? ['-v'] : [])]);
        console.log(opts.reset ? '已停止，所有数据卷已删除。' : '已停止，数据卷保留。');
        return;
    }

    if (opts.logs) {
        compose(['logs', '-f', '--tail=100']);
        return;
    }

    if (opts.build) {
        step('构建镜像');
        // --profile tools 一起构建：migrate 镜像也要有，否则 run 时才现拉
        compose(['--profile', 'tools', 'build'], imageEnv);
    }

    step('启动数据层（PostgreSQL / Redis / Kafka）');
    compose(
        ['up', '-d', 'postgres', 'redis', 'kafka', '--wait', '--wait-timeout', '180'],
        imageEnv
    );

    step('执行数据库迁移（prisma migrate deploy）');
    compose(['--profile', 'tools', 'run', '--rm', 'migrate'], imageEnv);

    step('启动应用（backend / web）');
    compose(['up', '-d', '--wait', '--wait-timeout', '180'], imageEnv);

    const env = readEnv();
    const port = env.WEB_PORT || '80';
    const origin = env.PUBLIC_ORIGIN || `http://localhost:${port}`;

    step('健康检查');
    await waitReady(port);

    console.log(`
部署完成

  访问地址   ${origin}
  健康检查   http://127.0.0.1:${port}/health/ready
  跟随日志   node deploy/deploy.mjs --logs
  停止服务   node deploy/deploy.mjs --down
  清空重来   node deploy/deploy.mjs --down --reset
`);
}

/**
 * 轮询 readiness，直到整条链路（nginx → backend → PG/Redis/Kafka）就绪。
 * `up --wait` 已经等过容器健康，这里再确认一遍对外链路，避免只看了容器状态。
 */
async function waitReady(port, timeoutMs = 120_000) {
    const url = `http://127.0.0.1:${port}/health/ready`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok) return;
        } catch {
            // 容器还没起来，连接会被拒绝；继续等
        }
        await new Promise((r) => setTimeout(r, 2000));
    }

    fail(`等待 ${url} 就绪超时（120s）。用 \`node deploy/deploy.mjs --logs\` 看日志。`);
}

function step(title) {
    console.log(`\n── ${title} ──`);
}

function fail(message) {
    console.error(`\n✖ ${message}\n`);
    process.exit(1);
}

await main();
