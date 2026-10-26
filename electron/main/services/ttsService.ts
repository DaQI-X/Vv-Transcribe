/**
 * 配音（TTS）服务
 *
 * 只做一件事：把一段文本交给用户在设置里配好的 OpenAI 兼容音频接口
 * （`POST {apiBase}/v1/audio/speech`），拿回音频落盘，并顺手用 ffprobe 读出它的真实时长。
 *
 * 时长是这里必须的返回值，不是顺便：接口不返回时间信息，而「这段配音会不会压到下一条字幕的
 * 起点」只能靠实测时长判断，批量合成前必须拿得到。
 *
 * 三条踩过坑的口径写在这里：
 * - 接口地址与 Key 跟校对共用，模型和音色**不共用**（chat 模型调音频接口会被直接拒）。
 * - 各家兼容程度不一样，接口返回 200 但 body 是 JSON 错误的网关确实存在，所以内容类型必须验，
 *   否则落盘一个 .mp3 里面装着 `{"error":...}`，用户在播放器里只会看到「加载失败」。
 * - 花费落在用户自己的 Key 上，所以任何一次调用前都得让他看清要调多少次。
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { mkdir, rm, writeFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { logger } from './logger'
import { probeFile, resolveFfmpegBinary } from './audioProcessor'

/** 主进程内部用的配音配置：明文 Key，只有主进程拿得到（见 settingsService 的脱敏视图） */
export interface TTSConfig {
  apiKey: string
  apiBase: string
  model: string
  voice: string
}

/** 单次合成产物：路径给播放器，字节数与时长给时间轴 */
export interface SynthesizedClip {
  filePath: string
  bytes: number
  /** 秒，ffprobe 实测；读不出来时为 0，调用方必须当成「不知道」而不是「零长度」 */
  duration: number
}

/** 一段文本给接口吃一次的上限：接口正常时中文长句也就几秒，60 秒不回就是端点或网络出问题了 */
const SPEECH_TIMEOUT_MS = 60_000

/** 错误正文只截这些字符进 toast：网关的 HTML 报错页整段甩给用户毫无意义 */
const ERROR_BODY_LIMIT = 200

/**
 * 缺哪项说哪项。让请求带着空 model 发出去，用户收到的是一条看不懂的 400，
 * 而真实原因只是「设置里配音模型还没填」。
 */
export function ttsConfigProblem(config: TTSConfig): string | null {
  if (!config.apiKey) return '未配置 API Key，请在「设置 → 校对配置」中填写'
  if (!config.model) return '未配置配音模型，请在「设置 → 校对配置 → 配音模型」中填写'
  if (!config.voice) return '未配置配音音色，请在「设置 → 校对配置 → 配音音色」中填写'
  return null
}

/** 临时目录名沿用 transcribe- 前缀：1.0.5 起的启动清扫按这个前缀删，崩溃与强杀遗留能被兜住 */
function newTempDir(): string {
  return join(tmpdir(), `transcribe-tts-${randomUUID()}`)
}

/**
 * 上一次试听的目录。只留一个：试听是「听完就换下一个音色」的动作，
 * 攒着一堆历史片段既没人听也占临时盘。新一段开始前先回收上一段。
 */
let lastPreviewDir: string | null = null

async function releasePreviewDir(): Promise<void> {
  if (!lastPreviewDir) return
  const dir = lastPreviewDir
  lastPreviewDir = null
  await rm(dir, { recursive: true, force: true }).catch(() => {
    /* 已经没了或被别的实例占用，交给启动清扫 */
  })
}

/**
 * 调用音频接口合成一条文本。
 * 抛错即失败，调用方负责把它变成 `{ error }` 回给界面——主进程不跨 IPC 抛（全应用统一口径）。
 */
export async function synthesizeSpeech(
  text: string,
  config: TTSConfig,
  tempDir: string
): Promise<SynthesizedClip> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('这段文本是空的，没什么可以合成的')

  const problem = ttsConfigProblem(config)
  if (problem) throw new Error(problem)

  const url = `${config.apiBase}/v1/audio/speech`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SPEECH_TIMEOUT_MS)
  let bytes: Buffer
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: trimmed,
        voice: config.voice,
        response_format: 'mp3',
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, ERROR_BODY_LIMIT)
      // 404 几乎只有两种原因：这家服务商根本没有这个端点，或者接口地址填错了层级。
      // 说清楚，比让人对着 404 猜强。
      const hint =
        response.status === 404
          ? '（这个服务商可能没有 OpenAI 标准的音频接口，或 API Base 少/多层路径）'
          : response.status === 401
            ? '（Key 不对或没有调用该模型的权限）'
            : ''
      throw new Error(`配音接口返回 ${response.status}${hint}${body ? `：${body}` : ''}`)
    }
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('json')) {
      const body = (await response.text().catch(() => '')).slice(0, ERROR_BODY_LIMIT)
      throw new Error(`配音接口没返回音频，返回的是 JSON：${body || '空 body'}`)
    }
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`配音请求 ${SPEECH_TIMEOUT_MS / 1000} 秒没响应，已中断`)
    }
    if (err instanceof Error && err.message.startsWith('配音')) throw err
    // fetch 本身抛的是 TypeError（DNS/断网/TLS），原样吐出来用户至少能认出是网络问题
    throw new Error(`配音请求没能发出去：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }

  if (bytes.length === 0) throw new Error('配音接口返回了 0 字节音频')

  await mkdir(tempDir, { recursive: true })
  const filePath = join(tempDir, `${randomUUID()}.mp3`)
  await writeFile(filePath, bytes)

  let duration = 0
  try {
    duration = (await probeFile(filePath)).duration
  } catch (err) {
    // 时长读不出来不等于合成失败：产物是好的，只是「会不会压到下一段」暂时判断不了
    logger.warn('TTS', 'ffprobe failed on synthesized clip', {
      name: basename(filePath),
      message: err instanceof Error ? err.message : String(err),
    })
  }

  const info = await stat(filePath)
  return { filePath, bytes: info.size, duration }
}

/**
 * 试听一条。批量合成前先听一句，是最便宜的「端点+模型+音色三样都对」的验证——
 * 整条稿子跑到第 20 段才发现音色不对，烧的是用户的钱。
 */
export async function previewSpeech(text: string, config: TTSConfig): Promise<SynthesizedClip> {
  await releasePreviewDir()
  const tempDir = newTempDir()
  lastPreviewDir = tempDir
  const clip = await synthesizeSpeech(text, config, tempDir)
  logger.userAction('TTS preview synthesized', {
    bytes: clip.bytes,
    duration: Number(clip.duration.toFixed(2)),
    model: config.model,
    voice: config.voice,
  })
  return clip
}

/** 显式释放（切走、取消、退出前）；没留目录时什么都不做 */
export async function releasePreview(): Promise<void> {
  await releasePreviewDir()
}

/** 渲染层传下来的段落形状：时间轴只有渲染层有，主进程不存第二份（与 proofread:local 同一口径） */
export interface TTSSegmentInput {
  id: string
  /** 秒，浮点（转写段落的时间单位一直是秒） */
  startTime: number
  endTime: number
  text: string
}

export type TTSStage = 'synthesizing' | 'skipped' | 'failed' | 'assembling' | 'done'

/** 进度回传：index/total 是真实段号，不做假百分比 */
export interface TTSProgress {
  jobId: string
  stage: TTSStage
  /** 1 起算的真实段号；0 是「已经发起、第一段还在接口那边」，让渲染层早点拿到 jobId 好放取消 */
  index: number
  total: number
  segmentId?: string
  /** 失败原因，或「这段是空的，没花钱」 */
  note?: string
}

/** 一条成品片段：时间戳留着，铺轴那一步按它决定落在哪 */
export interface TTSClip {
  segmentId: string
  index: number
  startTime: number
  endTime: number
  filePath: string
  bytes: number
  duration: number
}

export interface TTSFailure {
  segmentId: string
  index: number
  error: string
}

export interface TTSBatchResult {
  jobId: string
  tempDir: string
  clips: TTSClip[]
  failures: TTSFailure[]
  /** 空段落：不调接口、不花钱，直接进跳过名单 */
  skipped: string[]
  canceled: boolean
  /** 中途整体停下来的原因（连续失败熔断这类），null 表示没熔断 */
  abortedReason: string | null
}

interface BatchJob {
  id: string
  canceled: boolean
  tempDir: string
}

const batchJobs = new Map<string, BatchJob>()

/**
 * 连续失败到这个数就整批停。
 * 单段失败继续往下跑是对的（网络抖一下不该作废前面几十段的钱）；但 Key 没权限、
 * 音色名写错这类系统性错误会连着失败几百次，一路跑完等于把用户的额度拿去试错。
 */
const MAX_CONSECUTIVE_FAILURES = 3

/** 一批一个目录：目录名带批次 id，日志与磁盘能一眼对上 */
function newBatchDir(jobId: string): string {
  return join(tmpdir(), `transcribe-tts-${jobId}`)
}

/** 取消：置标志位，循环在每段之间检查（正在飞出去的那一次请求不打断，钱已经花了） */
export function cancelTTSSynthesis(jobId: string): boolean {
  const job = batchJobs.get(jobId)
  if (!job) return false
  job.canceled = true
  logger.userAction('TTS batch canceled', { jobId })
  return true
}

/**
 * 逐段合成。串行，不并发：
 * 并发对配音没有意义（总调用数一样），但各家网关的 QPS 限制会让并发版本先撞 429，
 * 而且失败重试的归属会糊在一起。慢一点是这条链路本来就有的性质，界面上如实给段号。
 */
export async function synthesizeSegments(
  segments: TTSSegmentInput[],
  config: TTSConfig,
  onProgress: (p: TTSProgress) => void
): Promise<{ job: BatchJob; result: TTSBatchResult }> {
  const problem = ttsConfigProblem(config)
  if (problem) throw new Error(problem)

  const jobId = randomUUID()
  const tempDir = newBatchDir(jobId)
  await mkdir(tempDir, { recursive: true })
  const job: BatchJob = { id: jobId, canceled: false, tempDir }
  batchJobs.set(jobId, job)

  const total = segments.length
  const clips: TTSClip[] = []
  const failures: TTSFailure[] = []
  const skipped: string[] = []
  let abortedReason: string | null = null
  let consecutiveFailures = 0

  logger.info('TTS', 'Batch started', { jobId, total, model: config.model, voice: config.voice })

  // 先把 jobId 推下去：第一段在慢网里能飞几十秒，界面那时候就已经想给用户一个能按的「取消」了
  onProgress({ jobId, stage: 'synthesizing', index: 0, total })

  for (let i = 0; i < total; i++) {
    const segment = segments[i]
    const index = i + 1

    // 取消只写 canceled 标志：abortedReason 是「熔断原因」，两者混用界面就分不清
    // 是用户自己按了取消，还是连续失败把整批停下来了
    if (job.canceled) break

    if (!segment.text.trim()) {
      skipped.push(segment.id)
      onProgress({ jobId, stage: 'skipped', index, total, segmentId: segment.id, note: '空段落，未调用接口' })
      continue
    }

    try {
      const clip = await synthesizeSpeech(segment.text, config, tempDir)
      clips.push({ segmentId: segment.id, index, startTime: segment.startTime, endTime: segment.endTime, ...clip })
      consecutiveFailures = 0
      onProgress({ jobId, stage: 'synthesizing', index, total, segmentId: segment.id })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push({ segmentId: segment.id, index, error: message })
      consecutiveFailures++
      onProgress({ jobId, stage: 'failed', index, total, segmentId: segment.id, note: message })
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        abortedReason = `连续 ${consecutiveFailures} 段都失败，已停止整批（最后一条原因：${message}）`
        logger.error('TTS', 'Batch aborted on consecutive failures', { jobId, index, message })
        break
      }
    }
  }

  return {
    job,
    result: { jobId, tempDir, clips, failures, skipped, canceled: job.canceled, abortedReason },
  }
}

/** 批次目录的显式回收；启动清扫（transcribe- 前缀 + 24 小时）是兜底，不是主要手段 */
async function releaseBatch(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true }).catch(() => {
    /* 已经没了，或被用户自己在文件管理器里开着 */
  })
}

/** 拼好的整轨按 jobId 存着，另存与释放都按 id 找主进程自己的记录——渲染层报上来的路径一律不信 */
const voiceTracks = new Map<string, VoiceTrack>()

/** 拼出来的整条配音轨 */
export interface VoiceTrack {
  filePath: string
  bytes: number
  /** 配音轨总时长（ffprobe 实测，秒） */
  duration: number
  /** 因为「配音比字幕槽位长」而被往后推的段数 */
  pushedCount: number
  /** 接口时长没读出来、只能按字幕槽位估算的段数 */
  estimatedCount: number
  /** 原时间轴最后一段的结束点，用来跟 duration 对照（界面要说「比原片长了多少」） */
  originalEnd: number
}

/**
 * 一次 amix 最多挂多少路输入。
 * 几百段字幕全塞进一个 amix 在语法上没问题（上限 32767），但 filtergraph 字符串会长到
 * 撞 Windows 的 32KB 命令行上限，所以图写文件（-filter_complex_script）+ 分组混音：
 * 分组之间不重叠，normalize=0 是「按样本相加」，加 silence 等于没加，音量不会分层衰减。
 */
const MIX_GROUP_SIZE = 64

interface Placement {
  clip: TTSClip
  placedAt: number
  pushed: boolean
  estimated: boolean
}

/**
 * 顺延排布：每段落点 = max(自己的 startTime, 上一段的结束点)。
 * 于是永不重叠、顺序不变，代价是整条可能比原视频长——这是拍板选的策略，
 * 推后了多少段必须原样报给界面，不能让用户以为「时长肯定对得上画面」。
 */
function planPlacements(clips: TTSClip[]): { placements: Placement[]; totalDuration: number } {
  let cursor = 0
  const placements: Placement[] = []
  for (const clip of clips) {
    const estimated = !(clip.duration > 0)
    const length = estimated ? Math.max(0, clip.endTime - clip.startTime) : clip.duration
    const placedAt = Math.max(clip.startTime, cursor)
    placements.push({ clip, placedAt, pushed: placedAt - clip.startTime > 0.01, estimated })
    cursor = placedAt + length
  }
  return { placements, totalDuration: cursor }
}

/** 直接 spawn：几百路输入 + 复杂图，fluent-ffmpeg 的链式写法接不住这个形状 */
function runFfmpeg(args: string[]): Promise<void> {
  const bin = resolveFfmpegBinary()
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args])
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    child.on('error', (err) => reject(new Error(`没能启动 ffmpeg：${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`配音轨拼接失败（ffmpeg 退出码 ${code}）：${stderr.trim().slice(-300) || '没有任何输出'}`))
    })
  })
}

/**
 * 把逐段成品拼成一条对齐时间轴的配音轨。
 * 输出 mp3：源片段本来就是 mp3，重编码一次统一采样率即可，剪辑软件都吃。
 */
async function assembleVoiceTrack(clips: TTSClip[], tempDir: string): Promise<VoiceTrack> {
  if (clips.length === 0) throw new Error('一段都没合成成功，没有可以拼起来的音频')

  const { placements, totalDuration } = planPlacements(clips)
  const graph: string[] = []
  const args: string[] = []

  placements.forEach((placement, i) => {
    args.push('-i', placement.clip.filePath)
    const ms = Math.round(placement.placedAt * 1000)
    graph.push(
      `[${i}:a]aformat=sample_rates=44100:channel_layouts=mono,adelay=delays=${ms}:all=1[a${i}]`
    )
  })

  // 先按 MIX_GROUP_SIZE 切组，组的输出标签取决于「一共几组」：
  // 只有一组时它本身就是 [out]，多组时各组先落成 [mG]、末尾再汇总一次。
  // 原来写成「单组也标 [m0]、只有多组才补 [out]」，几段一小批时 [out] 根本不存在，ffmpeg 直接报错。
  const groups: number[][] = []
  for (let start = 0; start < placements.length; start += MIX_GROUP_SIZE) {
    groups.push(Array.from({ length: Math.min(MIX_GROUP_SIZE, placements.length - start) }, (_, offset) => start + offset))
  }

  const mixGroup = (labels: string, outLabel: string, inputs: number) => {
    graph.push(
      `${labels}${inputs === 1 ? 'anull' : `amix=inputs=${inputs}:duration=longest:dropout_transition=0:normalize=0`}${outLabel}`
    )
  }

  const groupOutLabels: string[] = []
  groups.forEach((indices, g) => {
    const outLabel = groups.length === 1 ? '[out]' : `[m${g}]`
    mixGroup(indices.map((i) => `[a${i}]`).join(''), outLabel, indices.length)
    groupOutLabels.push(outLabel)
  })
  if (groupOutLabels.length > 1) {
    mixGroup(groupOutLabels.join(''), '[out]', groupOutLabels.length)
  }

  const graphPath = join(tempDir, 'filtergraph.txt')
  await writeFile(graphPath, graph.join(';\n'))
  const filePath = join(tempDir, 'voice-track.mp3')

  await runFfmpeg([
    ...args,
    '-filter_complex_script',
    graphPath,
    '-map',
    '[out]',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '192k',
    filePath,
  ])

  const { duration } = await probeFile(filePath)
  const info = await stat(filePath)
  const originalEnd = placements.reduce((max, p) => Math.max(max, p.clip.endTime), 0)
  const pushedCount = placements.filter((p) => p.pushed).length
  const estimatedCount = placements.filter((p) => p.estimated).length

  logger.info('TTS', 'Voice track assembled', {
    segments: placements.length,
    pushedCount,
    estimatedCount,
    trackDuration: Number(duration.toFixed(2)),
    originalEnd: Number(originalEnd.toFixed(2)),
    bytes: info.size,
  })

  // totalDuration 是排布算出来的期望值，只用于日志对照；对用户报的是 ffprobe 实测
  logger.debug('TTS', 'Planned vs probed duration', {
    planned: Number(totalDuration.toFixed(2)),
    probed: Number(duration.toFixed(2)),
  })

  return {
    filePath,
    bytes: info.size,
    duration,
    pushedCount,
    estimatedCount,
    originalEnd,
  }
}

/**
 * 拼轨并登记。跟 synthesizeSegments 分成两个调用点是因为进度要能单独报「开始拼接」——
 * 几百段的 amix 要跑一阵，界面那时候不能还写着「第 137/137 段」。
 */
export async function composeVoiceTrack(jobId: string, clips: TTSClip[]): Promise<VoiceTrack> {
  const job = batchJobs.get(jobId)
  if (!job) throw new Error('这批配音任务已经不在了，请重新发起')
  const track = await assembleVoiceTrack(clips, job.tempDir)
  voiceTracks.set(jobId, track)
  return track
}

/** 取回某一批的成品轨（回放与另存都走这里） */
export function getVoiceTrack(jobId: string): VoiceTrack | null {
  return voiceTracks.get(jobId) ?? null
}

/**
 * 回收一整批：中间片段是几十到几百个 mp3，加一条成品轨，占的是用户的临时盘。
 * 另存成功、以及用户关掉弹窗都该调它；漏了有 24 小时清扫兜着。
 */
export async function releaseBatchById(jobId: string): Promise<void> {
  voiceTracks.delete(jobId)
  const job = batchJobs.get(jobId)
  if (!job) return
  batchJobs.delete(jobId)
  await releaseBatch(job.tempDir)
}
