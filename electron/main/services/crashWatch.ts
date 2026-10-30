/**
 * 崩溃兜底
 *
 * 这一层要修的是「出事的时候没人说话」。改之前主进程没有 uncaughtException /
 * unhandledRejection 处理器，Node 15+ 对未处理拒绝的默认处置就是结束进程，于是任何一处
 * 漏了 .catch 的异步链路都会让整个应用直接消失：app.log 里不会有最后一行，用户不知道
 * 为什么窗口没了，正在跑的转写连一条失败记录都没有。渲染进程崩掉同样是白屏杵在那儿，
 * 既不重载也不解释。
 *
 * 三条规矩：
 * 1. 先写日志再谈界面。日志是开发者唯一能拿到的现场（用户只能「打开日志文件夹」发过来）。
 *    凡是后面要跟一个阻塞式对话框的，日志一律走 logger.errorSync：常规日志是异步落盘的，
 *    而 showMessageBoxSync 会把事件循环按住到用户点掉为止——实测那条现场就是这么丢的。
 * 2. 谁还活着就用谁的通道。渲染进程还在 → 走 toast；渲染进程没了 → 只能弹系统对话框。
 * 3. 不替用户决定丢不丢数据。主进程异常时状态确实不可信，但界面上那份没导出的结果是真的，
 *    所以报原因、建议重启，由人点头，不直接退出。
 */
import { app, dialog, type BrowserWindow } from 'electron'
import { logger } from './logger'

const TAG = 'Crash'

/** 渲染进程还活着时，主进程把一句人话推到界面上的通道 */
export const ERROR_NOTICE_CHANNEL = 'app:errorNotice'

/** Chromium 加载被中止（开发模式的热更新整页重载就会触发），不是故障 */
const ERR_ABORTED = -3

/**
 * Electron 给的原因码翻成「用户下一步该做什么」。这份映射单独拉出来是因为猜错的代价很具体：
 * oom 让人去重开，memory-eviction 其实是系统在腾地方，integrity-failure 是安装包本身不完整，
 * 三句话说成一句，人就照着错的那句做。取值按 node_modules/electron/electron.d.ts 里
 * RenderProcessGoneDetails 的联合类型列全，没列到的一律走兜底而不是当成没事。
 */
const RENDERER_GONE_MESSAGE: Record<string, string> = {
  crashed: '界面进程崩溃了。可以重新加载，但这次没导出的结果会丢',
  killed: '界面进程被系统结束了（内存紧张时系统会这么挑）。可以重新加载，正在跑的任务会中断',
  oom: '界面进程内存用完了。长文稿加上逐句音频最容易撞上，重新加载后建议先导出结果',
  'memory-eviction': '系统在回收内存时收回了界面进程。不是你操作的问题，重新加载即可',
  'abnormal-exit': '界面进程异常退出。可以重新加载，反复出现请把日志发给开发者',
  'launch-failed': '界面进程没能起来。请退出应用后重新打开',
  'integrity-failure': '安装包完整性校验没通过（文件可能被改过或下载不完整）。请重新下载安装包',
}

export interface NoticeOutcome {
  /** 给人看的一句话；null 表示这条本来就不是故障，不该打扰用户 */
  message: string | null
  /** 界面已经不在了，只有重载（或重启应用）才能继续用 */
  needsReload: boolean
}

/** 界面进程没了：reason 决定这句话怎么说 */
export function describeRendererGone(details: { reason?: unknown; exitCode?: unknown }): NoticeOutcome {
  const reason = typeof details.reason === 'string' ? details.reason : ''
  if (reason === 'clean-exit') return { message: null, needsReload: false }
  const exitCode = typeof details.exitCode === 'number' ? `（退出码 ${details.exitCode}）` : ''
  const known = RENDERER_GONE_MESSAGE[reason]
  return {
    message: known
      ? `${known}${exitCode ? ` ${exitCode}` : ''}`
      : `界面进程消失了${reason ? `（原因 ${reason}）` : ''}${exitCode}。请重新加载`,
    needsReload: true,
  }
}

/**
 * Electron 自己的子进程（GPU、音频、网络这些）。取值同样列不全，所以按「是不是好好退的」
 * 分：干净退出与正常回收不打扰用户，其余只报一句——这一层我们能做的只有让人知道。
 */
export function describeChildGone(details: { type?: unknown; reason?: unknown }): NoticeOutcome {
  const type = typeof details.type === 'string' ? details.type : '子进程'
  const reason = typeof details.reason === 'string' ? details.reason : ''
  if (reason === 'killed' || reason === 'clean-exit') return { message: null, needsReload: false }
  const named = reason ? `${type}（${reason}）` : type
  return { message: `应用的后台组件退出：${named}。功能可能受影响，请留意接下来的报错`, needsReload: false }
}

/**
 * 页面没能加载。开发模式的热重载会送一次 ERR_ABORTED，跟着报就成了每次改代码弹一条，
 * 所以只报真正加载不出来的那些——打包版少了 dist/index.html 就是这一条在说话。
 */
export function describeLoadFailure(errorCode: number, errorDescription: string): NoticeOutcome {
  if (errorCode === ERR_ABORTED) return { message: null, needsReload: false }
  return {
    message: `界面没能加载（${errorCode} ${errorDescription}）。如果这是安装后的第一次打开，安装包可能不完整`,
    needsReload: false,
  }
}

/** 推给界面的一句话；没有活的窗口就只留日志，不假装说过了 */
function notifyRenderer(getWindow: () => BrowserWindow | null, message: string): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(ERROR_NOTICE_CHANNEL, message)
}

/**
 * 系统对话框是「渲染进程已经不在了」时唯一还能说话的口子。
 * 只有 app 已就绪才谈得上弹；启动早期就炸了只剩日志，那条也够定位。
 * 返回按下的是第几个按钮（弹不出来时 -1），调用方据此决定要不要真去重载——
 * 按钮写着「重新加载」却不管人选什么都重载，等于替用户按了回车。
 */
function showDialog(message: string, buttons: string[]): number {
  if (!app.isReady()) return -1
  try {
    return dialog.showMessageBoxSync({
      type: 'error',
      title: 'Vv Transcribe',
      message: '应用遇到了意料之外的错误',
      detail: `${message}\n\n日志在「设置 → 运行日志 → 打开日志文件夹」，把 app.log 随邮件发给开发者能帮上忙。`,
      buttons,
      defaultId: 0,
      noLink: true,
    })
  } catch (err) {
    // 弹不出对话框不能再抛一次异常：那是拿兜底代码自己当崩溃源
    logger.warn(TAG, 'Error dialog could not be shown', err instanceof Error ? err.message : String(err))
    return -1
  }
}

/**
 * 界面进程没了之后由人点头重载。连着崩就别再给「重新加载」——
 * 每次都是白屏一下然后再来一次，不如让人去重启应用、把日志留下。
 */
const reloadTimes: number[] = []
const RELOAD_LIMIT = 2
const RELOAD_WINDOW_MS = 60_000

export function watchWindowGone(win: BrowserWindow): void {
  const contents = win.webContents

  contents.on('render-process-gone', (_event, details) => {
    const outcome = describeRendererGone(details)
    if (!outcome.message) {
      logger.info(TAG, 'Render process exited cleanly', { details })
      return
    }
    logger.errorSync(TAG, 'Render process gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    })
    const now = Date.now()
    while (reloadTimes.length && now - reloadTimes[0] > RELOAD_WINDOW_MS) reloadTimes.shift()
    const canReload = outcome.needsReload && reloadTimes.length < RELOAD_LIMIT
    if (canReload) {
      const pressed = showDialog(
        `${outcome.message}\n\n重新加载会丢掉这次还没导出的结果；已经重开过 ${reloadTimes.length} 次了，再往下还是白屏的话请退出应用重开。`,
        ['重新加载', '知道了'],
      )
      // 计数只在真的重载时 +1：用户选「知道了」不该占用后面那两次机会
      if (pressed === 0) {
        reloadTimes.push(now)
        contents.reload()
      }
      return
    }
    showDialog(
      outcome.needsReload
        ? `${outcome.message}\n\n这个问题在 ${RELOAD_WINDOW_MS / 1000} 秒内已经出现过，不再给重载的选项了：请退出应用后重新打开。`
        : outcome.message,
      ['知道了'],
    )
  })

  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    const outcome = describeLoadFailure(errorCode, errorDescription)
    if (!outcome.message) {
      logger.debug(TAG, 'Load aborted (dev hot reload or a superseded navigation)', { errorCode })
      return
    }
    logger.errorSync(TAG, 'Main frame failed to load', { errorCode, errorDescription, validatedURL })
    showDialog(outcome.message, ['知道了'])
  })
}

/**
 * 装主进程级别的兜底。installCrashWatch 要在任何别的初始化之前调用：
 * 它自己出事的可能性最低，而 app.whenReady() 里那几条链路恰恰是最需要有人在最后接一把的。
 */
export function installCrashWatch(getWindow: () => BrowserWindow | null): void {
  process.on('unhandledRejection', (reason) => {
    // 未处理的异步失败不结束进程：一处 .catch 漏了不代表整个应用的状态坏了，
    // 而 Node 的默认处置就是直接退出，把正在跑的转写和没导出的结果一起带走。
    const detail = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason)
    logger.error(TAG, 'Unhandled rejection (the app keeps running)', detail)
    notifyRenderer(
      getWindow,
      '应用后台有一步没跑完（已记进日志）。如果这正好发生在你刚才那个操作上，请确认结果对不对，必要时重试一次'
    )
  })

  process.on('uncaughtException', (err) => {
    // 同步抛上来的异常会把状态留在哪儿没人知道，所以不再报「一切正常」：说清楚、建议重启。
    // 但不替用户按下退出——界面上那份还没导出的结果是真的，扔不扔由人决定。
    // 退出走 app.quit()：那才会跑 before-quit 里的收尾（ASR/配音子进程、临时媒体），
    // 用户自己强制结束进程会把 8000/8010 端口的残尸留给下一次启动。
    logger.errorSync(
      TAG,
      'Uncaught exception in main process',
      err instanceof Error ? err.stack || err.message : String(err),
    )
    const pressed = showDialog(
      err instanceof Error && err.message ? err.message : '主进程里抛出了一个没有预期的异常。',
      ['知道了', '退出应用'],
    )
    if (pressed === 1) app.quit()
  })

  app.on('child-process-gone', (_event, details) => {
    const outcome = describeChildGone(details as { type?: unknown; reason?: unknown })
    if (!outcome.message) {
      logger.debug(TAG, 'Child process exited without incident', { details })
      return
    }
    logger.error(TAG, 'Child process gone', { details })
    notifyRenderer(getWindow, outcome.message)
  })
}
