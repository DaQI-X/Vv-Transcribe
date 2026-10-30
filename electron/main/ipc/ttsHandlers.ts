/**
 * 配音（TTS）IPC 处理器
 * 批量合成之前先让用户花一次钱听一句：端点、配音模型、音色三样里任何一样不对，
 * 都应该在这一步暴露，而不是等整条稿子跑到中途。
 * 段落时间轴只由渲染层持有，主进程按 id 记账（jobId → 临时目录 → 成品轨），
 * 界面报回来的路径一律不用。
 * 音色、倍速、模型与本地引擎走「单次调用参数」，不写回 settings.json：工作台上的临时试错不该变成用户的长期默认值。
 * 本地配音那两档另外开了 tts:localStatus / tts:localRestart：引擎是懒启动的，界面得能在「不花资源」
 * 的前提下知道组件在不在场，也得能在启动失败后有个不用退出重开的出路。
 * 统一口径由 guard.ts 落成机制：每条通道在这里声明自己失败回什么形状，函数体里不再各写一份 try/catch。
 */
import { dialog, BrowserWindow } from 'electron'
import { basename } from 'node:path'
import { copyFile, stat } from 'node:fs/promises'
import { getTTSConfig, type TtsEngineMode } from '../services/settingsService'
import type { TTSConfig, TTSProgress, TTSSegmentInput, VoiceTrack } from '../services/ttsService'
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
import { engineBinaryInManifest } from '../services/componentService'
import { failOkError, failSuccessError, ipcHandle } from './guard'

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

/**
 * 一整批都没跑成时的账目。界面对这几个字段有既有的读法（clipCount:0 报「一段都没成」），
 * 所以失败值必须凑齐同一套形状，不能只回一句 error。
 */
function emptySynthesizeResult(error: string | null): TTSSynthesizeResult {
  return {
    jobId: null,
    track: null,
    clipCount: 0,
    failures: [],
    skipped: [],
    canceled: false,
    abortedReason: null,
    error,
  }
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
  /**
   * 引擎二进制在本版清单里有没有这一条（会话缓存，不联网）。false＝这一版压根没有它的下载包，
   * 界面就不能说「去按需组件下载它」；null＝还没读过清单，只能把人导向检查清单的地方。
   */
  binaryInManifest: boolean | null
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
 *   空串同样按「没覆盖」处理，和上面 model/voice 一个写法：配音页的引擎下拉没动过时存的是空串，
 *   用 `??` 就只挡 null/undefined，空串会一路走到白名单外、落回 VITS 默认档，
 *   于是界面显示 Kokoro、实际合成用的是另一档模型（2026-10-29 本机试听时踩实过）。
 * 档（云端/本地）不在这里覆盖：它决定的是「这次要不要花钱、要不要拉起本机进程」，
 * 属于用户已经保存的长期选择，工作台只改这一档里面的参数。
 */
export function withOverrides(base: TTSConfig, raw: unknown): TTSConfig {
  const input = (raw ?? {}) as VoiceCallOptions
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  const voice = typeof input.voice === 'string' ? input.voice.trim() : ''
  const localEngine = typeof input.localEngine === 'string' ? input.localEngine.trim() : ''
  const speed = Number(input.speed)
  return {
    ...base,
    model: model || base.model,
    voice: voice || base.voice,
    localEngine: normalizeLocalTtsEngine(localEngine || base.localEngine),
    speed: Number.isFinite(speed) && speed > 0 ? Math.min(4, Math.max(0.25, speed)) : 1,
  }
}

/** 时间轴字段只能由渲染层给（主进程没有第二份时间轴），这里只做「是不是个数」的最低限度收口 */
export function toSegments(input: unknown): TTSSegmentInput[] {
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
  // 端点、模型、音色三样里任何一样不对，失败原因都落进 error 那一句给界面弹出来。
  // 日志由 guard 落，只带通道名和 message——Key 与接口地址不进日志，因为入参从来就不记。
  ipcHandle(
    'tts:preview',
    async (_event, text: string, opts?: unknown): Promise<TTSPreviewResult> => ({
      clip: await previewSpeech(String(text ?? ''), withOverrides(await getTTSConfig(), opts)),
      error: null,
    }),
    (message) => ({ clip: null, error: message })
  )

  // 配音弹窗关闭时回收试听产物；漏掉也不会永久泄漏，临时目录带 transcribe- 前缀，
  // 启动清扫（24 小时）能兜住，但当场能删干净的事不该留给下次启动
  ipcHandle(
    'tts:release',
    async () => {
      await releasePreview()
      return { ok: true }
    },
    failOkError
  )

  /**
   * 逐段合成 + 拼成一条轨。耗时是分钟级（每段一次网络请求，串行），
   * 所以真实段号走 PROGRESS_CHANNEL 推回来，不包一层渲染层就只剩一个转圈的按钮。
   */
  ipcHandle(
    'tts:synthesize',
    async (event, segments: unknown, opts?: unknown): Promise<TTSSynthesizeResult> => {
      const queue = toSegments(segments)
      if (queue.length === 0) return emptySynthesizeResult('没有可以配音的段落')

      const win = BrowserWindow.fromWebContents(event.sender)
      const sendProgress = (progress: TTSProgress) => {
        if (win && !win.isDestroyed()) win.webContents.send(PROGRESS_CHANNEL, progress)
      }

      // 逐段合成的失败由 guard 收成一份空账目 + error；下面拼轨那一步不能交给它，
      // 因为拼接是本地 ffmpeg，它失败不代表前面几十段没成，把 clipCount/failures/skipped
      // 抹成 0 会让界面报「一段都没成」，用户白等了一轮。
      const batch = await synthesizeSegments(queue, withOverrides(await getTTSConfig(), opts), sendProgress)
      const jobId = batch.job.id
      const result = batch.result

      if (result.clips.length === 0) {
        await releaseBatchById(jobId)
        return {
          ...emptySynthesizeResult(result.abortedReason || '一段都没合成成功，没有可以拼接的音频'),
          failures: result.failures,
          skipped: result.skipped,
          canceled: result.canceled,
          abortedReason: result.abortedReason,
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
    },
    (message) => emptySynthesizeResult(message)
  )

  /**
   * 取消：正在飞出去的那一次请求不打断（钱已经花了），从下一段起不再调用。
   * 已成功的片段照常拼，所以取消不等于这批产物作废。
   * 逐段循环已经跑完时返回 'late' 而不是 success:true：那时只剩本地 ffmpeg 在拼轨，
   * 没有可拦的东西，界面据此把取消入口收起来并说清楚，而不是装作按下了。
   */
  ipcHandle(
    'tts:cancel',
    async (_event, jobId: string) => {
      const reason = cancelTTSSynthesis(String(jobId ?? ''))
      return { success: reason === 'stopped', reason, error: null }
    },
    // reason 这里给 'gone' 只是要让界面那三条分支有一处可落；真正的话由 error 那一槽说，
    // 界面优先读它——不然「取消没落进去」会被说成「这批任务已经不在了」
    (message) => ({ success: false, reason: 'gone' as const, error: message })
  )

  /** 成品另存为用户选的位置：产物本来就在临时目录里，走「先下满再弹保存框」的既有口径 */
  ipcHandle(
    'tts:saveTrack',
    async (_event, jobId: string) => {
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
      await copyFile(track.filePath, result.filePath)
      const saved = await stat(result.filePath)
      logger.userAction('TTS voice track saved', { name: basename(result.filePath), sizeBytes: saved.size })
      return { success: true, canceled: false, name: basename(result.filePath), error: null }
    },
    // 失败时不报 canceled：中间产物还在临时目录里，界面上的「另存」按钮还能再点一次
    failSuccessError
  )

  /** 用户没另存就关掉弹窗时回收整批中间产物 */
  ipcHandle(
    'tts:releaseBatch',
    async (_event, jobId: string) => {
      await releaseBatchById(String(jobId ?? ''))
      return { ok: true }
    },
    failOkError
  )

  /**
   * 本地配音引擎的状态快照（只读，不会因此拉起引擎）。
   * 引擎 id 由界面传（可能是设置表单里还没保存的那个选择），但必须先过白名单：
   * 这个值会被拼进模型目录名，不能把渲染层传来的字符串直接当路径用。
   * 空串同样按「没指定」处理，跟 tts:preview/synthesize 一个口径——不然设置页还没选过时
   * 这里会回一份 VITS 的状态，界面却按保存的那一档显示。
   * 「检查状态」不主动 ensure 是刻意的——本地档懒启动，用户只是想知道组件下没下好，
   * 不该因为打开设置页就吃掉一次 8 秒解包和几百 MB 内存。
   */
  ipcHandle(
    'tts:localStatus',
    async (_event, requestedEngine?: unknown): Promise<LocalTtsStatusResult> => {
      const config = await getTTSConfig()
      const requested = typeof requestedEngine === 'string' ? requestedEngine.trim() : ''
      const engine = normalizeLocalTtsEngine(requested || config.localEngine)
      const detail = await getLocalTtsDetail(engine)
      return {
        ...detail,
        mode: config.engine,
        configuredEngine: config.localEngine,
        requestedEngine: engine,
        binaryInManifest: engineBinaryInManifest(),
      }
    },
    // 这一条刻意不回一份「什么都缺」的快照：binaryPresent/modelPresent 填 false，
    // 设置页就会照着说「引擎二进制没下载」，而真实情况是「读不出来」——那是句谎话。
    // 回 null 正好落回界面本来就有的第三种状态（「还没读到本机的组件状态」），
    // 三处调用点（设置页、配音页、配音前置校验）都已按 null 分支写过，无需改文案。
    () => null
  )

  /**
   * 手动重启本地配音引擎（换引擎失败、端口被上一代占住、启动失败后的重试都走这一条）。
   * 引擎只取已保存的配置，不接受界面传值：设置页「点保存才生效」这条口径不能在这儿破例，
   * 否则没保存的选择会真的把后台切成那个引擎。
   */
  ipcHandle(
    'tts:localRestart',
    async (): Promise<{ ok: boolean; error: string | null }> => {
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
    },
    failOkError
  )

  /**
   * 停掉本地配音引擎，不重开（下一次配音由 ensure 懒启动，界面不用管）。
   * 存在的理由很具体：#230 的组件下载/删除要动那几个文件，而引擎配音完不会自己退——
   * 没有这个入口的话，用户在同一个会话里就永远动不了组件，只能退出应用重开。
   * 一批正在逐段合成时拒绝停：那会让剩下的段落全部失败，而用户点「停止」时未必想到这一点。
   */
  ipcHandle(
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
    },
    // stopped 给 false 而不是 true：动文件的入口得知道「引擎可能还在」，宁可让人再点一次
    (message) => ({ ok: false, stopped: false, error: message })
  )
}
