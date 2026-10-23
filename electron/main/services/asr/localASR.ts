/**
 * 本地 ASR 转写提供者
 * 通过 HTTP 调用本地 Python ASR 服务（faster-whisper + FastAPI，运行在 localhost:8000）
 * 支持进度回调和任务取消
 */
import { basename } from 'node:path'
import type { ASRProvider, ASRSegment, ASRProgress, ASRStage } from './types'

const PYTHON_ASR_URL = 'http://localhost:8000'

/**
 * 首次转写要在 loading_model 阶段从 hf-mirror 拉约 150MB 权重，弱网/离线时 Python 抛回来的是
 * huggingface_hub 的英文报错原文，用户看到的是「一段看不懂的英文 + 只能重新上传」。
 * 阶段号已经由引擎随流下发，所以这里能确定是哪一步挂的，只补「怎么办」，原文进日志。
 */
function explainLocalFailure(detail: string, stage: ASRStage | null): string {
  if (stage !== 'loading_model') return detail || '本地转写失败'
  console.error('[LocalASR] Whisper model load failed:', detail)
  return (
    '首次使用需要下载语音模型（约 150MB），这一步没有完成。' +
    '请确认网络可访问 hf-mirror.com（国内直连即可，不需要代理）后重试；' +
    '模型只需成功下载一次，之后本机离线可用。'
  )
}

export class LocalASRProvider implements ASRProvider {
  readonly name = 'local'
  readonly type = 'local' as const
  private cancelled = false

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${PYTHON_ASR_URL}/health`, { 
        method: 'GET',
        signal: AbortSignal.timeout(2000)
      })
      return response.ok
    } catch (err) {
      console.warn('[LocalASR] Python service not available:', err)
      return false
    }
  }

  async transcribe(
    audioFilePath: string,
    options: {
      language?: string
      onProgress?: (progress: ASRProgress) => void
      signal?: AbortSignal
    },
  ): Promise<ASRSegment[]> {
    this.cancelled = false

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        this.cancelled = true
      })
    }

    options.onProgress?.({ percent: 10 })

    console.log('[LocalASR] Calling Python ASR service:', { name: basename(audioFilePath), language: options.language })

    const response = await fetch(`${PYTHON_ASR_URL}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_path: audioFilePath,
        language: options.language || 'zh',
      }),
      signal: options.signal,
    })

    if (this.cancelled) throw new Error('转写已取消')

    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { detail?: string } | null
      throw new Error(error?.detail || `Python ASR service error: ${response.status}`)
    }

    if (!response.body) throw new Error('本地 ASR 服务未返回数据流')

    const segments: ASRSegment[] = []
    let audioDuration = 0
    let completed = false
    let lastStage: ASRStage | null = null

    const consume = (line: string) => {
      if (!line) return
      const event = JSON.parse(line) as {
        type?: string
        duration?: number
        startTime?: number
        endTime?: number
        text?: string
        detail?: string
        stage?: ASRStage
      }

      if (event.type === 'start') {
        audioDuration = event.duration ?? 0
      } else if (event.type === 'status') {
        // 加载/下载模型期间一条片段也不会有，只能把阶段透给宿主
        lastStage = event.stage ?? lastStage
        options.onProgress?.({ percent: 10, stage: event.stage })
      } else if (event.type === 'segment') {
        const segment: ASRSegment = {
          startTime: event.startTime ?? 0,
          endTime: event.endTime ?? 0,
          text: event.text ?? '',
        }
        segments.push(segment)
        // 真实进度 = 已转写到的音频位置 / 音频总时长，映射到 10..95，收尾交给完成信号
        const ratio = audioDuration > 0 ? Math.min(1, segment.endTime / audioDuration) : 0
        options.onProgress?.({ percent: 10 + ratio * 85, segment })
      } else if (event.type === 'done') {
        completed = true
      } else if (event.type === 'error') {
        throw new Error(explainLocalFailure(event.detail || '', lastStage))
      }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    // 用户取消时 signal 会让 read() 直接抛 AbortError，比旧实现更早真正停下推理
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })

      let cut = buffer.indexOf('\n')
      while (cut >= 0) {
        consume(buffer.slice(0, cut).trim())
        buffer = buffer.slice(cut + 1)
        cut = buffer.indexOf('\n')
      }
    }
    consume(buffer.trim())

    if (this.cancelled) throw new Error('转写已取消')
    // 没收到 done 就断流说明服务中途挂了，把半截结果当成功返回比报错更糟
    if (!completed) throw new Error('本地转写服务中断，结果不完整')

    console.log('[LocalASR] Transcription completed, segments:', segments.length)
    options.onProgress?.({ percent: 100 })

    return segments
  }

  cancel(): void {
    this.cancelled = true
  }
}
