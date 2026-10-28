/**
 * 配音（TTS）服务
 *
 * 只做一件事：把一段文本换成一条音频落盘，并带回它的时长。换的方式有两档，
 * 对上层（ttsHandlers、配音页）是同一个契约 `{ filePath, bytes, duration }`：
 * - 云端档（默认）：`POST {apiBase}/v1/audio/speech`，OpenAI 兼容音频接口。
 * - 本地档：本机 sidecar（见 localTtsEngine），不花钱、不联网，回 WAV 并自带精确采样数。
 *
 * 这个时长只给「试听完那句有多长」用；铺轴不认它。云端接口不返回时间信息，而 ffprobe 对 mp3 报的是
 * 按码率估的容器长度（含 LAME 前后填充），实测 0.5 秒的片段会报成 0.549 秒——拼整轨时改用自己的
 * PCM 解码样本数，见 toMeasuredPcm。本地档的 X-Vv-Duration 就是 sidecar 数的采样数，可以直接用，
 * 但「段与段之间怎么顺延」仍然每次都重新解一遍：VITS 同文本同音色连跑时长会抖 ±6%（2026-10-28 本机实测），
 * 没有 seed 可钉，缓存上一次的结论就是把误差累进时间轴。
 *
 * 四条踩过坑的口径写在这里：
 * - 配音有独立的一整套配置（接口地址、Key、模型、音色）；地址与 Key 留空时沿用校对那套，
 *   但模型和音色**绝不共用**（chat 模型调音频接口会被直接拒）。
 * - 各家兼容程度不一样，接口返回 200 但 body 是 JSON 错误的网关确实存在，所以内容类型必须验，
 *   否则落盘一个 .mp3 里面装着 `{"error":...}`，用户在播放器里只会看到「加载失败」。
 * - 花费落在用户自己的 Key 上，所以任何一次调用前都得让他看清要调多少次。
 * - 配置校验必须跟着引擎档分叉：本地档根本没有 Key 和模型，拿云端那三条去问就是把用户拦在门外；
 *   反过来本地档真正会失败的是「音色不是编号」和「组件没下载」。判松判严都栽过（见 #220/#227）。
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { mkdir, rm, writeFile, stat, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { logger } from './logger'
import { probeFile, resolveFfmpegBinary } from './audioProcessor'
import { parseLocalTtsSid, synthesizeLocally, type LocalTtsEngineId } from './localTtsEngine'

/** 主进程内部用的配音配置：明文 Key，只有主进程拿得到（见 settingsService 的脱敏视图） */
export interface TTSConfig {
  /**
   * 用哪一档。云端档要 Key/模型/音色三样，本地档一样都不要——所以后面那三个字段的含义
   * 是按这一档变的，任何「不分档就取值」的写法都会把另一档的配置要求强加过来。
   */
  engine: 'cloud' | 'local'
  apiKey: string
  apiBase: string
  model: string
  /** 云端档是服务商的音色名；本地档是 sid 编号的字符串写法（'0'、'40'） */
  voice: string
  /** 本地档用哪个引擎（白名单见 localTtsEngine）；云端档忽略这一项 */
  localEngine: LocalTtsEngineId
  /**
   * 倍速，OpenAI 标准 `speed` 的取值范围是 0.25–4.0。只有单次调用参数能带它（设置里没有这一项），
   * 不填按 1 处理。两档都收这个值：本地 sidecar 自己夹到 0.25–4.0，界面与云端语义因此是一套。
   */
  speed?: number
}

/** 单次合成产物：路径给播放器，字节数与时长给时间轴 */
export interface SynthesizedClip {
  filePath: string
  bytes: number
  /**
   * 秒。云端档是 ffprobe 读 mp3 容器，本地档是 sidecar 数的采样数；
   * 读不出来时为 0，调用方必须当成「不知道」而不是「零长度」。
   */
  duration: number
}

/** 一段文本给接口吃一次的上限：接口正常时中文长句也就几秒，60 秒不回就是端点或网络出问题了 */
const SPEECH_TIMEOUT_MS = 60_000

/** 错误正文只截这些字符进 toast：网关的 HTML 报错页整段甩给用户毫无意义 */
const ERROR_BODY_LIMIT = 200

/**
 * 缺哪项说哪项。让请求带着空 model 发出去，用户收到的是一条看不懂的 400，
 * 而真实原因只是「设置里配音模型还没填」。
 *
 * 本地档只问本地档会坏的那件事：它没有 Key、没有模型名、也没有接口地址，
 * 唯一能从云端那档带坏的字段是音色——界面切了引擎，配置里留着的还可能是 `alloy`。
 */
export function ttsConfigProblem(config: TTSConfig): string | null {
  if (config.engine === 'local') {
    if (parseLocalTtsSid(config.voice) === null) {
      return `本地配音的音色是一个编号（如 0），当前是「${config.voice || '空'}」。请在「设置 → 配音配置 → 本地音色」里重选一个`
    }
    return null
  }
  if (!config.apiKey) return '未配置 API Key，请在「设置 → 配音配置」中填写（留空则沿用校对配置那把）'
  if (!config.model) return '未配置配音模型，请在「设置 → 配音配置 → 配音模型」中填写'
  if (!config.voice) return '未配置配音音色，请在「设置 → 配音配置 → 配音音色」中填写'
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
 * 把一段文本换成一条音频落盘：云端打用户在设置里配好的接口，本地打本机 sidecar。
 * 两档回同一个形状，所以逐段合成、试听、熔断、取消那套语义不需要知道对面是谁。
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

  if (config.engine === 'local') {
    // ttsConfigProblem 已经保证这是个纯数字编号，这里直接交给 sidecar 就行
    return synthesizeLocally(trimmed, config.localEngine, Number(config.voice), config.speed ?? 1, tempDir)
  }

  const url = `${config.apiBase}/v1/audio/speech`
  // 倍速只在真的改过时才进请求体：兼容网关对未知字段的行为不一致，
  // 默认值不带这个键，等于没改倍速的调用走的还是原来那份请求体。
  const body: Record<string, unknown> = {
    model: config.model,
    input: trimmed,
    voice: config.voice,
    response_format: 'mp3',
  }
  if (config.speed && config.speed !== 1) body.speed = config.speed

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
      body: JSON.stringify(body),
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
    engine: config.engine,
    model: config.model,
    voice: config.voice,
  })
  return clip
}

/** 显式释放（配音页点「清空」时）；没留目录时什么都不做 */
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
  /**
   * 逐段循环还在跑。批次记录本身要活到用户释放整轨为止（合成完到点「另存」之间
   * 它一直都在表里），所以「有没有在配音」不能拿 map 的大小判，得看这一段。
   * #230 的组件下载/删除与「停止引擎」都按它拒绝：把正在配音的引擎杀掉，剩下的段落全失败。
   */
  running: boolean
  tempDir: string
}

const batchJobs = new Map<string, BatchJob>()

/** 有没有一批配音正在逐段跑。侧栏组件管理与「停止引擎」的前置闸门 */
export function hasActiveTTSSynthesis(): boolean {
  for (const job of batchJobs.values()) {
    if (job.running) return true
  }
  return false
}

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
 * 本地档串行还有另一个理由：一次推理吃满 4 个线程，并发只会互相抢核，还会把界面拖卡。
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
  const job: BatchJob = { id: jobId, canceled: false, running: true, tempDir }
  batchJobs.set(jobId, job)

  const total = segments.length
  const clips: TTSClip[] = []
  const failures: TTSFailure[] = []
  const skipped: string[] = []
  let abortedReason: string | null = null
  let consecutiveFailures = 0

  logger.info('TTS', 'Batch started', {
    jobId,
    total,
    engine: config.engine,
    model: config.model,
    voice: config.voice,
  })

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

  // 逐段循环出界（跑完、被取消、被熔断）就不再占用引擎了。后面的拼接读的是已经落盘的
  // wav，不需要引擎，所以组件下载与「停止引擎」在这一步之后就可以放行。
  job.running = false

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
 * 拼一次 ffmpeg 允许挂多少路输入，按命令行的字符数算，不按段数。
 * 真正的上限是操作系统的命令行长度（Windows CreateProcess 数的是 32767 个 UTF-16 字符，
 * macOS 是 1MB 的 ARG_MAX），段数估不准它——路径长短都算在里面。24000 相对 32767 留了约四分之一，
 * 给固定参数、输出路径和转义（300 段实测最长一条命令行 24398 字符）。
 */
const FFMPEG_ARG_BUDGET_CHARS = 24_000

/** 间隙小于这么多样本（约 0.2 ms）就不垫静音了：为几微秒生成一路静音不值得 */
const MIN_SILENCE_SAMPLES = 10

interface Placement {
  clip: TTSClip
  placedAt: number
  /** 这一段在时间轴上占多长（解码出来是 0 个采样时按字幕槽位估） */
  length: number
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
    placements.push({ clip, placedAt, length, pushed: placedAt - clip.startTime > 0.01, estimated })
    cursor = placedAt + length
  }
  return { placements, totalDuration: cursor }
}

/** 铺轴的最小单位：一路配音 + 它前面该有的静音垫（垫按样本数记，秒只是换算出来的显示值） */
interface TimelineUnit {
  filePath: string
  /** 这一路 `-i 路径` 在命令行上占的字符数 */
  argChars: number
  silenceSamples: number
}

/**
 * 把排布结果摊成「静音、配音、静音、配音……」的串联序列。
 * 排布本身保证不重叠，所以串联就是精确语义——不能用 amix：包进安装包的
 * win32-x64 / darwin-x64 那两个 ffmpeg 是 2018-12 的构建，`adelay` 还没有 all 选项、
 * `amix` 还没有 normalize（关掉之前是硬按 1/N 衰减），那张图在两个平台上直接退码 1。
 */
function buildTimelineUnits(placements: Placement[]): TimelineUnit[] {
  const units: TimelineUnit[] = []
  let consumed = 0
  for (const placement of placements) {
    units.push({
      filePath: placement.clip.filePath,
      argChars: placement.clip.filePath.length + 4,
      silenceSamples: Math.max(0, Math.round((placement.placedAt - consumed) * PCM_SAMPLE_RATE)),
    })
    consumed = placement.placedAt + placement.length
  }
  return units
}

/** 按命令行字符预算切块；静音垫跟着它后面那一路走，不会被切到上一块末尾 */
function packChunks(units: TimelineUnit[]): TimelineUnit[][] {
  const chunks: TimelineUnit[][] = []
  let current: TimelineUnit[] = []
  let chars = 0
  for (const unit of units) {
    if (current.length > 0 && chars + unit.argChars > FFMPEG_ARG_BUDGET_CHARS) {
      chunks.push(current)
      current = []
      chars = 0
    }
    current.push(unit)
    chars += unit.argChars
  }
  if (current.length > 0) chunks.push(current)
  return chunks
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

/** 拼轨统一的音频参数：44.1k 单声道 s16，concat 只认同一种参数 */
const PCM_SAMPLE_RATE = 44100
const PCM_CHAIN = `aformat=sample_rates=${PCM_SAMPLE_RATE}:channel_layouts=mono:sample_fmts=s16`

/**
 * 渲染一块的 filtergraph。静音走图内的 anullsrc（不占命令行输入，命令行里就只剩每段一个 `-i 路径`），
 * 配音直接取 `[i:a]`（进来了就已经是统一参数的 PCM）。只有一路时不用 concat，anull 直送到 [out]。
 */
function renderChunkGraph(units: TimelineUnit[], outLabel: string): string {
  const lines: string[] = []
  const labels: string[] = []
  units.forEach((unit, i) => {
    if (unit.silenceSamples >= MIN_SILENCE_SAMPLES) {
      const label = `[s${labels.length}]`
      // 按样本数换算成秒（6 位小数），误差 ≤1 个样本；直接写秒会把毫秒级的抖动累到整条上
      lines.push(
        `anullsrc=r=${PCM_SAMPLE_RATE}:cl=mono,atrim=end=${(unit.silenceSamples / PCM_SAMPLE_RATE).toFixed(6)},${PCM_CHAIN}${label}`
      )
      labels.push(label)
    }
    const label = `[c${i}]`
    lines.push(`[${i}:a]${PCM_CHAIN}${label}`)
    labels.push(label)
  })
  const joined = labels.join('')
  lines.push(
    labels.length === 1 ? `${joined}anull${outLabel}` : `${joined}concat=n=${labels.length}:v=0:a=1${outLabel}`
  )
  return lines.join(';\n')
}

/** 跑一块：几百路的图写进文件用 -filter_complex_script 交给它，命令行只背输入清单 */
async function runFfmpegChunk(
  units: TimelineUnit[],
  tempDir: string,
  graphName: string,
  outputPath: string,
  encodeArgs: string[]
): Promise<void> {
  const args: string[] = []
  for (const unit of units) args.push('-i', unit.filePath)
  const graphPath = join(tempDir, graphName)
  await writeFile(graphPath, renderChunkGraph(units, '[out]'))
  await runFfmpeg([...args, '-filter_complex_script', graphPath, '-map', '[out]', ...encodeArgs, outputPath])
}

/** 从 WAV 里读 data 块的字节数，换算成精确秒数——不经过 ffprobe 的容器估算 */
function pcmSeconds(wav: Buffer): number {
  let offset = 12 // 跳过 RIFF/WAVE 与第一个 fmt 块头
  while (offset + 8 <= wav.length) {
    const id = wav.toString('latin1', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') return Math.floor(size / 2) / PCM_SAMPLE_RATE
    offset += 8 + size + (size % 2)
  }
  return 0
}

/**
 * 一段配音解成统一参数的 PCM，并用解出来的样本数当它的时长。
 * 为什么不能用 ffprobe 报的 mp3 时长：那是按码率估的容器长度，含 LAME 的前后填充，解码时会被丢掉
 * ——实测 0.5 秒的片段报成 0.549 秒。每段的落点都是从上一段的长度推出来的，这几十毫秒会一段一段
 * 累起来（300 段就是十几秒），所以铺轴用的时长必须自己数解码出来的采样。
 */
async function toMeasuredPcm(clip: TTSClip, index: number, tempDir: string): Promise<TTSClip> {
  const wavPath = join(tempDir, `voice-pcm-${String(index).padStart(4, '0')}.wav`)
  await runFfmpeg([
    '-i',
    clip.filePath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(PCM_SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    wavPath,
  ])
  return { ...clip, filePath: wavPath, duration: pcmSeconds(await readFile(wavPath)) }
}

/**
 * 把逐段成品拼成一条对齐时间轴的配音轨。
 * 每段先归一到 44.1k 单声道 PCM，再按时轴垫静音串起来，整条只在最后重编码一次 mp3
 * （剪辑软件都吃，也不会 mp3 → mp3 来回掉质量）。
 * 超出命令行字符预算时先分块落无损 WAV、最后只把块串起来——多一道无损封装，不多一次有损转码。
 */
async function assembleVoiceTrack(clips: TTSClip[], tempDir: string): Promise<VoiceTrack> {
  if (clips.length === 0) throw new Error('一段都没合成成功，没有可以拼起来的音频')

  const measured: TTSClip[] = []
  for (let index = 0; index < clips.length; index++) {
    measured.push(await toMeasuredPcm(clips[index], index, tempDir))
  }

  const { placements, totalDuration } = planPlacements(measured)
  const chunks = packChunks(buildTimelineUnits(placements))
  const filePath = join(tempDir, 'voice-track.mp3')
  const mp3Args = ['-c:a', 'libmp3lame', '-b:a', '192k']

  if (chunks.length === 1) {
    await runFfmpegChunk(chunks[0], tempDir, 'filtergraph.txt', filePath, mp3Args)
  } else {
    const chunkWavs: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      const wavPath = join(tempDir, `voice-chunk-${String(i).padStart(3, '0')}.wav`)
      await runFfmpegChunk(chunks[i], tempDir, `filtergraph-${i}.txt`, wavPath, ['-c:a', 'pcm_s16le'])
      chunkWavs.push(wavPath)
    }
    await runFfmpegChunk(
      chunkWavs.map((wav) => ({ filePath: wav, argChars: wav.length + 4, silenceSamples: 0 })),
      tempDir,
      'filtergraph-final.txt',
      filePath,
      mp3Args
    )
  }

  const { duration } = await probeFile(filePath)
  const info = await stat(filePath)
  const originalEnd = placements.reduce((max, p) => Math.max(max, p.clip.endTime), 0)
  const pushedCount = placements.filter((p) => p.pushed).length
  const estimatedCount = placements.filter((p) => p.estimated).length

  logger.info('TTS', 'Voice track assembled', {
    segments: placements.length,
    chunks: chunks.length,
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
 * 几百段的图要跑一阵，界面那时候不能还写着「第 137/137 段」。
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
