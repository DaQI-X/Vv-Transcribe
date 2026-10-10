/**
 * 渲染进程入口
 * 挂载 React 根组件，初始化 HashRouter 路由
 * 启动时主动轮询服务就绪状态，失败则展示错误页
 * 开屏动画最少展示 2.5 秒，确保动画播完
 */
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import './index.css'
import { router } from './router/index.tsx'
import { SplashScreen } from './components/SplashScreen'
import { ErrorPage } from './components/ErrorPage'

const MIN_SPLASH_MS = 2500 // 开屏动画最短展示时间（0.3s 延迟 + 2s 擦除 + 余量）

type AppState = 'loading' | 'ready' | 'error'

function App() {
  const [state, setState] = useState<AppState>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const servicesReady = useRef(false)

  useEffect(() => {
    const splashStart = Date.now()
    let cancelled = false
    let attempts = 0
    const MAX_ATTEMPTS = 60

    const tryDismiss = () => {
      if (cancelled) return
      const elapsed = Date.now() - splashStart
      const remaining = Math.max(0, MIN_SPLASH_MS - elapsed)
      setTimeout(() => {
        if (!cancelled) setState('ready')
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
  }, [])

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
