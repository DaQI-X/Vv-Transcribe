/**
 * 配音（TTS）IPC 处理器
 * 批量合成之前先让用户花一次钱听一句：端点、配音模型、音色三样里任何一样不对，
 * 都应该在这一步暴露，而不是等整条稿子跑到中途。
 * 段落时间轴只由渲染层持有，主进程按 id 记账（jobId → 临时目录 → 成品轨），
 * 界面报回来的路径一律不用。
 * 音色、倍速与本地引擎走「单次调用参数」，不写回 settings.json：工作台上的临时试错不该变成用户的长期默认值。
 * 云端配音模型不在这一份里（1.1.0 起跟着「配音方案」整套走），界面只能换方案，不能换这一项。
 * 本地配音那两档另外开了 tts:localStatus / tts:localRestart：引擎是懒启动的，界面得能在「不花资源」
 * 的前提下知道组件在不在场，也得能在启动失败后有个不用退出重开的出路。
 * 统一口径由 guard.ts 落成机制：每条通道在这里声明自己失败回什么形状，函数体里不再各写一份 try/catch。
 */
import { dialog, BrowserWindow } from 'electron'
import { basename } from 'node:path'
import { copyFile, stat } from 'node:fs/promises'
import { getTTSConfig, normalizeApiBase, resolveProfileId, type TtsEngineMode } from '../services/settingsService'
import type { TTSConfig, TTSProgress, TTSSegmentInput, VoiceTrack } from '../services/ttsService'
import {
  cancelTTSSynthesis,
  cloneVoice,
  composeVoiceTrack,
  getVoiceTrack,
  hasActiveTTSSynthesis,
  listVendorVoices,
  previewSpeech,
  releaseBatchById,
  releasePreview,
  synthesizeSegments,
} from '../services/ttsService'
import {
  ttsVendorCloneSpec,
  ttsVendorClonesVoices,
  ttsVendorListsVoices,
  voiceCloneEndpoints,
  TTS_VENDOR_NAMES,
  type VendorVoice,
} from '../services/ttsVendor'
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
import { addHistoryRecord } from '../services/historyService'
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
 * 音色名单那一条（`tts:voiceList`）的返回值。
 *
 * 三个状态刻意压成两个字段，因为界面对它们的处理只有两种：有候选就挂上去，没候选就照旧手输。
 * - `ok: true` ＝ 这一家有名单接口、这一次也取到了；
 * - `ok: false, error: null` ＝ 这一家（或本地档）压根没有可问的地方，不值得为它说一句话；
 * - `ok: false, error: '…'` ＝ 问了但没问到，界面把这句原因换成一行灰字。
 */
export interface VoiceListResult {
  ok: boolean
  voices: VendorVoice[]
  error: string | null
}

/**
 * 声音复刻那一条（`tts:voiceClone`）的返回值。
 *
 * `voiceId` 是这一趟之后要填进「音色」那一格的东西：MiniMax 那一家的它就是用户刚起的名字，
 * 百炼的是对方拼出来的（形如 `cosyvoice-v2-myprefix-xxxxxx`）——所以哪怕用户记得自己填了什么，
 * 也必须从回执里拿，不能拿界面上那一格的值当结论。失败时给空串，界面只看 `ok` 与 `error`。
 */
export interface VoiceCloneIpcResult {
  ok: boolean
  voiceId: string
  error: string | null
}

/**
 * 单次调用可覆盖的参数：配音页让用户在开跑前挑本地模型、挑音色、定倍速，但不写回设置——
 * 「设置改动要点保存才生效」这条口径不该被工作台绕过。
 * 云端配音模型不在这里：1.1.0 起它跟着「配音方案」走，界面要换整套，不给换单项。
 */
interface VoiceCallOptions {
  voice?: string
  /** 本地档用哪个引擎（VITS / Kokoro）。只认白名单，见下面 withOverrides */
  localEngine?: string
  speed?: number
  /**
   * 「这次用哪套配音配置」：#222 第②步接上的方案 id。
   * 空或指不到人时走该档当前默认方案——配音页那条方案下拉做的是「设为当前使用」（落盘后重读），
   * 所以它一直不走这一格；留给的是「不改长期设置、只这一次用另一套」的入口。
   * 它是查表用的键，不会被拼进任何路径或目录名（引擎 id 那种白名单校验对它不适用）。
   */
  profileId?: string
  /**
   * 这一批稿子在历史记录里叫什么。主进程收到的只有段落正文，它分不清这是手打的还是
   * 某份素材转出来的（#247 记的是元信息，正文不落盘，所以名字只能由界面报上来）。
   * 它是纯展示字段：不进路径、不进目录名，也不参与任何取值。
   */
  sourceName?: string
}

/** 界面传来的一个字符串参数：非字符串与空串都收成空串，交给调用点按「没指定」处理 */
function trimArg(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * 从界面传来的那格可覆盖参数里取方案 id。收口写法与 withOverrides 一致：非字符串与空串都按
 * 「没指定」处理——「没指定」在 settingsService 里就是「用该档当前默认方案」，
 * 而把 undefined 传下去和把一串乱码传下去结果相同，不必再多一层判断。
 */
function profileIdOf(raw: unknown): string | undefined {
  const value = (raw ?? {}) as { profileId?: unknown }
  return trimArg(value.profileId) || undefined
}

/** 历史记录那一行的名字：界面没报就叫「未命名」，不替用户猜一份稿子从哪来 */
function sourceNameOf(raw: unknown): string {
  const value = (raw ?? {}) as { sourceName?: unknown }
  // 渲染层来的值当外部输入收口：截个长度就行，它只上界面，不进路径（留住的产物按原件名落盘）
  return trimArg(value.sourceName).slice(0, 120) || '未命名'
}

/**
 * 渲染层来的值一律当外部输入收口：
 * - 音色空串回落设置里那个（空值会打到 ttsConfigProblem 之前，不如按「没覆盖」处理）；
 * - 倍速夹进 OpenAI 标准的 0.25–4.0，NaN/字符串/越界都退回 1；
 * - 引擎 id 必须过 normalizeLocalTtsEngine 的白名单——它会被拼进模型目录名和 sidecar 的
 *   engine 字段，不能把渲染层传来的字符串直接当值用（这条 IPC 是界面唯一能指定「跑哪档模型」的口子）。
 *   空串同样按「没覆盖」处理，和上面 voice 一个写法：配音页的引擎下拉没动过时存的是空串，
 *   用 `??` 就只挡 null/undefined，空串会一路走到白名单外、落回 VITS 默认档，
 *   于是界面显示 Kokoro、实际合成用的是另一档模型（2026-10-29 本机试听时踩实过）。
 * 档（云端/本地）不在这里覆盖：它决定的是「这次要不要花钱、要不要拉起本机进程」，
 * 属于用户已经保存的长期选择，工作台只改这一档里面的参数。
 */
export function withOverrides(base: TTSConfig, raw: unknown): TTSConfig {
  const input = (raw ?? {}) as VoiceCallOptions
  const voice = typeof input.voice === 'string' ? input.voice.trim() : ''
  const localEngine = typeof input.localEngine === 'string' ? input.localEngine.trim() : ''
  const speed = Number(input.speed)
  return {
    ...base,
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
  // 厂商、接口地址、Key、模型任一不对，或音色被这家拒了，失败原因都落进 error 那一句给界面弹出来
  // （1.1.0 起音色不再是必填门槛，填错的由服务商回原话，见 ttsService 的错误正文截断）。
  // 失败那一句由 guard 落，只带通道名和 message；这里另记一条「这次按哪套方案跑的」——
  // 记的只有方案 id 和云端/本地这一档，Key、接口地址、文稿正文从来不入日志（入参不整份记）。
  ipcHandle(
    'tts:preview',
    async (_event, text: string, opts?: unknown): Promise<TTSPreviewResult> => {
      // 记的是 resolveProfileId 问出来的**实际**那条：界面传来的 id 可能已经被另一扇窗删掉，
      // 那时这次取值落回配音档默认方案，按传进来的记会说谎
      const profileId = await resolveProfileId('tts', profileIdOf(opts))
      const config = withOverrides(await getTTSConfig(profileId), opts)
      logger.info('TTS', 'Preview config', { profileId, engine: config.engine })
      return { clip: await previewSpeech(String(text ?? ''), config), error: null }
    },
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
      const profileId = await resolveProfileId('tts', profileIdOf(opts))
      const config = withOverrides(await getTTSConfig(profileId), opts)
      // 开跑前记一句「按哪套跑的」：这批是分钟级的活，崩在中途时日志里得能看出当时用的是哪条方案
      logger.info('TTS', 'Batch config', {
        profileId,
        engine: config.engine,
        total: queue.length,
      })
      const batch = await synthesizeSegments(queue, config, sendProgress)
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

        // 历史记一笔（#247）：有产物就记，所以「取消/熔断但已经拼出一条轨」也在这——
        // 那条轨用户能另存、也能勾「留住」，不记账就等于让他找不到自己那半条轨。
        // 记的是 withOverrides 之后那一份 config：配音页开跑前可以临时换音色/倍速（本地档还能换模型）
        // 而不写回设置，记设置里现在的值会把「这次实际用了什么」答错。
        await addHistoryRecord({
          id: jobId,
          name: sourceNameOf(opts),
          profiles: { asr: null, ai: null, tts: profileId },
          detail: {
            kind: 'voice',
            engine: config.engine,
            // 本地档「这一批用的哪一档模型」在这套界面上就是引擎 id（配音页那个「模型」下拉
            // 给本地档列的是 VITS / Kokoro），云端档才是服务商的模型 id。参数按档分叉，名字也得跟着。
            model: config.engine === 'local' ? config.localEngine : config.model,
            voice: config.voice,
            speed: config.speed ?? 1,
            clips: result.clips.length,
            queueTotal: queue.length,
            trackBytes: track.bytes,
            trackDuration: track.duration,
            pushedCount: track.pushedCount,
          },
          // 批次目录还在（界面要拿它播放），所以这一勾现在点得动；
          // 界面清空结果或返回首页会 releaseBatch，那时原件没了，留住得赶在之前勾
          source: track.filePath,
        })

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
   * 第二个参数是第②步加的方案 id：多套配音配置之后，「这一套要用的引擎装没装好」得能按套问，
   * 传空就是问当前默认那套（与 preview/synthesize 同一个落点）。
   * 「检查状态」不主动 ensure 是刻意的——本地档懒启动，用户只是想知道组件下没下好，
   * 不该因为打开设置页就吃掉一次 8 秒解包和几百 MB 内存。
   */
  ipcHandle(
    'tts:localStatus',
    async (
      _event,
      requestedEngine?: unknown,
      requestedProfile?: unknown
    ): Promise<LocalTtsStatusResult> => {
      const config = await getTTSConfig(trimArg(requestedProfile) || undefined)
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
   * 音色名单（1.1.2 #340）：配音页「音色」那一格输入时的候选来源。
   *
   * 只读已保存的方案，不接界面传的厂商——与「点保存才生效」同一条口径，
   * 否则没保存的选择会让这一格去问另一家。
   *
   * 取不到名单**不是**配音坏了：那一格本来就支持手输，所以这一条的失败形状回的是
   * `ok:false` 加一句原因，界面拿它换一行灰字，不弹红条、不拦任何操作。
   */
  ipcHandle(
    'tts:voiceList',
    async (_event, requestedProfile?: unknown): Promise<VoiceListResult> => {
      const config = await getTTSConfig(trimArg(requestedProfile) || undefined)
      // 本地档那一格是编号下拉（引擎自己报数），云端里也只有 MiniMax 有这条接口。
      // 两种「没有候选可给」都回 ok:false + error:null——界面照旧手输，一个字都不用多说
      if (config.engine !== 'cloud' || !ttsVendorListsVoices(config.vendor)) {
        return { ok: false, voices: [], error: null }
      }
      const voices = await listVendorVoices(config)
      return { ok: true, voices, error: null }
    },
    // 抛到这里就是「问过了但没问到」（Key 空、网络、对方回错误码）。voices 给空数组不是谎：
    // error 非空时界面念的是这句原因，不会把空数组读成「这家一个音色都没有」
    (message) => ({ ok: false, voices: [], error: message })
  )

  /**
   * 复刻这一趟用哪一份地址（#346）。
   *
   * 默认就是配音方案那一格洗回根的那一份——原厂直连下这是对的，两家的复刻端点与配音端点同主机同前缀。
   * 单独指定只治两类真会打错的：网关只转发了配音那一条路径（复刻打过去是一条不存在的路由），
   * 以及那一格留空时 `getTTSConfig` 回落到校对那一份（百炼的校对预设正是 `.../compatible-mode`）。
   * 覆盖值走同一套 `normalizeApiBase`，所以「粘整条端点」在这里也是同一个行为，不是第二套规则。
   */
  function cloneApiBase(config: { apiBase: string }, endpointOverride: string): string {
    return endpointOverride ? normalizeApiBase(endpointOverride) : config.apiBase
  }

  /**
   * 选一段要拿去复刻的音频（1.1.2 #330）。
   *
   * 过滤器按**这一家收什么**给（MiniMax 是 mp3/m4a/wav，百炼是 wav/mp3/m4a），
   * 而不是把转写那份「音视频全收」的白名单搬过来：复刻收的是音频本身，
   * 让人选一个 .mp4 进来，再在下一步报「这一家只收 mp3 / m4a / wav」是把话说明得太晚。
   *
   * 回 null＝用户按了取消，与 `dialog:selectFile` 同一个口径；这一家不支持复刻时也回 null，
   * 因为那颗按钮本来就不该被点到（界面上按 `ttsVendorClonesVoices` 决定摆不摆）。
   */
  ipcHandle(
    'tts:pickCloneAudio',
    async (_event, requestedProfile?: unknown): Promise<string | null> => {
      const config = await getTTSConfig(trimArg(requestedProfile) || undefined)
      if (config.engine !== 'cloud' || !ttsVendorClonesVoices(config.vendor)) return null
      const spec = ttsVendorCloneSpec(config.vendor)
      logger.userAction('Clone audio dialog opened', { vendor: config.vendor })
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          {
            name: `${TTS_VENDOR_NAMES[config.vendor]} 复刻音频`,
            extensions: [...spec.formats],
          },
        ],
      })
      if (result.canceled || result.filePaths.length === 0) return null
      logger.userAction('Clone audio selected', { name: basename(result.filePaths[0]) })
      return result.filePaths[0]
    },
    () => null
  )

  /**
   * 用一段本机音频复刻一把音色（1.1.2 #330）。
   *
   * 只读已保存的方案（与 `tts:voiceList` 同一条口径）：复刻是往用户账号里**写**一把音色，
   * 拿一个没保存的厂商去写等于把东西写到另一家账号里，那比读错严重得多。
   *
   * 与配音批次不同，这一步**不做费用确认**：两家复刻本身不收合成费（MiniMax 按音色数量算资产，
   * 百炼建音色不收费，收的是之后用它合成那些字）。
   * 它是不可逆的——账号里多出来的那把音色在本应用删不掉，只能去对方控制台删——所以那句话由面板
   * 写在按钮旁边（同处还写明落在哪家账号、这一趟打哪几条地址）；这里不再套一层确认弹窗：
   * 走到那颗按钮要先展开面板、选录音、起名，三步都是有意为之。
   */
  ipcHandle(
    'tts:voiceClone',
    async (_event, args?: unknown): Promise<VoiceCloneIpcResult> => {
      const input = (args ?? {}) as Record<string, unknown>
      const filePath = trimArg(input.filePath)
      const name = trimArg(input.name)
      if (!filePath) return { ok: false, voiceId: '', error: '先选一段要拿去复刻的音频' }
      if (!name) return { ok: false, voiceId: '', error: '先给这一把复刻音色起个名' }
      const config = await getTTSConfig(trimArg(input.profileId) || undefined)
      const result = await cloneVoice(
        { ...config, apiBase: cloneApiBase(config, trimArg(input.endpointOverride)) },
        { filePath, name }
      )
      return { ok: true, voiceId: result.voiceId, error: null }
    },
    (message) => ({ ok: false, voiceId: '', error: message })
  )

  /**
   * 复刻这一趟会打到哪几条地址（#346，只给界面念，不做任何事）。
   *
   * 单开一条而不是让渲染层自己拼，是因为拼法那份独一性正是这一条链路的全部风险所在：
   * `normalizeApiBase` 洗根 + `appendApiPath` 接尾巴，渲染层再实现一遍就是第二个出处，
   * 而界面上一句和请求不一致的话，用户按它去排查方向就错了（#327 那轮踩过同一类）。
   * 所以这里收的参数与 `tts:voiceClone` 完全同构，走的是同一个 `cloneApiBase`。
   *
   * 本地档、以及那两家不支持复刻的：回空数组，界面上那一行本来也不出现（按 `ttsVendorClonesVoices`）。
   */
  ipcHandle(
    'tts:cloneEndpoints',
    async (_event, args?: unknown): Promise<{ urls: string[] }> => {
      const input = (args ?? {}) as Record<string, unknown>
      const config = await getTTSConfig(trimArg(input.profileId) || undefined)
      if (config.engine !== 'cloud' || !ttsVendorClonesVoices(config.vendor)) {
        return { urls: [] }
      }
      return { urls: voiceCloneEndpoints(config.vendor, cloneApiBase(config, trimArg(input.endpointOverride))) }
    },
    () => ({ urls: [] })
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
