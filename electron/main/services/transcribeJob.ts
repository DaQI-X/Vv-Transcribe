/**
 * 转写作业本体（#375 从 ipc/asrHandlers.ts 抽出来）
 *
 * 抽出来的理由只有一条：#355 的门面是第二个调用方，而进度这一头以前焊死在
 * 「谁发起我就往那个窗口 send」（BrowserWindow.fromWebContents(event.sender)）。
 * 现在进度是一个传进来的 sink，作业本身不认窗口、不认 IPC，也**不 import 'electron'**——
 * 这句话是门面能不能复用这层的唯一前提，tests/transcribeJob.test.ts 把它钉成了判据。
 *
 * ⚠️ 对账口径：`asr:progress` 的载荷与时序、以及历史记录那一条的字段，与抽出之前逐字相同。
 * 任何「顺手改一下进度算法」都会同时改到界面，那不该发生在这条通道上（要改去 asrManager 改）。
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { extractAudio, cleanupTemp } from './audioProcessor'
import { dropMediaSessionCookies, releaseMediaSessionsExcept } from './urlDownloader'
import { runTranscription } from './asr/asrManager'
import { getASRConfig, normalizeLocalModel, resolveProfileId } from './settingsService'
import { addHistoryRecord } from './historyService'
import type { ASRModelInfo, ASRSegment, ASRStage } from './asr/types'
import { logger } from './logger'

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

/**
 * 一次进度事件＝界面那条通道收到的那个对象，五个键始终都在（没给的那三个是 undefined）。
 * jobId 装在载荷里：界面靠它把事件对上自己发起的那一单，多个调用方共用一个 sink 时也只能这么认。
 */
export interface TranscribeProgressEvent {
  jobId: string
  progress: number
  segment?: ASRSegment
  stage?: ASRStage
  model?: ASRModelInfo
}

export type TranscribeProgressSink = (event: TranscribeProgressEvent) => void

export interface TranscribeJobOptions {
  language?: string
  mediaSessionId?: string
  profileId?: string
}

/** 成功那一支没有 canceled/error，失败那一支没有 segments/provider：界面原本就是这么分的 */
export type TranscribeJobResult =
  | { jobId: string; success: true; segments: ASRSegment[]; provider: 'local' | 'cloud' }
  | { jobId: string; success: false; canceled: boolean; error: string }

/**
 * 跑一整单转写：提取音频 → 调引擎 → 全程推进度 → 记一笔历史 → 返回段落。
 * 抛出的一切都在这里收住，回 success:false——调用方（窗口 sink、门面的 HTTP 响应）都只该拿到一个值。
 */
export async function startTranscribeJob(
  filePath: string,
  options: TranscribeJobOptions = {},
  onProgress: TranscribeProgressSink
): Promise<TranscribeJobResult> {
  const jobId = randomUUID()
  const signal = new AbortController()
  // 历史记录要的是「这次跑了多久」，那就得从开工那刻算；提取和转写两段都在里面
  const startedAt = Date.now()

  activeJobs.set(jobId, { jobId, signal, tempDir: null })

  const sendProgress = (progress: number, segment?: ASRSegment, stage?: ASRStage, model?: ASRModelInfo) => {
    onProgress({ jobId, progress, segment, stage, model })
  }

  /**
   * 链接转写的源文件躺在 urlDownloader 的会话目录里，那目录还装着浏览器 cookies。
   * 提取出 wav 之后 cookies 就没用了，立刻删；但媒体不能跟着一起删——播放器整场都要拿它回放
   * （一起删的后果：逐句回放在链路末尾变成一条「文件已被移动」的 toast）。
   * 上一份素材的媒体在开工时回收，本次这份留到下次开工或应用退出，强杀留下的由启动清扫兜底。
   */
  const dropCookies = async () => {
    if (options.mediaSessionId) {
      await dropMediaSessionCookies(options.mediaSessionId).catch(() => {})
    }
  }

  try {
    logger.info(TAG, 'Start job', { jobId, file: basename(filePath), language: options.language ?? 'zh' })
    sendProgress(0)
    // 界面一次只放一条转写：开工就把上一份素材的临时媒体回收掉，本次这份留着给播放器回放
    releaseMediaSessionsExcept(options.mediaSessionId ?? null)

    const extractResult = await extractAudio(filePath)
    logger.info(TAG, 'Audio extracted', { jobId })
    await dropCookies()
    const state = activeJobs.get(jobId)
    if (state) state.tempDir = extractResult.tempDir

    sendProgress(5)

    // 界面传来的方案 id 可能已被另一扇窗删掉，那时这条落回该档当前默认方案；
    // 日志与历史记录（#247）要记的是**实际用到**的那条，不是传进来的那个
    const profileId = await resolveProfileId('asr', options.profileId)
    const config = await getASRConfig(profileId)
    // 只报模式与「有没有 Key」这两个：apiKey 本身和它的长度都不能进日志。
    // 键名要避开 `apikey` 这个词——`hasApiKey` 会被脱敏闸门按键名隐成 [已隐去:boolean]，
    // 而这一条的全部用途就是回答「到底有没有 Key」（理由写在 logRedact.ts）
    logger.info(TAG, 'Transcription config', {
      provider: config.provider,
      keyStatus: !!config.apiKey,
      profileId,
    })

    const result = await runTranscription(extractResult.wavPath, config, {
      language: options.language ?? 'zh',
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

    // 历史记一笔（#247）。记在返回之前，是因为这一步不该和界面渲染抢时序：
    // 界面上「刚跑完那条必须排在第一行」是这一版唯一的排序承诺。
    // 只记元信息，正文一段都不落盘；记账失败也不影响这一单已经转完了。
    await addHistoryRecord({
      id: jobId,
      name: basename(filePath),
      // 校对是另一条链路（proofread:local / ai:correct），它不产出新素材，所以这一列今天恒为 null
      profiles: { asr: profileId, ai: null, tts: null },
      detail: {
        kind: 'transcribe',
        provider: result.provider,
        // 本地档记的是 normalizeLocalModel 之后那一档：asrManager 真拿它去对引擎的档位，
        // 记 config.localModel 原样会把「设置里写了个没归一的档位」和「实际用了 base」混成一谈
        model:
          result.provider === 'cloud'
            ? String(config.model ?? '')
            : normalizeLocalModel(config.localModel),
        language: options.language ?? 'zh',
        segments: result.segments.length,
        // ffprobe 读不出时长时给的是 0，那是「不知道」而不是「零长的素材」
        durationSec: extractResult.metadata.duration > 0 ? extractResult.metadata.duration : null,
        elapsedMs: Date.now() - startedAt,
      },
      // 提取出来的 wav 在上面那行 cleanupTemp 就没了，这一类没有产物可以留
      source: null,
    })

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
}

/**
 * 取消一单：abort + 清临时目录 + 摘账。
 * 没找到 jobId 也算 ok：那说明任务已经跑完，不是这一步失败了。
 */
export async function cancelTranscribeJob(
  jobId: string
): Promise<{ ok: boolean; error: string | null }> {
  const state = activeJobs.get(jobId)
  if (state) {
    state.signal.abort()
    if (state.tempDir) {
      await cleanupTemp(state.tempDir).catch(() => {})
    }
    activeJobs.delete(jobId)
  }
  return { ok: true, error: null }
}
