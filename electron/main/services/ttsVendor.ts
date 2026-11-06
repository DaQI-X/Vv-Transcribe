/**
 * 云端配音的厂商适配层（1.1.1，#224）。
 *
 * 只做两件事：把「文本 + 模型 + 音色 + 倍速」拼成这一家要的请求，把这一家的响应换成音频字节。
 * 真实合成（ttsService）与设置里那颗「测试连接」（connectionTestService）共用这两个函数——
 * 分叉过一次就是「自检报可用、批量配音撞 400」，#220/#227 记的就是这类分歧。
 *
 * 四条口径：
 * - OpenAI 兼容是**默认档**，也是磁盘上没有 provider 那一项时（1.1.0 及更早建出来的方案）的读法。
 *   海外用户手上多半只有这一家，所以它不是备选，是「什么都不选就走的那条路」。
 * - 音频一律在这里换成 Buffer 再交给调用方落盘。三家没有一家把音频当裸字节流发回来：
 *   MiniMax 发的是十六进制字符串，DashScope 非流式发的是一个 24 小时有效的签名地址。
 *   「响应体直接 writeFile」只对第一档成立，留着它就会往 .mp3 里写进一坨 JSON——
 *   用户在播放器里只会看到「加载失败」，而真因写在那坨 JSON 里。
 * - 服务商的错误原话必须能到用户眼前（1.1.0 定的口径）。这里因此对 MiniMax 多读一层：
 *   它可能 HTTP 200 而 `base_resp.status_code` 非 0，只看状态码就是把失败读成成功。
 * - 音色这一项各家都收，但必填性不一样：OpenAI 兼容可以整个不发这一项，另两家必填。
 *   必填不由这里拦（拦在这儿就等于替用户猜一份音色清单），它是 `ttsConfigProblem` 那条校验的事。
 */

/** 界面上「厂商」那格的取值；`openai` 同时是「留空/不认识」的落点 */
export type TtsVendorId = 'openai' | 'minimax' | 'dashscope'

const VENDOR_IDS: readonly string[] = ['openai', 'minimax', 'dashscope']

/**
 * 空串、老文件里没这一项、以及手改出来的怪值一律按 OpenAI 兼容处理。
 * 判严的收益是零：一个不认识的书签既不该让请求发不出去，也不该让界面凭空换一家网关。
 * 入参收 unknown 是因为它真的会是非字符串：settings.json 用户可以手改，
 * 自检那条 IPC 传来的又是渲染层的对象——在这里抛一句 TypeError，症状是「点测试连接没反应」。
 */
export function normalizeTtsVendor(raw: unknown): TtsVendorId {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return VENDOR_IDS.includes(value) ? (value as TtsVendorId) : 'openai'
}

/** 界面上说「这一套是哪家」时用的名字（错误原因里也要它，`minimax` 这种 id 用户不认） */
export const TTS_VENDOR_NAMES: Record<TtsVendorId, string> = {
  openai: 'OpenAI 兼容接口',
  minimax: 'MiniMax',
  dashscope: '阿里云百炼（CosyVoice）',
}

/** 一次调用要拼进请求体的东西：`apiBase` 必须是 `normalizeApiBase` 归一化过的那一份 */
export interface TtsSpeechInput {
  apiBase: string
  apiKey: string
  model: string
  /** 服务商的音色 id；空串＝没指定 */
  voice: string
  /** 倍速，1＝不变速。界面上只给 0.5–2 这几档（见 VOICE_SPEED_OPTIONS） */
  speed: number
  text: string
}

export interface TtsVendorRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/** 音频之外的回执（DashScope 的签名地址有效期、MiniMax 的计费字数），界面不需要，日志要 */
export interface TtsAudioResult {
  bytes: Buffer
  note?: string
}

/**
 * 「这一家的接口说清楚了为什么不行」——调用方原样递给界面，不再包一层「请求没能发出去」。
 * 区分得靠类型而不是消息前缀：上一版用 `startsWith('配音')` 判，厂商名一开头就不是那个字样了。
 */
export class TtsVendorError extends Error {}

function vendorError(message: string): never {
  throw new TtsVendorError(message)
}

/** 音频格式三家都用 mp3：本地铺轴那一步（ffmpeg concat）本来就按 mp3 解，不改这一项就不动它 */
const AUDIO_FORMAT = 'mp3'

/**
 * 倍速字段各家叫什么、能不能不发。
 * MiniMax 把它嵌在 `voice_setting` 里，DashScope 嵌在 `parameters` 里，OpenAI 在顶层。
 */
interface VendorShape {
  /** 从归一化后的 apiBase 之后接的路径，带满整段（拼法见 joinApiPath） */
  path: string
  /** 这一家的音色是不是必填（只用于错误提示的措辞，见 ttsConfigProblem） */
  voiceRequired: boolean
}

const VENDOR_SHAPES: Record<TtsVendorId, VendorShape> = {
  openai: { path: '/v1/audio/speech', voiceRequired: false },
  minimax: { path: '/v1/t2a_v2', voiceRequired: true },
  dashscope: { path: '/api/v1/services/audio/tts/SpeechSynthesizer', voiceRequired: true },
}

/** 这一家的音色是不是必填；界面与前置校验都按它分叉，别在渲染层再抄一份表 */
export function ttsVendorNeedsVoice(vendor: TtsVendorId): boolean {
  return VENDOR_SHAPES[vendor].voiceRequired
}

/**
 * 这一家要走的接口路径拼在归一化后的地址后面。
 *
 * `normalizeApiBase` 会把末尾的 `/v1` 剥掉（那是为 OpenAI 兼容地址准备的口径），于是照着阿里云文档
 * 粘进来的 `https://xxx/api/v1` 会变成 `https://xxx/api`，再接我们的路径就成了 `/api/api/v1/...`——
 * 用户拿到一句 404，而他填的明明是对方的原话。这里认这一次重复。
 */
function joinApiPath(apiBase: string, path: string): string {
  return apiBase.endsWith('/api') && path.startsWith('/api/') ? `${apiBase}${path.slice(4)}` : `${apiBase}${path}`
}

/**
 * 拼出这一家的一次请求。三家都走 `Authorization: Bearer`，
 * 火山/讯飞那种要额外头部或现场签名的形状本轮不接（#224 拍板②：只做「一把 Bearer 就能打」的）。
 */
export function buildSpeechRequest(vendor: TtsVendorId, input: TtsSpeechInput): TtsVendorRequest {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${input.apiKey}`,
  }
  // 倍速只在真的改过时才发：兼容网关对未知字段的行为不一致，默认值不带这一项，
  // 等于没改倍速的调用走的还是原来那份请求体。
  const speed = input.speed && input.speed !== 1 ? input.speed : undefined

  if (vendor === 'minimax') {
    const voiceSetting: Record<string, unknown> = {}
    // 这两家把音色列成必填，空串发过去得到的是「没有这个音色」而不是「没指定」；
    // 拦下它是 ttsConfigProblem 的事，这里只保证真发出去那份不带空值
    if (input.voice) voiceSetting.voice_id = input.voice
    if (speed !== undefined) voiceSetting.speed = speed
    return {
      url: joinApiPath(input.apiBase, VENDOR_SHAPES.minimax.path),
      headers,
      body: JSON.stringify({
        model: input.model,
        text: input.text,
        // 非流式：这一家不显式给 stream 时也可能按流式回，我们要的是一次拿到整段音频
        stream: false,
        output_format: 'hex',
        voice_setting: voiceSetting,
      }),
    }
  }

  if (vendor === 'dashscope') {
    // 这一家的 HTTP 接口没有 parameters 这一层：`format`、`rate` 和文本、音色并排在 input 里。
    // 按 DashScope SDK 那套老形状发到 parameters，对方不会报错，只会按默认值出一份 pcm——
    // 我们把它落成 .mp3，播放器里就只剩「加载失败」。
    const dashscopeInput: Record<string, unknown> = {
      text: input.text,
      format: AUDIO_FORMAT,
    }
    if (input.voice) dashscopeInput.voice = input.voice
    if (speed !== undefined) dashscopeInput.rate = speed
    return {
      url: joinApiPath(input.apiBase, VENDOR_SHAPES.dashscope.path),
      headers,
      body: JSON.stringify({ model: input.model, input: dashscopeInput }),
    }
  }

  const body: Record<string, unknown> = {
    model: input.model,
    input: input.text,
    response_format: AUDIO_FORMAT,
  }
  // 音色空着就整个字段不发：有些配音模型不收 voice，发一个空串过去会被当成「要一个叫空字符串的音色」
  if (input.voice) body.voice = input.voice
  if (speed !== undefined) body.speed = speed
  return {
    url: joinApiPath(input.apiBase, VENDOR_SHAPES.openai.path),
    headers,
    body: JSON.stringify(body),
  }
}

/** 把服务商回的错误正文压成一句：网关的 HTML 报错页整段甩给用户毫无意义 */
const ERROR_BODY_LIMIT = 200

function errorSnippet(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, ERROR_BODY_LIMIT)
}

async function textOf(response: Response): Promise<string> {
  return await response.text().catch(() => '')
}

/** HTTP 状态码那一步的提示按厂商分叉：404 对 OpenAI 是「这家没有这个端点」，对另两家是「地址层级错了」 */
function statusHint(vendor: TtsVendorId, status: number): string {
  const name = TTS_VENDOR_NAMES[vendor]
  if (status === 401) return `（${name} 的 Key 不对、已过期，或没有调用该模型的权限）`
  if (status === 404)
    return vendor === 'openai'
      ? '（这个服务商可能没有 OpenAI 标准的音频接口，或 API Base 少/多层路径）'
      : `（API Base URL 那格只该填到域名根为止，${name} 的接口路径由应用自己接上）`
  return ''
}

/**
 * 一次响应换成音频字节。抛错即失败，调用方负责把它变成界面上的那句话——
 * 消息一律是「发生了什么 + 你能改哪一格」，服务商原话原样带在后面。
 *
 * `signal` 是调用方那次请求的取消信号：DashScope 拿地址要再发一次 GET，
 * 用户点了「取消配音」时这一次也不能例外，否则取消按钮在最后一跳上失效。
 */
export async function readSpeechAudio(
  vendor: TtsVendorId,
  response: Response,
  signal?: AbortSignal
): Promise<TtsAudioResult> {
  const name = TTS_VENDOR_NAMES[vendor]
  if (!response.ok) {
    const detail = errorSnippet(await textOf(response))
    vendorError(
      `配音接口返回 ${response.status}${statusHint(vendor, response.status)}${detail ? `：${detail}` : ''}`
    )
  }

  if (vendor === 'openai') {
    // 各家兼容程度不一样，接口返回 200 但 body 是 JSON 错误的网关确实存在，所以内容类型必须验，
    // 否则落盘一个 .mp3 里面装着 `{"error":...}`，用户在播放器里只会看到「加载失败」
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('json')) {
      const detail = errorSnippet(await textOf(response))
      vendorError(`配音接口没返回音频，返回的是 JSON：${detail || '空 body'}`)
    }
    return { bytes: Buffer.from(await response.arrayBuffer()) }
  }

  if (vendor === 'minimax') {
    const raw = await textOf(response)
    const json = parseJsonBody(raw)
    if (!json) vendorError(notJsonMessage(name, raw))
    const baseResp = asObject(json.base_resp)
    const statusCode = Number(baseResp.status_code ?? 0)
    // 这一家的错误可能带着 HTTP 200 回来：状态码那一步已经过去了，这里不看就等于把失败读成成功
    if (statusCode !== 0) {
      const message = String(baseResp.status_msg ?? '').trim()
      vendorError(
        `${name} 回了错误码 ${String(statusCode)}${message ? `：${message}` : '（没有附带说明）'}。` +
          '模型名与音色 id 都以对方文档为准，改完可以先用「测试连接」验一次'
      )
    }
    const data = asObject(json.data)
    const audio = typeof data.audio === 'string' ? data.audio : ''
    if (!audio) vendorError(`${name} 回了成功但音频是空的（模型名或音色 id 很可能不被这家支持）`)
    // 音频是十六进制字符串，不是 base64；按 base64 解会得到一坨长度对得上的垃圾
    const bytes = Buffer.from(audio, 'hex')
    if (bytes.length === 0) vendorError(`${name} 回的音频解不出一个字节（返回的不是十六进制）`)
    return { bytes }
  }

  // dashscope：非流式回的是一个签名地址，音频要再去取一次
  const raw = await textOf(response)
  const json = parseJsonBody(raw)
  if (!json) vendorError(notJsonMessage(name, raw))
  const output = asObject(json.output)
  const audio = asObject(output.audio)
  const inline = typeof audio.data === 'string' ? audio.data : ''
  const url = typeof audio.url === 'string' ? audio.url : ''
  if (inline) return { bytes: Buffer.from(inline, 'base64') }
  if (!url) {
    const code = String(json.code ?? '').trim()
    const message = String(json.message ?? '').trim()
    vendorError(
      `${name} 回了 200 但没给音频地址${code ? `（${code}）` : ''}${message ? `：${message}` : ''}` +
        '。模型名与音色 id 都以对方文档为准'
    )
  }
  let audioResponse: Response
  try {
    audioResponse = await fetch(url, { signal })
  } catch (err) {
    // 用户点了取消或整批超时：原样抛回去，别在这里改写成「取音频失败」，
    // 那会让界面把一次正常取消报成网关故障
    if (err instanceof Error && err.name === 'AbortError') throw err
    vendorError(
      `${name} 给了音频地址，但取它这一步没成功：${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!audioResponse.ok) {
    vendorError(
      `${name} 给的音频地址取回来是 ${audioResponse.status}（这个地址只在 24 小时内有效，` +
        '刚拿到就失败通常是那一家网关的问题，可以重试一次）'
    )
  }
  const bytes = Buffer.from(await audioResponse.arrayBuffer())
  const usage = asObject(json.usage)
  const characters = Number(usage.characters ?? 0)
  return {
    bytes,
    note: characters > 0 ? `按 ${characters} 字计费` : undefined,
  }
}

/**
 * 解析响应正文。这一层不抛错，返回 null 让调用方判：`JSON.parse` 失败和「回的是一份 JSON 数组/字面量」
 * 都算「没读出一个对象」，而这两种情况在真实网关上都出现过。
 */
function parseJsonBody(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** 200 但内容读不出一个 JSON 对象：多半是网关回了一份 HTML 报错页，或地址指到了非接口的主页 */
function notJsonMessage(name: string, raw: string): string {
  return (
    `${name} 回的不是 JSON，没读出音频：${errorSnippet(raw) || '空 body'}。` +
    'API Base URL 那格填错了层级时会出现这一句'
  )
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
