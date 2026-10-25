/**
 * ASR 语音转写 IPC 处理器
 * 管理转写任务生命周期：创建任务 → 提取音频 → 调用 ASR 引擎 → 推送进度 → 返回结果
 * 支持通过 AbortController 取消任务，自动清理临时文件
 */
import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { extractAudio, cleanupTemp } from '../services/audioProcessor'
import { runTranscription } from '../services/asr/asrManager'
import { restartLocalEngine } from '../services/asrServiceManager'
import { getASRConfig } from '../services/settingsService'
import type { ASRModelInfo, ASRSegment, ASRStage } from '../services/asr/types'

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
  ipcMain.handle(
    'asr:start',
    async (event, filePath: string, options?: { language?: string }) => {
      const jobId = randomUUID()
      const signal = new AbortController()

      activeJobs.set(jobId, { jobId, signal, tempDir: null })

      const win = BrowserWindow.fromWebContents(event.sender)

      const sendProgress = (progress: number, segment?: ASRSegment, stage?: ASRStage, model?: ASRModelInfo) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('asr:progress', { jobId, progress, segment, stage, model })
        }
      }

      try {
        console.log('[ASR] start job:', jobId, 'file:', basename(filePath))
        sendProgress(0)

        const extractResult = await extractAudio(filePath)
        console.log('[ASR] audio extracted for job:', jobId)
        const state = activeJobs.get(jobId)
        if (state) state.tempDir = extractResult.tempDir

        sendProgress(5)

        const config = await getASRConfig()
        console.log('[ASR] config:', { provider: config.provider, hasApiKey: !!config.apiKey })

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
        console.log('[ASR] job completed:', jobId, 'provider:', result.provider, 'segments:', result.segments.length)

        return { jobId, success: true, segments: result.segments, provider: result.provider }
      } catch (err) {
        console.error('[ASR] job failed:', jobId, err)
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
  )

  ipcMain.handle('asr:cancel', async (_event, jobId: string) => {
    const state = activeJobs.get(jobId)
    if (state) {
      state.signal.abort()
      if (state.tempDir) {
        await cleanupTemp(state.tempDir).catch(() => {})
      }
      activeJobs.delete(jobId)
    }
  })

  /**
   * 应用内重启本地引擎：首启下载模型失败、引擎被外部杀掉这类「不必退出应用就能恢复」的情况。
   * 转写进行中直接拒绝——停引擎会截断正在推的 NDJSON 流，半截结果比报错更糟。
   * 最长可能等满 60 秒（首次要下载模型），渲染进程需要自己显示「重启中」。
   */
  ipcMain.handle('asr:restartEngine', async () => {
    if (hasActiveTranscription()) {
      return { ok: false, error: '转写正在进行中，重启会中断当前任务。请等它跑完，或先点取消' }
    }
    return restartLocalEngine()
  })
}
