/**
 * 渲染进程入口
 * 挂载 React 根组件，初始化 HashRouter 路由
 * 启动时主动轮询服务就绪状态，失败则展示错误页
 * 开屏动画只属于真正的冷启动（主进程首次建窗口时以 ?cold=1 下发），且至少展示 2.5 秒
 */
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { useEffect, useState } from 'react'
import './index.css'
import { router } from './router/index.tsx'
import { SplashScreen } from './components/SplashScreen'
import { ErrorPage } from './components/ErrorPage'
import './stores/useThemeStore' // 初始化主题

const MIN_SPLASH_MS = 2500 // 开屏动画最短展示时间（0.3s 延迟 + 2s 擦除 + 余量）
const SPLASH_DONE_KEY = 'vv_splash_done'

type AppState = 'loading' | 'ready' | 'error'

/**
 * 冷启动由主进程判定并随 URL 下发：应用没被完全杀掉时（macOS 关窗后从 Dock 重开）
 * 新窗口拿到的是 cold=0，不该重放动画。
 * sessionStorage 只用来挡同一窗口内的手动刷新，它随窗口销毁自动清空，
 * 不像 localStorage 会跨进程残留 —— 那正是旧实现误判的原因。
 */
const coldStart = new URLSearchParams(window.location.search).get('cold') === '1'
const alreadyShown = sessionStorage.getItem(SPLASH_DONE_KEY) !== null

function App() {
  const [state, setState] = useState<AppState>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [phase, setPhase] = useState('正在启动转写引擎')
  const showSplash = coldStart && !alreadyShown

  useEffect(() => {
    const startedAt = Date.now()
    let cancelled = false
    let attempts = 0
    // 与主进程 HEALTH_TIMEOUT_MS（60s）对齐：ASR 子进程解压/首次启动慢，渲染层提前放弃只会给用户一个假故障页
    const MAX_ATTEMPTS = 120

    const finish = () => {
      if (cancelled) return
      const remaining = showSplash ? Math.max(0, MIN_SPLASH_MS - (Date.now() - startedAt)) : 0
      setTimeout(() => {
        if (cancelled) return
        sessionStorage.setItem(SPLASH_DONE_KEY, '1')
        setState('ready')
      }, remaining)
    }

    const poll = async () => {
      attempts++
      try {
        const result = await window.electronAPI?.getServiceReady()
        if (cancelled) return

        if (result?.error) {
          setErrorMsg(result.error)
          setState('error')
          return
        }
        if (result?.ready) {
          setPhase('即将就绪')
          finish()
          return
        }
        if (result) setPhase(result.asrDone ? '正在准备词库' : '正在启动转写引擎')
      } catch {
        // IPC 调用失败，继续轮询
      }

      if (attempts >= MAX_ATTEMPTS) {
        setErrorMsg('服务初始化超时，请关闭应用后重新打开')
        setState('error')
        return
      }

      setTimeout(poll, 500)
    }

    poll()
    return () => {
      cancelled = true
    }
  }, [showSplash])

  if (state === 'error') {
    return <ErrorPage message={errorMsg} />
  }

  return (
    <>
      {showSplash && <SplashScreen visible={state === 'loading'} phase={phase} />}
      <RouterProvider router={router} />
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
