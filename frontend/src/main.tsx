import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { initRuntimeConfig, loadRuntimeConfig } from './app/config/runtime-config'

/**
 * 启动顺序：先拿配置，再渲染。
 *
 * 配置来自 etcd（后端代理成 GET /api/v1/config），首屏就要用到品牌名、
 * 维护公告这些字段，所以不能等 React 挂载后再异步补 —— 那会先渲染一版
 * 默认值再闪一下。
 *
 * loadRuntimeConfig() 自带 1.5s 超时和三级兜底（网络 → 本地缓存 → 内置默认），
 * 配置服务挂了也一定会往下走，不会白屏。
 */
async function bootstrap() {
  const config = await loadRuntimeConfig()
  initRuntimeConfig(config)

  // 标题/品牌名跟着配置走
  document.title = config.appName

  // index.html 里的首屏占位（等配置期间显示）
  document.getElementById('boot-splash')?.remove()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void bootstrap()
