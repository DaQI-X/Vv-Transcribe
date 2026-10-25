/**
 * 云端 ASR 转写提供者
 * 调用 OpenAI Whisper API 兼容接口进行语音转写
 * 支持自定义 apiBase，可对接任何 OpenAI 兼容的 ASR 服务
 */
import type { ASRProvider, ASRSegment, ASRProgress } from './types'
import { toSimplified } from './simplifyChinese'

interface CloudASRConfig {
  apiKey: string
  apiBase: string
  model: string
}

interface OpenAISegment {
  start: number
  end: number
  text: string
  avg_logprob?: number
}

interface OpenAIResponse {
  segments?: OpenAISegment[]
  text?: string
  duration?: number
}

export class CloudASRProvider implements ASRProvider {
  readonly name = 'cloud'
  readonly type = 'cloud' as const
  private abortController: AbortController | null = null
  private config: CloudASRConfig

  constructor(config: CloudASRConfig) {
    this.config = config
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.apiKey
  }

  async transcribe(
    audioFilePath: string,
    options: {
      language?: string
      onProgress?: (progress: ASRProgress) => void
      signal?: AbortSignal
    },
  ): Promise<ASRSegment[]> {
    this.abortController = new AbortController()

    const combinedSignal = options.signal
    if (combinedSignal) {
      combinedSignal.addEventListener('abort', () => {
        this.abortController?.abort()
      })
    }

    const { readFile } = await import('node:fs/promises')
    const { basename } = await import('node:path')

    const audioBuffer = await readFile(audioFilePath)
    const fileName = basename(audioFilePath)

    const formData = new FormData()
    const blob = new Blob([audioBuffer])
    formData.append('file', blob, fileName)
    formData.append('model', this.config.model || 'whisper-1')
    formData.append('response_format', 'verbose_json')
    formData.append('timestamp_granularities[0]', 'segment')
    if (options.language) {
      formData.append('language', options.language)
    }

    options.onProgress?.({ percent: 10 })

    const response = await fetch(`${this.config.apiBase}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: formData,
      signal: this.abortController.signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`ASR API 请求失败 (${response.status}): ${errorText}`)
    }

    options.onProgress?.({ percent: 80 })

    const result = (await response.json()) as OpenAIResponse

    const segments: ASRSegment[] = (result.segments ?? []).map((seg) => ({
      startTime: seg.start,
      endTime: seg.end,
      text: toSimplified(seg.text.trim(), options.language),
      confidence: seg.avg_logprob != null ? Math.min(1, Math.max(0, 1 + seg.avg_logprob * 0.1)) : undefined,
    }))

    if (segments.length === 0 && result.text) {
      segments.push({
        startTime: 0,
        endTime: result.duration ?? 0,
        text: toSimplified(result.text.trim(), options.language),
      })
    }

    options.onProgress?.({ percent: 100 })

    return segments
  }

  cancel(): void {
    this.abortController?.abort()
    this.abortController = null
  }
}
