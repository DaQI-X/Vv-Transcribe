/**
 * 配音（TTS）IPC 处理器
 * 批量合成之前先让用户花一次钱听一句：端点、配音模型、音色三样里任何一样不对，
 * 都应该在这一步暴露，而不是等整条稿子跑到中途。
 * 段落时间轴只由渲染层持有，主进程按 id 记账（jobId → 临时目录 → 成品轨），
 * 界面报回来的路径一律不用。
 * 统一口径：不跨 IPC 抛错，失败一律走 `{ error }` 让渲染层弹 toast。
 */
import { ipcMain, dialog, BrowserWindow } from 'electron'
import { basename } from 'node:path'
import { copyFile, stat } from 'node:fs/promises'
import { getTTSConfig } from '../services/settingsService'
import type { TTSBatchResult, TTSProgress, TTSSegmentInput, VoiceTrack } from '../services/ttsService'
import {
  cancelTTSSynthesis,
  composeVoiceTrack,
  getVoiceTrack,
  previewSpeech,
  releaseBatchById,
  releasePreview,
  synthesizeSegments,
} from '../services/ttsService'
import { logger } from '../services/logger'

export interface TTSPreviewResult {
  clip: { filePath: string; bytes: number; duration: number } | null
  error: string | null
}

/** 整批跑完的返回值：track 为 null 时（一段都没成/被取消在拼接前）界面只有失败清单可看 */
export interface TTSSynthesizeResult {
  jobId: string | null
  track: VoiceTrack | null
  clipCount: number
  failures: Array<{ segmentId: string; index: number; error: string }>
  skipped: string[]
  canceled: boolean
  /** 连续失败熔断的原因，跟「用户自己点了取消」要分开报 */
  abortedReason: string | null
  error: string | null
}

/** 进度推送通道名，preload 与渲染层按这个订阅 */
const PROGRESS_CHANNEL = 'tts:progress'

/** 时间轴字段只能由渲染层给（主进程没有第二份时间轴），这里只做「是不是个数」的最低限度收口 */
function toSegments(input: unknown): TTSSegmentInput[] {
  if (!Array.isArray(input)) return []
  return input
    .map((item) => {
      const raw = item as Record<string, unknown>
      const startTime = Number(raw.startTime)
      const endTime = Number(raw.endTime)
      return {
        id: String(raw.id ?? ''),
        startTime: Number.isFinite(startTime) ? startTime : 0,
        endTime: Number.isFinite(endTime) ? endTime : 0,
        text: String(raw.text ?? ''),
      }
    })
    .filter((segment) => segment.id !== '')
}

export function registerTTSHandlers() {
  ipcMain.handle('tts:preview', async (_event, text: string): Promise<TTSPreviewResult> => {
    try {
      const clip = await previewSpeech(String(text ?? ''), await getTTSConfig())
      return { clip, error: null }
    } catch (err) {
      const message = err instanceof Error ? err.message : '配音试听失败'
      // Key 与接口地址都不落日志，只留失败原因：日志文件是会被用户发回来的
      logger.error('TTS', 'preview failed', { message })
      return { clip: null, error: message }
    }
  })

  // 配音弹窗关闭时回收试听产物；漏掉也不会永久泄漏，临时目录带 transcribe- 前缀，
  // 启动清扫（24 小时）能兜住，但当场能删干净的事不该留给下次启动
  ipcMain.handle('tts:release', async () => {
    await releasePreview()
    return { ok: true }
  })

  /**
   * 逐段合成 + 拼成一条轨。耗时是分钟级（每段一次网络请求，串行），
   * 所以真实段号走 PROGRESS_CHANNEL 推回来，不包一层渲染层就只剩一个转圈的按钮。
   */
  ipcMain.handle(
    'tts:synthesize',
    async (event, segments: unknown): Promise<TTSSynthesizeResult> => {
      const queue = toSegments(segments)
      const empty: TTSSynthesizeResult = {
        jobId: null,
        track: null,
        clipCount: 0,
        failures: [],
        skipped: [],
        canceled: false,
        abortedReason: null,
        error: null,
      }
      if (queue.length === 0) return { ...empty, error: '没有可以配音的段落' }

      const win = BrowserWindow.fromWebContents(event.sender)
      const sendProgress = (progress: TTSProgress) => {
        if (win && !win.isDestroyed()) win.webContents.send(PROGRESS_CHANNEL, progress)
      }

      // 合成的账目单独算一份：拼接是本地 ffmpeg，它失败不代表前面几十段没成，
      // 把 clipCount/failures/skipped 抹成 0 会让界面报「一段都没成」，用户白等了一轮。
      let jobId: string
      let result: TTSBatchResult
      try {
        const batch = await synthesizeSegments(queue, await getTTSConfig(), sendProgress)
        jobId = batch.job.id
        result = batch.result
      } catch (err) {
        const message = err instanceof Error ? err.message : '配音合成失败'
        logger.error('TTS', 'batch failed', { message })
        return { ...empty, error: message }
      }

      if (result.clips.length === 0) {
        await releaseBatchById(jobId)
        return {
          ...empty,
          failures: result.failures,
          skipped: result.skipped,
          canceled: result.canceled,
          abortedReason: result.abortedReason,
          error: result.abortedReason || '一段都没合成成功，没有可以拼接的音频',
        }
      }

      try {
        // 拼接是本地 ffmpeg，不花钱但可能要几十秒，先报一句免得看着像卡死
        sendProgress({ jobId, stage: 'assembling', index: queue.length, total: queue.length })
        const track = await composeVoiceTrack(jobId, result.clips)
        sendProgress({ jobId, stage: 'done', index: queue.length, total: queue.length })

        return {
          jobId,
          track,
          clipCount: result.clips.length,
          failures: result.failures,
          skipped: result.skipped,
          canceled: result.canceled,
          abortedReason: result.abortedReason,
          error: null,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : '配音轨拼接失败'
        logger.error('TTS', 'assemble failed', { message })
        await releaseBatchById(jobId)
        return {
          jobId: null,
          track: null,
          clipCount: result.clips.length,
          failures: result.failures,
          skipped: result.skipped,
          canceled: result.canceled,
          abortedReason: result.abortedReason,
          error: message,
        }
      }
    }
  )

  /**
   * 取消：正在飞出去的那一次请求不打断（钱已经花了），从下一段起不再调用。
   * 已成功的片段照常拼，所以取消不等于这批产物作废。
   */
  ipcMain.handle('tts:cancel', async (_event, jobId: string) => {
    const success = cancelTTSSynthesis(String(jobId ?? ''))
    return { success }
  })

  /** 成品另存为用户选的位置：产物本来就在临时目录里，走「先下满再弹保存框」的既有口径 */
  ipcMain.handle('tts:saveTrack', async (_event, jobId: string) => {
    const track = getVoiceTrack(String(jobId ?? ''))
    if (!track) return { success: false, canceled: false, error: '配音轨已经不在了，请重新合成' }

    const result = await dialog.showSaveDialog({
      defaultPath: 'voice-track.mp3',
      filters: [{ name: 'MP3 音频', extensions: ['mp3'] }],
    })
    if (result.canceled || !result.filePath) {
      logger.userAction('TTS save cancelled')
      return { success: false, canceled: true, error: null }
    }
    try {
      await copyFile(track.filePath, result.filePath)
      const saved = await stat(result.filePath)
      logger.userAction('TTS voice track saved', { name: basename(result.filePath), sizeBytes: saved.size })
      return { success: true, canceled: false, name: basename(result.filePath), error: null }
    } catch (err) {
      const message = err instanceof Error ? err.message : '写入文件失败'
      logger.error('TTS', 'save track failed', { message })
      return { success: false, canceled: false, error: message }
    }
  })

  /** 用户没另存就关掉弹窗时回收整批中间产物 */
  ipcMain.handle('tts:releaseBatch', async (_event, jobId: string) => {
    await releaseBatchById(String(jobId ?? ''))
    return { ok: true }
  })
}
