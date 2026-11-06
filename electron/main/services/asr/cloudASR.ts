/**
 * 云端 ASR 转写提供者
 * 调服务商的转写接口；这一家发成什么形状由 `asrVendor.buildAsrRequest` 决定，
 * 设置里那颗「测试连接」走的是同一个函数。
 * 默认档仍是 OpenAI 兼容（`/v1/audio/transcriptions`），可自定义 apiBase 对接任何兼容服务。
 *
 * 讯飞那一档不走上面那条（#343）：它是「上传换订单号 → 轮询取结果」两步异步接口，
 * 形状与签名收在 `iflytekAsr.ts`，这里只按 `asrVendorUsesOrderFlow` 分叉，不自己拼一份。
 */
import type { ASRProvider, ASRSegment, ASRProgress } from './types'
import { toSimplified } from './simplifyChinese'
import { asrFileProblem, asrVendorUsesOrderFlow, buildAsrRequest, readAsrResponse } from './asrVendor'
import { iflytekFailTypeMessage, runIflytekOrderFlow } from './iflytekAsr'
import { logger } from '../logger'

const TAG = 'CloudASR'

interface CloudASRConfig {
  apiKey: string
  apiBase: string
  model: string
  /** 厂商书签（`asrVendor` 归一化后的值）；留空按 OpenAI 兼容发 */
  vendor?: string
  /** 讯飞那一档要的另外两把（AppID / APISecret）；走 multipart 的那几家没有这两项 */
  appId?: string
  apiSecret?: string
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
    // 讯飞要三把凭据齐了才算得出签名。缺任何一把就报「不可用」，由 asrManager 落回本地
    // （与缺 apiKey 时同一个口径），而不是发一趟必然回 100009 的请求——那一趟的报错
    // 说的是「签名校验不通过」，而真实原因是「有一格没填」，用户按前者查会一直查错方向
    if (asrVendorUsesOrderFlow(this.config.vendor)) {
      return Boolean(this.config.appId?.trim() && this.config.apiKey.trim() && this.config.apiSecret?.trim())
    }
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

    // 讯飞那一档从这儿分出去：它不发 multipart，也不是一次 POST 就完（见 transcribeByOrder）
    if (asrVendorUsesOrderFlow(this.config.vendor)) {
      return this.transcribeByOrder(audioBuffer, fileName, options)
    }

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

  /**
   * 讯飞那一档：上传换订单号 → 轮询 → 解析。协议与签名全在 `iflytekAsr.ts`，
   * 这里只做三件事：把凭据递过去、把阶段说给界面听、把结果映射成 `ASRSegment`。
   */
  private async transcribeByOrder(
    audio: Uint8Array,
    fileName: string,
    options: {
      language?: string
      onProgress?: (progress: ASRProgress) => void
      signal?: AbortSignal
    },
  ): Promise<ASRSegment[]> {
    options.onProgress?.({ percent: 10 })

    const flow = await runIflytekOrderFlow({
      apiBase: this.config.apiBase,
      credentials: {
        appId: this.config.appId ?? '',
        apiKey: this.config.apiKey,
        apiSecret: this.config.apiSecret ?? '',
      },
      fileName,
      audio,
      signal: this.abortController?.signal,
      onOrder: (info) => {
        // 只在拿到订单号那一趟记一次：轮询一小时会有上千趟，逐趟记只会把真正有用的那条冲掉。
        // 订单号要留——用户来说「转写卡住了」时，这是唯一能拿去对方后台查的东西
        if (info.polls === 0) logger.info(TAG, 'Iflytek order accepted', { orderId: info.orderId })
        // 阶段名而不是百分比：对方只给一个没有实测数的 taskEstimateTime，按它换算就是编数（见 ASRStage）
        options.onProgress?.({ percent: 20, stage: 'waiting_order' })
      },
    })

    if (!flow.completed) {
      throw new Error(
        `讯飞转写等到上限还没出结果（订单号 ${flow.orderId}，已查询 ${flow.polls} 次）。` +
          '这一家收长音频本来就要排队等，可以拿这个订单号稍后再查，或改用别的服务'
      )
    }
    if (flow.failType !== 0) {
      // 静音文件也走这一条：真转写里它意味着「这一段对方什么都没听出来」，
      // 交一份空字幕给编辑器等于让用户对着空白猜原因（自检那边把这一档判成通过，两处口径不同是有意的）
      throw new Error(`讯飞这一单没转出结果：${iflytekFailTypeMessage(flow.failType)}（订单号 ${flow.orderId}）`)
    }

    const segments: ASRSegment[] = flow.segments.map((seg) => ({
      startTime: seg.start,
      endTime: seg.end,
      // 繁简这一层不看 `options.language`：界面上那个「转写语言」对这一家无效（它只收
      // autodialect／autominor，不收 zh/en 那套短码），而它的输出永远是中文（可能夹英文）。
      // 照抄别家的传法，会在用户把语言设成 ja/en 时把该做的繁→简悄悄跳过
      text: toSimplified(seg.text.trim(), undefined),
      confidence: seg.confidence,
    }))

    options.onProgress?.({ percent: 100 })

    return segments
  }

  cancel(): void {
    this.abortController?.abort()
    this.abortController = null
  }
}
