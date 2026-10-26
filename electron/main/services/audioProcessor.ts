/**
 * 音频处理服务
 * 基于 FFmpeg 实现音频提取和探测：
 * - probeFile: 读取音视频文件的元数据（时长、编码、声道、采样率）
 * - extractAudio: 将任意音视频文件转换为 16kHz 单声道 PCM WAV（ASR 所需格式）
 * - cleanupTemp: 清理临时文件目录
 */
import { app } from 'electron'
import ffmpeg from 'fluent-ffmpeg'
import { mkdir, rm, access } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { logger } from './logger'

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
function ensureFfmpegPaths() {
  if (ffmpegInitialized) return
  logger.info('AudioProcessor', 'Initializing ffmpeg paths...')
  const ffmpegPath = getBinaryPath('ffmpeg')
  const ffprobePath = getBinaryPath('ffprobe')
  logger.info('AudioProcessor', 'Setting ffmpeg paths', { ffmpegPath, ffprobePath })
  ;(ffmpeg as any).setFfmpegPath(ffmpegPath)
  ;(ffmpeg as any).setFfprobePath(ffprobePath)
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

export function probeFile(filePath: string): Promise<AudioMetadata> {
  logger.serviceCall('AudioProcessor', 'probeFile', { name: basename(filePath) })
  ensureFfmpegPaths()
  return new Promise((resolve, reject) => {
    logger.debug('AudioProcessor', 'Calling ffmpeg.ffprobe...')
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        logger.serviceError('AudioProcessor', 'probeFile', err)
        reject(new Error(`无法读取文件信息: ${err.message}`))
        return
      }
      logger.info('AudioProcessor', 'ffprobe success', { duration: metadata.format.duration })
      const audioStream = metadata.streams.find((s) => s.codec_type === 'audio')
      resolve({
        duration: metadata.format.duration ?? 0,
        codec: audioStream?.codec_name ?? 'unknown',
        channels: audioStream?.channels ?? 1,
        sampleRate: audioStream?.sample_rate ?? 16000,
        hasAudio: !!audioStream,
      })
    })
  })
}

export async function extractAudio(filePath: string): Promise<ExtractResult> {
  logger.serviceCall('AudioProcessor', 'extractAudio', { name: basename(filePath) })
  const tempDir = join(tmpdir(), `transcribe-${randomUUID()}`)
  await mkdir(tempDir, { recursive: true })
  logger.debug('AudioProcessor', 'Created temp directory', { tempDir })

  const wavPath = join(tempDir, 'audio.wav')

  const metadata = await probeFile(filePath)
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
    ffmpeg(filePath)
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('end', () => {
        logger.info('AudioProcessor', 'Audio extraction completed')
        resolve()
      })
      .on('error', (err: Error) => {
        logger.serviceError('AudioProcessor', 'extractAudio', err)
        reject(new Error(`音频提取失败: ${err.message}`))
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
