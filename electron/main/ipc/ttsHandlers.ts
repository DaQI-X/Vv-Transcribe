/**
 * 配音（TTS）IPC 处理器
 * 批量合成之前先让用户花一次钱听一句：端点、配音模型、音色三样里任何一样不对，
 * 都应该在这一步暴露，而不是等整条稿子跑到中途。
 * 段落时间轴只由渲染层持有，主进程按 id 记账（jobId → 临时目录 → 成品轨），
 * 界面报回来的路径一律不用。
 * 音色、倍速、模型与本地引擎走「单次调用参数」，不写回 settings.json：工作台上的临时试错不该变成用户的长期默认值。
 * 本地配音那两档另外开了 tts:localStatus / tts:localRestart：引擎是懒启动的，界面得能在「不花资源」
 * 的前提下知道组件在不在场，也得能在启动失败后有个不用退出重开的出路。
 * 统一口径：不跨 IPC 抛错，失败一律走 `{ error }` 让渲染层弹 toast。
 */
import { ipcMain, dialog, BrowserWindow } from 'electron'
import { basename } from 'node:path'
import { copyFile, stat } from 'node:fs/promises'
import { getTTSConfig, type TtsEngineMode } from '../services/settingsService'
import type { TTSBatchResult, TTSConfig, TTSProgress, TTSSegmentInput, VoiceTrack } from '../services/ttsService'
import {
  cancelTTSSynthesis,
  composeVoiceTrack,
  getVoiceTrack,
  hasActiveTTSSynthesis,
  previewSpeech,
  releaseBatchById,
  releasePreview,
  synthesizeSegments,
} from '../services/ttsService'
import {
  getLocalTtsDetail,
  isLocalTtsEngineRunning,
  normalizeLocalTtsEngine,
  restartLocalTtsEngine,
  stopLocalTtsEngine,
  type LocalTtsEngineId,
  type LocalTtsDetail,
} from '../services/localTtsEngine'
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

/**
 * 本地配音引擎的状态快照：设置页的「检查引擎状态」和配音页的下载引导都读这一份。
 * configuredEngine 是已保存设置里的那一档，requestedEngine 是界面当前问的那个（用户在表单里
 * 还没点保存时，两者会不一样——组件在不在场要按界面正在显示的那个引擎判，否则「切换引擎」的
 * 预览永远读的是旧引擎的下载状态）。
 */
export interface LocalTtsStatusResult extends LocalTtsDetail {
  mode: TtsEngineMode
  configuredEngine: LocalTtsEngineId
  requestedEngine: LocalTtsEngineId
}

/**
 * 单次调用可覆盖的参数：配音页让用户在开跑前挑模型、挑音色、定倍速，但不写回设置——
 * 「设置改动要点保存才生效」这条口径不该被工作台绕过。
 */
interface VoiceCallOptions {
  /** 云端档的配音模型 id；本地档没有这个概念，传了也不参与取值 */
  model?: string
  voice?: string
  /** 本地档用哪个引擎（VITS / Kokoro）。只认白名单，见下面 withOverrides */
  localEngine?: string
  speed?: number
}

/**
 * 渲染层来的值一律当外部输入收口：
 * - 模型与音色空串回落设置里那个（空值会打到 ttsConfigProblem 之前，不如按「没覆盖」处理）；
 * - 倍速夹进 OpenAI 标准的 0.25–4.0，NaN/字符串/越界都退回 1；
 * - 引擎 id 必须过 normalizeLocalTtsEngine 的白名单——它会被拼进模型目录名和 sidecar 的
 *   engine 字段，不能把渲染层传来的字符串直接当值用（这条 IPC 是界面唯一能指定「跑哪档模型」的口子）。
 * 档（云端/本地）不在这里覆盖：它决定的是「这次要不要花钱、要不要拉起本机进程」，
 * 属于用户已经保存的长期选择，工作台只改这一档里面的参数。
 */
function withOverrides(base: TTSConfig, raw: unknown): TTSConfig {
  const input = (raw ?? {}) as VoiceCallOptions
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  const voice = typeof input.voice === 'string' ? input.voice.trim() : ''
  const speed = Number(input.speed)
  return {
    ...base,
    model: model || base.model,
    voice: voice || base.voice,
    localEngine: normalizeLocalTtsEngine(input.localEngine ?? base.localEngine),
    speed: Number.isFinite(speed) && speed > 0 ? Math.min(4, Math.max(0.25, speed)) : 1,
  }
}

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
  ipcMain.handle('tts:preview', async (_event, text: string, opts?: unknown): Promise<TTSPreviewResult> => {
    try {
      const clip = await previewSpeech(String(text ?? ''), withOverrides(await getTTSConfig(), opts))
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
    async (event, segments: unknown, opts?: unknown): Promise<TTSSynthesizeResult> => {
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
        const batch = await synthesizeSegments(queue, withOverrides(await getTTSConfig(), opts), sendProgress)
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
   * 逐段循环已经跑完时返回 'late' 而不是 success:true：那时只剩本地 ffmpeg 在拼轨，
   * 没有可拦的东西，界面据此把取消入口收起来并说清楚，而不是装作按下了。
   */
  ipcMain.handle('tts:cancel', async (_event, jobId: string) => {
    const reason = cancelTTSSynthesis(String(jobId ?? ''))
    return { success: reason === 'stopped', reason }
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

  /**
   * 本地配音引擎的状态快照（只读，不会因此拉起引擎）。
   * 引擎 id 由界面传（可能是设置表单里还没保存的那个选择），但必须先过白名单：
   * 这个值会被拼进模型目录名，不能把渲染层传来的字符串直接当路径用。
   * 「检查状态」不主动 ensure 是刻意的——本地档懒启动，用户只是想知道组件下没下好，
   * 不该因为打开设置页就吃掉一次 8 秒解包和几百 MB 内存。
   */
  ipcMain.handle(
    'tts:localStatus',
    async (_event, requestedEngine?: unknown): Promise<LocalTtsStatusResult> => {
      const config = await getTTSConfig()
      const engine = normalizeLocalTtsEngine(requestedEngine ?? config.localEngine)
      const detail = await getLocalTtsDetail(engine)
      return { ...detail, mode: config.engine, configuredEngine: config.localEngine, requestedEngine: engine }
    }
  )

  /**
   * 手动重启本地配音引擎（换引擎失败、端口被上一代占住、启动失败后的重试都走这一条）。
   * 引擎只取已保存的配置，不接受界面传值：设置页「点保存才生效」这条口径不能在这儿破例，
   * 否则没保存的选择会真的把后台切成那个引擎。
   */
  ipcMain.handle('tts:localRestart', async (): Promise<{ ok: boolean; error: string | null }> => {
    const config = await getTTSConfig()
    if (config.engine !== 'local') {
      return { ok: false, error: '当前配音引擎是「云端接口」，本地配音引擎没在使用中，无需启动' }
    }
    const result = await restartLocalTtsEngine(config.localEngine)
    logger.info('TTS', 'local engine restart requested', {
      engine: config.localEngine,
      ok: result.ok,
      error: result.error ?? undefined,
    })
    return result
  })

  /**
   * 停掉本地配音引擎，不重开（下一次配音由 ensure 懒启动，界面不用管）。
   * 存在的理由很具体：#230 的组件下载/删除要动那几个文件，而引擎配音完不会自己退——
   * 没有这个入口的话，用户在同一个会话里就永远动不了组件，只能退出应用重开。
   * 一批正在逐段合成时拒绝停：那会让剩下的段落全部失败，而用户点「停止」时未必想到这一点。
   */
  ipcMain.handle(
    'tts:localStop',
    async (): Promise<{ ok: boolean; stopped: boolean; error: string | null }> => {
      if (hasActiveTTSSynthesis()) {
        return { ok: false, stopped: false, error: '有一批配音正在逐段合成，等它跑完（或先取消这一批）再停引擎' }
      }
      if (!isLocalTtsEngineRunning()) return { ok: true, stopped: false, error: null }
      await stopLocalTtsEngine()
      const stillRunning = isLocalTtsEngineRunning()
      logger.info('TTS', 'local engine stopped on request', { stillRunning })
      return { ok: !stillRunning, stopped: !stillRunning, error: null }
    }
  )
}
