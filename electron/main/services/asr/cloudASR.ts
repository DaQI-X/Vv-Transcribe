/**
 * 云端 ASR 转写提供者
 * 调服务商的转写接口；这一家发成什么形状由 `asrVendor.buildAsrRequest` 决定，
 * 设置里那颗「测试连接」走的是同一个函数。
 * 默认档仍是 OpenAI 兼容（`/v1/audio/transcriptions`），可自定义 apiBase 对接任何兼容服务。
 */
import type { ASRProvider, ASRSegment, ASRProgress } from './types'
import { toSimplified } from './simplifyChinese'
import { asrFileProblem, buildAsrRequest, readAsrResponse } from './asrVendor'

interface CloudASRConfig {
  apiKey: string
  apiBase: string
  model: string
  /** 厂商书签（`asrVendor` 归一化后的值）；留空按 OpenAI 兼容发 */
  vendor?: string
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

    // 上限拦在拼请求之前：MiniMax 的 500 秒对一整段媒体是常态而非例外，
    // 先拼再拦等于白拼一次表单、白读一份音频，才在进度条上告诉用户这段不收
    const fileProblem = asrFileProblem(this.config.vendor, { bytes: audioBuffer.length, seconds })
    if (fileProblem) throw new Error(fileProblem)

    // 一家的字段名与头部（含鉴权）都在这一个调用里问出来，两个调用点（这里 + 测试连接）不许各拼一遍
    const shape = buildAsrRequest(this.config.vendor, {
      apiBase: this.config.apiBase,
      apiKey: this.config.apiKey,
      model: this.config.model,
      // 界面选的那一项每次都会带过来；不带就是让服务商按自动检测跑（各家语言放在哪一层见 asrVendor）
      language: options.language ?? '',
    })

    const form = new FormData()
    form.append('file', new Blob([audioBuffer]), fileName)
    for (const [key, value] of Object.entries(shape.fields)) {
      form.append(key, value)
    }

    options.onProgress?.({ percent: 10 })

    const response = await fetch(shape.url, {
      method: 'POST',
      // 鉴权与这一家的协议头全在 shape.headers 里，这里不补 Bearer：
      // 补一次就是「自检发一份头、真转写发另一份」，而那条分歧正是 #220/#227 记的东西
      headers: shape.headers,
      body: form,
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

    const read = await readAsrResponse(response)

    const segments: ASRSegment[] = read.segments.map((seg) => ({
      startTime: seg.start,
      endTime: seg.end,
      text: toSimplified(seg.text.trim(), options.language),
      confidence: seg.confidence,
    }))

    if (segments.length === 0 && read.text) {
      segments.push({
        startTime: 0,
        endTime: read.duration,
        text: toSimplified(read.text.trim(), options.language),
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
