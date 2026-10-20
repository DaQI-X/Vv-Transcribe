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
import { getASRConfig } from '../services/settingsService'
import type { ASRSegment } from '../services/asr/types'

/** 活跃的转写任务映射表，jobId → 任务状态 */
interface TranscriptionState {
  jobId: string
  signal: AbortController
  tempDir: string | null
}

const activeJobs = new Map<string, TranscriptionState>()

export function registerASRHandlers() {
  ipcMain.handle(
    'asr:start',
    async (event, filePath: string, options?: { language?: string }) => {
      const jobId = randomUUID()
      const signal = new AbortController()

      activeJobs.set(jobId, { jobId, signal, tempDir: null })

      const win = BrowserWindow.fromWebContents(event.sender)

      const sendProgress = (progress: number, segment?: ASRSegment) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('asr:progress', { jobId, progress, segment })
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
            sendProgress(totalProgress, p.segment)
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
}
