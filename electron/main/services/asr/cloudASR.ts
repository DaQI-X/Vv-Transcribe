/**
 * 云端 ASR 转写提供者
 * 调服务商的转写接口；这一家发成什么形状由 `asrVendor.buildAsrRequest` 决定，
 * 设置里那颗「测试连接」走的是同一个函数。
 * 默认档仍是 OpenAI 兼容（`/v1/audio/transcriptions`），可自定义 apiBase 对接任何兼容服务。
 */
import type { ASRProvider, ASRSegment, ASRProgress } from './types'
import { toSimplified } from './simplifyChinese'
import { asrFileProblem, buildAsrRequest } from './asrVendor'

interface CloudASRConfig {
  apiKey: string
  apiBase: string
  model: string
  /** 厂商书签（`asrVendor` 归一化后的值）；留空按 OpenAI 兼容发 */
  vendor?: string
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
    const { probeFile } = await import('../audioProcessor')

    const audioBuffer = await readFile(audioFilePath)
    const fileName = basename(audioFilePath)
    // 时长只用来判「这一家收不收这么长」，探不到就当没这条信息（体积那一条仍然拦），
    // 不能因为 ffprobe 失败就把一次本来能成的转写拦下来
    const seconds = await probeFile(audioFilePath)
      .then((meta) => meta.duration)
      .catch(() => undefined)

    // 一家的字段名与路径都在这一个调用里问出来，两个调用点（这里 + 测试连接）不许各拼一遍
    const shape = buildAsrRequest(this.config.vendor, {
      apiBase: this.config.apiBase,
      model: this.config.model,
      language: options.language ?? '',
    })

    // 上限拦在发出去之前：MiniMax 的 500 秒对一整段媒体是常态而非例外，
    // 让它自己回一句对方原话，用户在进度条跑完之前什么也看不到
    const fileProblem = asrFileProblem(this.config.vendor, { bytes: audioBuffer.length, seconds })
    if (fileProblem) throw new Error(fileProblem)

    const formData = new FormData()
    const blob = new Blob([audioBuffer])
    formData.append('file', blob, fileName)
    for (const [key, value] of Object.entries(shape.fields)) {
      formData.append(key, value)
    }

    options.onProgress?.({ percent: 10 })

    const response = await fetch(shape.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        // 这一家要放在头部的项（例如 MiniMax 的语言）由适配层给，这里不猜
        ...shape.headers,
      },
      body: formData,
      signal: this.abortController.signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      // 带上最终 URL：用户照文档粘的就是这条路径，看不出应用在后面又接了一层，
      // 「404」这三个字本身没法定位，念出打出去的那条地址才能自查
      throw new Error(
        `云端转写接口返回 ${response.status}（POST ${shape.url}）：${errorText.slice(0, 200) || '对方没有附带说明'}`
      )
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
