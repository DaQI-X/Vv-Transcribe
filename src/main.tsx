/**
 * 渲染进程入口
 * 挂载 React 根组件，初始化 HashRouter 路由
 * 启动时主动轮询服务就绪状态，失败则展示错误页
 * 开屏动画最少展示 2.5 秒，确保动画播完
 * 每次冷启动（含首次）显示开屏，HMR 刷新不重复显示
 * beforeunload 设置 localStorage 标志，app 重启后 sessionStorage 清空但标志仍在，触发再次显示
 */
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import './index.css'
import { router } from './router/index.tsx'
import { SplashScreen } from './components/SplashScreen'
import { ErrorPage } from './components/ErrorPage'
import './stores/useThemeStore' // 初始化主题

const MIN_SPLASH_MS = 2500 // 开屏动画最短展示时间（0.3s 延迟 + 2s 擦除 + 余量）
const NEED_SPLASH_KEY = 'vv_need_splash'
const SESSION_SPLASH_KEY = 'vv_splash_done'

type AppState = 'loading' | 'ready' | 'error'

function App() {
  // sessionStorage 在 HMR 刷新时保留（同进程），app 完全重启时清空
  // localStorage 标志在 beforeunload 时设置，确保 app 重启后再次显示开屏
  const alreadyShown = sessionStorage.getItem(SESSION_SPLASH_KEY)
  const needsSplash = localStorage.getItem(NEED_SPLASH_KEY)
  // 首次安装（两个标志都不存在）也显示开屏
  if (!needsSplash && !alreadyShown) {
    localStorage.setItem(NEED_SPLASH_KEY, '1')
  }
  const isColdStart = !alreadyShown && localStorage.getItem(NEED_SPLASH_KEY) !== null
  const [state, setState] = useState<AppState>(isColdStart ? 'loading' : 'ready')
  const [errorMsg, setErrorMsg] = useState('')
  const servicesReady = useRef(false)

  // 页面卸载前设置开屏标志，确保下次冷启动显示开屏动画
  useEffect(() => {
    const handleBeforeUnload = () => {
      localStorage.setItem(NEED_SPLASH_KEY, '1')
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  useEffect(() => {
    if (!isColdStart) return

    const splashStart = Date.now()
    let cancelled = false
    let attempts = 0
    const MAX_ATTEMPTS = 60

    const tryDismiss = () => {
      if (cancelled) return
      const elapsed = Date.now() - splashStart
      const remaining = Math.max(0, MIN_SPLASH_MS - elapsed)
      setTimeout(() => {
        if (!cancelled) {
          localStorage.removeItem(NEED_SPLASH_KEY)
          sessionStorage.setItem(SESSION_SPLASH_KEY, '1')
          setState('ready')
        }
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
          servicesReady.current = true
          tryDismiss()
          return
        }
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
    return () => { cancelled = true }
  }, [isColdStart])

  if (state === 'error') {
    return <ErrorPage message={errorMsg} />
  }

  return (
    <>
      <SplashScreen visible={state === 'loading'} />
      <RouterProvider router={router} />
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
