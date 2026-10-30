/**
 * ASR 语音转写 IPC 处理器
 * 管理转写任务生命周期：创建任务 → 提取音频 → 调用 ASR 引擎 → 推送进度 → 返回结果
 * 支持通过 AbortController 取消任务，自动清理临时文件
 *
 * asr:start 那一段的 try/catch 留着不只是为了返回形状：它还要把临时目录清掉、把任务从
 * activeJobs 里摘出去，这些是「这次任务结束了」的记账，guard 那层不知道 jobId。
 * guard 收的是记账之前那几步（生成 jobId、拿到窗口引用）——它们原先裸在外面。
 */
import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { extractAudio, cleanupTemp } from '../services/audioProcessor'
import { dropMediaSessionCookies, releaseMediaSessionsExcept } from '../services/urlDownloader'
import { runTranscription } from '../services/asr/asrManager'
import { restartLocalEngine } from '../services/asrServiceManager'
import { getASRConfig } from '../services/settingsService'
import type { ASRModelInfo, ASRSegment, ASRStage } from '../services/asr/types'
import { logger } from '../services/logger'
import { failOkError, ipcHandle } from './guard'

const TAG = 'ASRJob'

/** 活跃的转写任务映射表，jobId → 任务状态 */
interface TranscriptionState {
  jobId: string
  signal: AbortController
  tempDir: string | null
}

const activeJobs = new Map<string, TranscriptionState>()

/**
 * 有没有转写正在跑。改本地档位需要重启引擎（HF_HUB_OFFLINE 只能在 spawn 时决定），
 * 而重启会截断正在推的 NDJSON 流，所以设置保存那边要先问一句。
 */
export function hasActiveTranscription(): boolean {
  return activeJobs.size > 0
}

export function registerASRHandlers() {
  ipcHandle(
    'asr:start',
    async (
      event,
      filePath: string,
      options?: { language?: string; mediaSessionId?: string }
    ) => {
      const jobId = randomUUID()
      const signal = new AbortController()

      activeJobs.set(jobId, { jobId, signal, tempDir: null })

      const win = BrowserWindow.fromWebContents(event.sender)

      /**
       * 链接转写的源文件躺在 urlDownloader 的会话目录里，那目录还装着浏览器 cookies。
       * 提取出 wav 之后 cookies 就没用了，立刻删；但媒体不能跟着一起删——播放器整场都要拿它回放
       * （一起删的后果：逐句回放在链路末尾变成一条「文件已被移动」的 toast）。
       * 上一份素材的媒体在开工时回收，本次这份留到下次开工或应用退出，强杀留下的由启动清扫兜底。
       */
      const dropCookies = async () => {
        if (options?.mediaSessionId) {
          await dropMediaSessionCookies(options.mediaSessionId).catch(() => {})
        }
      }

      const sendProgress = (progress: number, segment?: ASRSegment, stage?: ASRStage, model?: ASRModelInfo) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('asr:progress', { jobId, progress, segment, stage, model })
        }
      }

      try {
        logger.info(TAG, 'Start job', { jobId, file: basename(filePath), language: options?.language ?? 'zh' })
        sendProgress(0)
        // 界面一次只放一条转写：开工就把上一份素材的临时媒体回收掉，本次这份留着给播放器回放
        releaseMediaSessionsExcept(options?.mediaSessionId ?? null)

        const extractResult = await extractAudio(filePath)
        logger.info(TAG, 'Audio extracted', { jobId })
        await dropCookies()
        const state = activeJobs.get(jobId)
        if (state) state.tempDir = extractResult.tempDir

        sendProgress(5)

        const config = await getASRConfig()
        // 只报模式与「有没有 Key」这两个布尔：apiKey 本身和它的长度都不能进日志
        logger.info(TAG, 'Transcription config', { provider: config.provider, hasApiKey: !!config.apiKey })

        const result = await runTranscription(extractResult.wavPath, config, {
          language: options?.language ?? 'zh',
          onProgress: (p) => {
            const totalProgress = 5 + p.percent * 0.95
            sendProgress(totalProgress, p.segment, p.stage, p.model)
          },
          signal: signal.signal,
        })

        await cleanupTemp(extractResult.tempDir)
        activeJobs.delete(jobId)

        sendProgress(100)
        logger.info(TAG, 'Job completed', { jobId, provider: result.provider, segments: result.segments.length })

        return { jobId, success: true, segments: result.segments, provider: result.provider }
      } catch (err) {
        // 取消是用户按的，不是故障：canceled 标出来，读日志的人才不会把它当成一次转写失败找上门
        logger.error(TAG, 'Job failed', {
          jobId,
          message: err instanceof Error ? err.message || err.name : String(err),
          canceled: signal.signal.aborted,
        })
        // 提取阶段就失败、或中途被取消：cookies 一样要删，媒体留着（界面上的转写结果还在，
        // 这份媒体会在下次开工或应用退出时被回收，不会一直摊在 /tmp）
        await dropCookies()
        const state = activeJobs.get(jobId)
        if (state?.tempDir) {
          await cleanupTemp(state.tempDir).catch(() => {})
        }
        activeJobs.delete(jobId)

        const message = err instanceof Error ? err.message : '转写失败'
        // 用户主动取消时 signal.aborted 为真：回传 canceled 让渲染层退回初始态而不是弹「处理失败」
        const canceled = signal.signal.aborted
        return { jobId, success: false, canceled, error: canceled ? '转写已取消' : message }
      }
    },
    // 走到这里是任务记账之前的几步炸了（生成不出 jobId、拿不到窗口）：任务根本没开始，
    // 所以 jobId 给 null、canceled 给 false——界面据此弹那句 error，而不是退回「已取消」态
    (message) => ({ jobId: null, success: false, canceled: false, error: message })
  )

  ipcHandle(
    'asr:cancel',
    async (_event, jobId: string) => {
      const state = activeJobs.get(jobId)
      if (state) {
        state.signal.abort()
        if (state.tempDir) {
          await cleanupTemp(state.tempDir).catch(() => {})
        }
        activeJobs.delete(jobId)
      }
      return { ok: true, error: null }
    },
    // 这一条渲染层点完只看进度流，所以成功形状本来没内容；回一个 { ok, error } 是为了
    // 让失败形状与成功形状是同一个类型，而不是「成功 undefined、失败一个对象」。
    // 没找到 jobId 也算 ok：那说明任务已经跑完，不是这一步失败了。
    failOkError
  )

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
