/**
 * 音频处理服务
 * 基于 FFmpeg 实现音频提取和探测：
 * - probeFile: 读取音视频文件的元数据（时长、编码、声道、采样率）
 * - extractAudio: 将任意音视频文件转换为 16kHz 单声道 PCM WAV（ASR 所需格式）
 * - cleanupTemp: 清理临时文件目录
 */
import { app } from 'electron'
import ffmpeg from 'fluent-ffmpeg'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, rm, access, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { logger } from './logger'
import { terminateWithEscalation, KILL_GRACE_MS } from './childKill'

// 手动解析 ffmpeg 和 ffprobe 路径，避免 asar 打包后 require.resolve 失效
function getBinaryPath(binaryName: string): string {
  const isPackaged = process.env.NODE_ENV === 'production' || app.isPackaged
  const platform = process.platform
  const arch = process.arch
  const binary = platform === 'win32' ? `${binaryName}.exe` : binaryName

  logger.debug('AudioProcessor', `Getting ${binaryName} path`, { isPackaged, platform, arch, resourcesPath: process.resourcesPath })

  if (isPackaged) {
    const unpackedPath = join(
      process.resourcesPath || '',
      'app.asar.unpacked',
      'node_modules',
      `@${binaryName}-installer`,
      `${platform}-${arch}`,
      binary
    )
    logger.debug('AudioProcessor', `Trying unpacked path: ${unpackedPath}`)
    if (existsSync(unpackedPath)) {
      logger.info('AudioProcessor', `Found ${binaryName} at: ${unpackedPath}`)
      return unpackedPath
    }
    logger.warn('AudioProcessor', `Unpacked path not found: ${unpackedPath}`)
  }

  try {
    const resolved = require.resolve(`@${binaryName}-installer/${platform}-${arch}/${binary}`)
    logger.info('AudioProcessor', `Resolved ${binaryName} path: ${resolved}`)
    return resolved
  } catch (err: any) {
    logger.error('AudioProcessor', `Failed to resolve ${binaryName}`, err.message)
    throw new Error(`无法找到 ${binaryName} 二进制文件`)
  }
}

/**
 * 需要直接 spawn ffmpeg 的调用方走这里拿路径
 * （fluent-ffmpeg 的链式写法接不了几百路输入的复杂 filtergraph，但路径解析规则不该有第二份）。
 */
export function resolveFfmpegBinary(): string {
  return getBinaryPath('ffmpeg')
}

// 延迟初始化，避免 app 未就绪时访问
let ffmpegInitialized = false
/** ffprobe 现在由本文件自己 spawn（见 probeFile），所以要把解析出来的路径留住 */
let ffprobeBinary = ''
function ensureFfmpegPaths() {
  if (ffmpegInitialized) return
  logger.info('AudioProcessor', 'Initializing ffmpeg paths...')
  const ffmpegPath = getBinaryPath('ffmpeg')
  const ffprobePath = getBinaryPath('ffprobe')
  logger.info('AudioProcessor', 'Setting ffmpeg paths', { ffmpegPath, ffprobePath })
  ;(ffmpeg as any).setFfmpegPath(ffmpegPath)
  ;(ffmpeg as any).setFfprobePath(ffprobePath)
  ffprobeBinary = ffprobePath
  ffmpegInitialized = true
  logger.info('AudioProcessor', 'FFmpeg paths initialized successfully')
}

export interface AudioMetadata {
  duration: number
  codec: string
  channels: number
  sampleRate: number
  hasAudio: boolean
}

export interface ExtractResult {
  wavPath: string
  tempDir: string
  metadata: AudioMetadata
}

/** 调用方能递进来的控制项只有一样：这一单能不能被取消 */
export interface AudioJobOptions {
  signal?: AbortSignal
}

/**
 * ffprobe 探一个本地文件通常在 1 秒内回，30 秒是给「素材还在移动硬盘/网络盘上」留的余量。
 * 这条时限是 probeFile 唯一的出口：以前走的是 fluent-ffmpeg 的 ffprobe()，它不把子进程句柄
 * 递出来，一旦 ffprobe 卡在 I/O 上那个回调就永远不来，界面停在「读取文件信息」那一步，
 * 而提取阶段的取消按钮那时候还没长出来。
 */
const PROBE_TIMEOUT_MS = 30_000

/**
 * 提取阶段判断卡没卡，看的是「输出文件还在不在长」，不是「跑了多久」。
 * 按时长判死的闸在这里一定会误杀：一次提取要多久由素材长度和这台机器的速度共同决定，
 * 几小时的素材在老 Intel 上跑十几分钟是正常活儿。而 16k 单声道 16bit 的 WAV 是每秒稳定
 * 长 32KB 的，连续 90 秒一个字节都不涨就只可能是卡在 I/O 或解码上了。
 */
const EXTRACT_STALL_MS = 90_000
/** 上面那个判断多久看一次盘 */
const EXTRACT_POLL_MS = 5_000

/**
 * ffprobe 的 JSON 把 duration / sample_rate 这些数都写成字符串（"12.34"、"44100"），
 * 而 AudioMetadata 那三个字段承诺的是数字：ttsService 直接拿 duration 去 toFixed(2)，
 * 回来一个字符串就是整批配音在最后一步炸。
 * 拿不出正数（缺失、"N/A"、负数）一律回 0——0 在这套代码里已经是「不知道有多长」的既有口径，
 * 调用方按它分叉的代码都写好了（transcribeJob 把 0 记成 null，cloudASR 把 undefined 当没这条信息）。
 */
function positiveNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function probeFile(filePath: string, options: AudioJobOptions = {}): Promise<AudioMetadata> {
  logger.serviceCall('AudioProcessor', 'probeFile', { name: basename(filePath) })
  ensureFfmpegPaths()
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(
        ffprobeBinary,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
      )
    } catch (err) {
      reject(new Error(`没能启动 ffprobe：${err instanceof Error ? err.message : String(err)}`))
      return
    }

    // 收 Buffer 而不是直接字符串累加：标题里的中文可能被切在两个块中间，按块拼完再解码才不会有乱码
    const chunks: Buffer[] = []
    let stderr = ''
    let settled = false
    let outcome: 'timeout' | 'canceled' | null = null

    const stopWaiting = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      stopWaiting()
      fn()
    }
    const onAbort = () => {
      outcome = 'canceled'
      terminateWithEscalation(child, KILL_GRACE_MS, 'ffprobe')
    }
    const timer = setTimeout(() => {
      outcome = 'timeout'
      terminateWithEscalation(child, KILL_GRACE_MS, 'ffprobe')
    }, PROBE_TIMEOUT_MS)
    timer.unref()
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (d) => chunks.push(Buffer.from(d)))
    child.stderr?.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-2000)
    })
    child.on('error', (err) => {
      logger.serviceError('AudioProcessor', 'probeFile', err)
      settle(() => reject(new Error(`没能启动 ffprobe：${err.message}`)))
    })
    child.on('close', (code) => {
      if (outcome === 'canceled') {
        settle(() => reject(new Error('文件探测已取消')))
        return
      }
      if (outcome === 'timeout') {
        settle(() =>
          reject(new Error(`读取文件信息超时（${PROBE_TIMEOUT_MS / 1000} 秒）。这个文件可能在移动硬盘或网络盘上，请先拷到本机再试`))
        )
        return
      }
      if (code !== 0) {
        logger.warn('AudioProcessor', 'ffprobe exited non-zero', { code, stderr: stderr.slice(-400) })
        settle(() => reject(new Error(`无法读取文件信息: ${stderr.trim().slice(-300) || `ffprobe 退出码 ${code}`}`)))
        return
      }
      let raw: { format?: { duration?: unknown }; streams?: Array<Record<string, unknown>> }
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch (err) {
        logger.serviceError('AudioProcessor', 'probeFile', err)
        settle(() => reject(new Error('无法读取文件信息: ffprobe 的输出不是可以解析的 JSON')))
        return
      }
      const audioStream = raw.streams?.find((s) => s.codec_type === 'audio')
      logger.info('AudioProcessor', 'ffprobe success', { duration: raw.format?.duration })
      settle(() =>
        resolve({
          duration: positiveNumber(raw.format?.duration),
          codec: typeof audioStream?.codec_name === 'string' ? audioStream.codec_name : 'unknown',
          channels: positiveNumber(audioStream?.channels) || 1,
          sampleRate: positiveNumber(audioStream?.sample_rate) || 16000,
          hasAudio: !!audioStream,
        })
      )
    })
  })
}

/** fluent-ffmpeg 的链式返回值，只用来给下面的 kill 兜底留个类型 */
type FfmpegCommand = ReturnType<typeof ffmpeg>

/**
 * 中止一次提取。
 * 子进程句柄是从 command.ffmpegProc 上取的，而这个字段在进程退了之后会被库自己删掉，
 * 所以取消来得正好卡在收尾那一刻，它可能已经是 null 了——那种情况退回库的 kill()，
 * 让它去收自己那道 spawn，比自己拿着空句柄装成「已经杀过了」诚实。
 */
function stopFfmpeg(command: FfmpegCommand, proc: ChildProcess | null): void {
  if (proc) terminateWithEscalation(proc, KILL_GRACE_MS, 'ffmpeg')
  else command.kill('SIGKILL')
}

export async function extractAudio(filePath: string, options: AudioJobOptions = {}): Promise<ExtractResult> {
  logger.serviceCall('AudioProcessor', 'extractAudio', { name: basename(filePath) })
  const tempDir = join(tmpdir(), `transcribe-${randomUUID()}`)
  await mkdir(tempDir, { recursive: true })
  logger.debug('AudioProcessor', 'Created temp directory', { tempDir })

  const wavPath = join(tempDir, 'audio.wav')

  const metadata = await probeFile(filePath, options)
  logger.info('AudioProcessor', 'Audio metadata extracted', metadata)

  // 无音轨的视频直接交给 ffmpeg 会报 "Output file #0 does not contain any stream"
  // 提前拦截并给出用户可读的错误（经 IPC 冒泡为 toast）
  if (!metadata.hasAudio) {
    logger.warn('AudioProcessor', 'File has no audio stream', { name: basename(filePath) })
    await cleanupTemp(tempDir)
    throw new Error('该文件不包含音频轨道，无法转写')
  }

  await new Promise<void>((resolve, reject) => {
    logger.debug('AudioProcessor', 'Starting audio extraction...')
    const command = ffmpeg(filePath)
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .format('wav')

    let settled = false
    /** fluent-ffmpeg 在 spawn 之后把子进程挂在 ffmpegProc 上，退场时自己删掉 */
    let proc: ChildProcess | null = null
    let poll: NodeJS.Timeout | null = null
    /** 盘上字节数最后一次变化的时刻；起表就把它算作「刚开始」 */
    let lastSize = -1
    let grewAt = Date.now()

    const stopWatching = () => {
      if (poll) clearInterval(poll)
      poll = null
      options.signal?.removeEventListener('abort', onAbort)
    }
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      stopWatching()
      fn()
    }
    /**
     * 失败这一支必须自己把临时目录带走：调用方这时候拿不到 tempDir，没有任何人会再来清它。
     * 一次卡死的提取能留下几百 MB，而每次都是新的 uuid，攒下去就是把盘喂给一堆没人认领的垃圾。
     */
    const fail = (message: string) => {
      if (settled) return
      void cleanupTemp(tempDir)
      finish(() => reject(new Error(message)))
    }
    const onAbort = () => {
      if (settled) return
      logger.info('AudioProcessor', 'Audio extraction canceled by user')
      stopFfmpeg(command, proc)
      // 这句要能被调用方认出来是「用户自己按的」：transcribeJob 按同一句口径把它记成用户动作而不是故障
      fail('音频提取已取消')
    }
    poll = setInterval(() => {
      stat(wavPath)
        .then((s) => s.size)
        .catch(() => -1)
        .then((size) => {
          if (settled) return
          if (size > lastSize) {
            lastSize = size
            grewAt = Date.now()
            return
          }
          if (Date.now() - grewAt < EXTRACT_STALL_MS) return
          logger.warn('AudioProcessor', 'Audio extraction stalled', {
            bytes: Math.max(0, lastSize),
            stalledForMs: Date.now() - grewAt,
          })
          stopFfmpeg(command, proc)
          fail(
            `音频提取卡住了（${EXTRACT_STALL_MS / 1000} 秒没有任何进展），已中止。` +
              '素材如果在移动硬盘或网络盘上，请先拷到本机再重试'
          )
        })
    }, EXTRACT_POLL_MS)
    poll.unref()
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    command
      .on('start', () => {
        proc = (command as unknown as { ffmpegProc?: ChildProcess }).ffmpegProc ?? null
      })
      .on('end', () => {
        logger.info('AudioProcessor', 'Audio extraction completed')
        finish(() => resolve())
      })
      .on('error', (err: Error) => {
        logger.serviceError('AudioProcessor', 'extractAudio', err)
        fail(`音频提取失败: ${err.message}`)
      })
      .save(wavPath)
  })

  return { wavPath, tempDir, metadata }
}

export async function cleanupTemp(tempDir: string) {
  try {
    await access(tempDir)
    await rm(tempDir, { recursive: true, force: true })
  } catch {
    // temp dir already removed
  }
}
