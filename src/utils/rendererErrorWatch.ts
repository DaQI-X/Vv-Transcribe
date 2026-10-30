/**
 * 渲染层的全局错误兜底
 *
 * React 的 ErrorBoundary 只管「渲染时抛的错」。事件回调、setTimeout、没接 .catch 的
 * Promise 这几类抛错它接不到，界面上的表现是「点了没反应」，日志里则一个字都没有。
 * 这一层补的就是那三类，外加主进程推回来的一句话（见 electron/main/services/crashWatch.ts）。
 *
 * 都只做两件事：把现场送进主进程日志（用户唯一的可交付物是 app.log），再弹一条 toast
 * 让人知道刚才那一下不是「应用反应慢」。
 */
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { toast } from '@/components/ui/Toast'

/**
 * 同一个错误反复出现时只说一次。判重必须连日志一起挡：一个在动画帧里抛错的坏组件
 * 一秒能触发六十次，日志rotation 还没上（1.0.8·⑤），就这么被刷成几百 MB。
 */
const recent: { message: string; at: number }[] = []
const DEDUPE_MS = 8000

function shouldReport(message: string): boolean {
  const now = Date.now()
  while (recent.length && now - recent[0].at > DEDUPE_MS) recent.shift()
  if (recent.some((r) => r.message === message)) return false
  recent.push({ message, at: now })
  return true
}

function sendToMain(message: string, stack: string) {
  const api = getElectronAPI()
  // 渲染层的错误一律由这一层落日志：出错时组件里那套 frontendLogger 未必已经接上 IPC
  api?.log({ level: 'ERROR', module: 'RendererError', message, data: { stack } })?.catch(() => {
    // IPC 本身坏了就没法再报告它坏了，这条链路只能到此为止
  })
}

function report(message: string, stack: string) {
  if (!shouldReport(message)) return
  sendToMain(message, stack)
  toast.error(
    `界面出了个错：${message}。已记进日志，反复出现请把日志发给开发者`,
    8000,
    { label: '打开日志文件夹', onClick: () => void getElectronAPI()?.openLogDirectory() },
  )
}

/**
 * 装上全局监听，返回卸载函数（调用方不接也行：装在 main.tsx 的模块作用域，窗口活着它就活着）。
 * 必须在 ToastContainer 挂载之后调用：toast 的 setter 是模块级单例，容器没渲染时喊出去是空的。
 * 也正因为如此，它不能装进组件的 effect 里——那个组件一旦崩，兜底就跟着没了。
 */
export function installRendererErrorWatch(): () => void {
  const onError = (event: ErrorEvent) => {
    // 图片/音频这类资源加载失败也走 window 的 error，但它没有 event.error，
    // 而且播放器早就有自己的失败提示，这里再弹一条只会重复
    if (!event.error) return
    report(event.message || '界面里抛出了一个未捕获的异常', event.error.stack ?? '')
  }

  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason
    const message =
      reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : JSON.stringify(reason)
    report(`界面里有一步没跑完：${message || '未提供原因'}`, reason instanceof Error ? (reason.stack ?? '') : '')
  }

  // 主进程兜底推来的一句话：它只在渲染进程还活着时才用这条通道（界面没了它只能弹系统对话框）。
  // 现场已经在主进程日志里了，所以这里不再 sendToMain，只走同一套判重 + toast。
  const offNotice = getElectronAPI()?.onErrorNotice((message) => {
    if (!shouldReport(message)) return
    toast.error(message, 10000)
  })

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)

  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    offNotice?.()
  }
}
