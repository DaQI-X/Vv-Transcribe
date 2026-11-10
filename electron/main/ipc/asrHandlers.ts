/**
 * ASR 语音转写 IPC 处理器
 *
 * 这一层只剩三件事：把发起方那个窗口接成作业本体的进度 sink、把取消与重启两条通道对上服务、
 * 以及逐条声明「失败时回什么值」。整单转写的流程在 services/transcribeJob.ts——搬过去的理由是
 * #355 的门面要跑同一单作业，而它没有 event.sender 可问（#375）。
 *
 * asr:start 那一段的 try/catch 留在作业本体里，不只是为了返回形状：它还要把临时目录清掉、把任务从
 * activeJobs 里摘出去，这些是「这次任务结束了」的记账，guard 那层不知道 jobId。
 * guard 收的是记账开始之前的那几步（拿不到窗口引用、作业体在登记任务之前抛出），所以窗口还是在这一侧取。
 */
import { BrowserWindow } from 'electron'
import { restartLocalEngine } from '../services/asrServiceManager'
import { cancelTranscribeJob, hasActiveTranscription, startTranscribeJob } from '../services/transcribeJob'
import { failOkError, ipcHandle } from './guard'

export function registerASRHandlers() {
  ipcHandle(
    'asr:start',
    async (
      event,
      filePath: string,
      options?: { language?: string; mediaSessionId?: string; profileId?: string }
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      // 窗口会在跑到一半时被关掉，那时 send 就是往没了的窗口喊话，所以每一步重新问一次
      // isDestroyed，而不是缓存一个「取窗口那一刻还在」的结论。作业本身照常跑完——历史那一笔还是要记
      return startTranscribeJob(filePath, options, (progress) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('asr:progress', progress)
        }
      })
    },
    // 走到这里是任务账目建立之前的那几步炸了（拿不到窗口、作业体登记任务之前抛出）：任务根本没开始，
    // 所以 jobId 给 null、canceled 给 false——界面据此弹那句 error，而不是退回「已取消」态
    (message) => ({ jobId: null, success: false, canceled: false, error: message })
  )

  // 这一条渲染层点完只看进度流，所以成功形状本来没内容；回一个 { ok, error } 是为了
  // 让失败形状与成功形状是同一个类型，而不是「成功 undefined、失败一个对象」
  ipcHandle('asr:cancel', (_event, jobId: string) => cancelTranscribeJob(jobId), failOkError)

  /**
   * 应用内重启本地引擎：首启下载模型失败、引擎被外部杀掉这类「不必退出应用就能恢复」的情况。
   * 转写进行中直接拒绝——停引擎会截断正在推的 NDJSON 流，半截结果比报错更糟。
   * 最长可能等满 60 秒（首次要下载模型），渲染进程需要自己显示「重启中」。
   */
  ipcHandle(
    'asr:restartEngine',
    () => {
      if (hasActiveTranscription()) {
        return { ok: false, error: '转写正在进行中，重启会中断当前任务。请等它跑完，或先点取消' }
      }
      return restartLocalEngine()
    },
    failOkError
  )
}
