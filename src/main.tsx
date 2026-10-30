/**
 * 渲染进程入口
 * 挂载 React 根组件，初始化 HashRouter 路由
 * 启动时主动轮询服务就绪状态，失败则展示错误页
 * 开屏动画只属于真正的冷启动（主进程首次建窗口时以 ?cold=1 下发），且至少展示 2.5 秒
 * 崩溃兜底分两层：ErrorBoundary 接渲染期抛错，rendererErrorWatch 接事件/异步里的那部分
 */
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { useEffect, useState } from 'react'
import './index.css'
import { router } from './router/index.tsx'
import { SplashScreen } from './components/SplashScreen'
import { ErrorPage } from './components/ErrorPage'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ToastContainer } from './components/ui/Toast'
import { installRendererErrorWatch } from './utils/rendererErrorWatch'
import './stores/useThemeStore' // 初始化主题

const MIN_SPLASH_MS = 2500 // 开屏动画最短展示时间（0.3s 延迟 + 2s 擦除 + 余量）
const SPLASH_DONE_KEY = 'vv_splash_done'

type AppState = 'loading' | 'ready' | 'error'

/**
 * 首帧之前把平台写到 <html> 上：`.harder_top` 的左留白要按红绿灯在不在场取值
 * （见 index.css 的 `--header-pad-left`），而这件事只能由主进程那侧的事实决定——preload 带过来的
 * `process.platform` 和创建窗口时用的 `titleBarStyle` 是同一个来源。写在模块作用域、render 之前，
 * 晚一步 header 就会先按别的平台的留白画一次再跳位。
 */
document.documentElement.dataset.platform = window.electronAPI?.platform ?? 'other'

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

createRoot(document.getElementById('root')!).render(
  <>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    {/*
      toast 容器必须挂在 ErrorBoundary 外面。它以前在转写页里，后来挪进 boundary 内部当兄弟——
      实测（CDP 打进崩溃态查 DOM）那条路也不通：boundary 接住抛错后是用 fallback 换掉整个 children，
      兄弟一起被换掉，恰恰在崩了的那一刻 toast 容器自己也没了。挂在外面才真的活得住，
      主进程推来的崩溃通知（app:errorNotice）才有地方落。
      启动失败那一支（直接 return <ErrorPage/>）同理。
    */}
    <ToastContainer />
  </>
)

/*
  全局错误兜底同样不能装在 App 里：App 一崩，它的 effect 不是没跑就是被清掉，
  而那正是最需要这条通道的时候（事件回调和 Promise 里的抛错，ErrorBoundary 接不到）。
  放在 render 之后：此刻 ToastContainer 已经挂上，toast 的模块级 setter 不再是空的。
*/
installRendererErrorWatch()
