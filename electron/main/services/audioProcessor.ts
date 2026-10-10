/**
 * 音频处理服务
 * 基于 FFmpeg 实现音频提取和探测：
 * - probeFile: 读取音视频文件的元数据（时长、编码、声道、采样率）
 * - extractAudio: 将任意音视频文件转换为 16kHz 单声道 PCM WAV（ASR 所需格式）
 * - cleanupTemp: 清理临时文件目录
 */
import ffmpeg from 'fluent-ffmpeg'
import ffmpegPath from '@ffmpeg-installer/ffmpeg'
import { mkdir, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

ffmpeg.setFfmpegPath(ffmpegPath.path)

export interface AudioMetadata {
  duration: number
  codec: string
  channels: number
  sampleRate: number
}

export interface ExtractResult {
  wavPath: string
  tempDir: string
  metadata: AudioMetadata
}

export function probeFile(filePath: string): Promise<AudioMetadata> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(new Error(`无法读取文件信息: ${err.message}`))
        return
      }
      const audioStream = metadata.streams.find((s) => s.codec_type === 'audio')
      resolve({
        duration: metadata.format.duration ?? 0,
        codec: audioStream?.codec_name ?? 'unknown',
        channels: audioStream?.channels ?? 1,
        sampleRate: audioStream?.sample_rate ?? 16000,
      })
    })
  })
}

export async function extractAudio(filePath: string): Promise<ExtractResult> {
  const tempDir = join(tmpdir(), `transcribe-${randomUUID()}`)
  await mkdir(tempDir, { recursive: true })

  const wavPath = join(tempDir, 'audio.wav')

  const metadata = await probeFile(filePath)

  await new Promise<void>((resolve, reject) => {
    ffmpeg(filePath)
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(new Error(`音频提取失败: ${err.message}`)))
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
