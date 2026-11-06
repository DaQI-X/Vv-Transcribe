/**
 * 云端配音的厂商适配层（1.1.1 起，#224 → #342 加豆包）。
 *
 * 只做两件事：把「文本 + 模型 + 音色 + 倍速」拼成这一家要的请求，把这一家的响应换成音频字节。
 * 真实合成（ttsService）与设置里那颗「测试连接」（connectionTestService）共用这两个函数——
 * 分叉过一次就是「自检报可用、批量配音撞 400」，#220/#227 记的就是这类分歧。
 *
 * 四条口径：
 * - OpenAI 兼容是**默认档**，也是磁盘上没有 provider 那一项时（1.1.0 及更早建出来的方案）的读法。
 *   海外用户手上多半只有这一家，所以它不是备选，是「什么都不选就走的那条路」。
 * - 音频一律在这里换成 Buffer 再交给调用方落盘。四家没有一家把音频当裸字节流发回来：
 *   MiniMax 发的是十六进制字符串，DashScope 非流式发的是一个 24 小时有效的签名地址，
 *   豆包发的是一行一帧的 JSON（音频在每帧的 `data` 里，base64）。
 *   「响应体直接 writeFile」只对第一档成立，留着它就会往 .mp3 里写进一坨 JSON——
 *   用户在播放器里只会看到「加载失败」，而真因写在那坨 JSON 里。
 * - 服务商的错误原话必须能到用户眼前（1.1.0 定的口径）。这里因此对 MiniMax 和豆包各多读一层：
 *   两家都可能 HTTP 200 而真正的结论写在 body 里（MiniMax 在 `base_resp.status_code`，
 *   豆包在每帧的 `code`），只看状态码就是把失败读成成功。
 * - 音色这一项各家都收，但必填性不一样：OpenAI 兼容可以整个不发这一项，另三家必填。
 *   必填不由这里拦（拦在这儿就等于替用户猜一份音色清单），它是 `ttsConfigProblem` 那条校验的事。
 */
import { randomUUID } from 'node:crypto'
import { appendApiPath } from './apiPath'

/** 界面上「厂商」那格的取值；`openai` 同时是「留空/不认识」的落点 */
export type TtsVendorId = 'openai' | 'minimax' | 'dashscope' | 'volc'

const VENDOR_IDS: readonly string[] = ['openai', 'minimax', 'dashscope', 'volc']

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

/** 界面上说「这一套是哪家」时用的名字（错误原因里也要它，`dashscope` 这种 id 用户不认） */
export const TTS_VENDOR_NAMES: Record<TtsVendorId, string> = {
  openai: 'OpenAI 兼容接口',
  minimax: 'MiniMax',
  dashscope: '阿里云百炼（CosyVoice）',
  volc: '豆包（火山引擎）',
}

/**
 * 「资源编号」这一项在这家存不存在、留空时发什么（`null`＝没这一项，界面上那一格也不出现）。
 *
 * 只有豆包收它：`X-Api-Resource-Id` 说的是「这个账号开的是哪一版合成服务」，
 * 原厂当前页给的两个值是 `seed-tts-2.0`（系统音色）与 `seed-icl-2.0`（复刻音色），
 * 填错的症状是对方回一句「resource ID is mismatched with speaker related resource」——
 * 那一句话里同时提到音色和资源号，用户看不出是自己哪一格错了，所以这一格宁可露出来让人填。
 * 渲染层那份镜像表在 `src/utils/profileSpec.ts`，`tests/ttsVendor.test.ts` 有一条对账。
 */
export const TTS_VENDOR_RESOURCE_ID: Record<TtsVendorId, string | null> = {
  openai: null,
  minimax: null,
  dashscope: null,
  volc: 'seed-tts-2.0',
}

/** 这一家是否收「资源编号」（决定弹窗里那一格画不画） */
export function ttsVendorWantsResourceId(vendor: TtsVendorId): boolean {
  return TTS_VENDOR_RESOURCE_ID[vendor] !== null
}

/** 一次调用要拼进请求体的东西：`apiBase` 必须是 `normalizeApiBase` 归一化过的那一份 */
export interface TtsSpeechInput {
  apiBase: string
  apiKey: string
  model: string
  /** 服务商的音色 id；空串＝没指定 */
  voice: string
  /** 资源编号那格的值；空串落回 `TTS_VENDOR_RESOURCE_ID`，不收这一项的厂商看了也不发 */
  resourceId: string
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

/** 音频格式四家都用 mp3：本地铺轴那一步（ffmpeg concat）本来就按 mp3 解，不改这一项就不动它 */
const AUDIO_FORMAT = 'mp3'

/**
 * 倍速字段各家叫什么、什么单位。
 * MiniMax 把它嵌在 `voice_setting.speed` 里（倍数），DashScope 嵌在 `input.rate`（倍数），
 * OpenAI 在顶层 `speed`（倍数），豆包在 `req_params.audio_params.speech_rate`——
 * 那一家是唯一不按倍数说话的：它收的是百分比增量（0／100／-50 对应 原速／2 倍／0.5 倍）。
 */
interface VendorShape {
  /** 从归一化后的 apiBase 之后接的路径，带满整段（拼法见 apiPath.appendApiPath） */
  path: string
  /** 这一家的音色是不是必填（只用于错误提示的措辞，见 ttsConfigProblem） */
  voiceRequired: boolean
  /**
   * 这一家的「配音模型」是不是必填。
   *
   * OpenAI 兼容／MiniMax／百炼三家都拿模型名当入口，空着对方连往哪个引擎分发都不知道。
   * **豆包不收**：原厂写 `req_params.model`「仅当 speaker 为声音复刻 2.0 的音色时需指定」，
   * 枚举只有 standard／expressive 两个，给系统音色发过去回的是 45000001 InvalidModel。
   * 所以那一格在豆包这条路上是「填了才生效的例外」，拦它必填等于把大多数用系统音色的人挡在自己方案外。
   */
  modelRequired: boolean
  /**
   * 「测试连接」在界面没带音色时用哪一个（见 connectionTestService.testTTSConfig）。
   *
   * 这一页从 1.1.0 起没有云端音色格，而必填那几家不收空音色，不给一个值就等于那颗按钮对
   * MiniMax／百炼／豆包永远红着——用户照着提示去配音页填了音色再回来点，那一格的值不落盘、
   * 也传不过来，是个走不出来的圈。
   *
   * 理想是**只用本机实测通过的那一个**（MiniMax 就是：37428 字节那段）。但豆包手上没有 Key，
   * 按 #224 拍板的口径「先照原厂规范设计好，之后有 Key 再验」，这里给的是官方 2.0 音色清单第一行。
   * 它和留空的取舍是：留空＝那颗按钮对这一家永远不可用；给一个文档里的值＝大概率能验地址和 Key，
   * 万一这个音色不在用户账号的权限里，对方回的是「音色与资源编号不匹配」，那仍然是一句真诊断。
   * 百炼仍留空：它的音色表我们连灰字举例都没发过一次真请求，而这一家收空音色之外的什么错都不知道。
   */
  probeVoice: string
}

const VENDOR_SHAPES: Record<TtsVendorId, VendorShape> = {
  openai: { path: '/v1/audio/speech', voiceRequired: false, modelRequired: true, probeVoice: '' },
  // 2026-11-06 本机实测：speech-2.8-hd + 这一个音色合成出 37428 字节 / 2.232 秒（male-qn-qingse）
  minimax: { path: '/v1/t2a_v2', voiceRequired: true, modelRequired: true, probeVoice: 'male-qn-qingse' },
  dashscope: { path: '/api/v1/services/audio/tts/SpeechSynthesizer', voiceRequired: true, modelRequired: true, probeVoice: '' },
  // 这一条是照原厂文档拼的，还没有本机实测过（手上没有豆包 Key），按 #224 拍板的口径先设计上、后验。
  // 音色取自官方 2.0 清单的第一行，配 `seed-tts-2.0` 那个资源编号——两者必须成对，
  // 拿 1.0 的音色配 2.0 的资源号，对方回的是「resource ID is mismatched with speaker related resource」
  volc: { path: '/api/v3/tts/unidirectional', voiceRequired: true, modelRequired: false, probeVoice: 'zh_female_vv_uranus_bigtts' },
}

/** 这一家的音色是不是必填；界面与前置校验都按它分叉，别在渲染层再抄一份表 */
export function ttsVendorNeedsVoice(vendor: TtsVendorId): boolean {
  return VENDOR_SHAPES[vendor].voiceRequired
}

/** 这一家没模型就不出声；界面那格要不要标必填、自检要不要拦，都问这一句 */
export function ttsVendorNeedsModel(vendor: TtsVendorId): boolean {
  return VENDOR_SHAPES[vendor].modelRequired
}

/** 自检那一次能替界面补的音色，空串＝这一家没有「实测能用」的那个值，补不了 */
export function ttsVendorProbeVoice(vendor: TtsVendorId): string {
  return VENDOR_SHAPES[vendor].probeVoice
}

/**
 * 拼出这一家的一次请求。
 *
 * 鉴权不是一套走到底的：OpenAI 兼容／MiniMax／百炼都吃 `Authorization: Bearer`，
 * 豆包 v3 换成了 `X-Api-Key` 加一条「这一版服务」的资源编号（见 `TTS_VENDOR_RESOURCE_ID`）。
 * 所以整份头部由这里给，调用方不许在外面补一条——那正是 #220/#227 那种「自检少发一条头」的形状。
 * 讯飞那种要现场签名的形状本轮仍不接（#343 只接它转写那一侧）。
 * 地址那格怎么变成 URL 见 `apiPath.appendApiPath`——那一条规则全应用只有一份，别在这里再走一层拼接。
 */
export function buildSpeechRequest(vendor: TtsVendorId, input: TtsSpeechInput): TtsVendorRequest {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${input.apiKey}`,
  }
  // 倍速只在真的改过时才发：兼容网关对未知字段的行为不一致，默认值不带这一项，
  // 等于没改倍速的调用走的还是原来那份请求体。
  const speed = input.speed && input.speed !== 1 ? input.speed : undefined

  if (vendor === 'volc') {
    const resourceId = input.resourceId.trim() || (TTS_VENDOR_RESOURCE_ID.volc as string)
    const audioParams: Record<string, unknown> = {
      // mp3 与 24000 都是这一家自己的默认值，写出来是为了让「落成 .mp3」这件事在代码里看得见：
      // 它同时收 pcm/ogg_opus/wav，而文档明确「流式场景推荐使用 pcm，不建议使用 wav」——
      // 我们不按流式播，整段落盘交给 ffmpeg，mp3 是本地铺轴那一步本来就认的格式
      format: AUDIO_FORMAT,
      sample_rate: 24000,
    }
    // 这一家的倍速不是倍数而是一个**百分比增量**：原厂给的三个锚点是 0＝原速、100＝2 倍、-50＝0.5 倍。
    // 界面那几档（0.5–2）线性换算刚好落进它文档写的 [-50, 100]，不换算直接把 1.5 发过去是 1.5% 的提速
    if (speed !== undefined) audioParams.speech_rate = Math.round((speed - 1) * 100)
    const reqParams: Record<string, unknown> = { audio_params: audioParams }
    if (input.text) reqParams.text = input.text
    if (input.voice) reqParams.speaker = input.voice
    // `model` 不发是**有意的**：原厂写它「仅当 speaker 为声音复刻 2.0 的音色时需指定」，
    // 枚举只有 seed-tts-2.0-standard / -expressive 两个，对系统音色收了它回的是 45000001 InvalidModel。
    // 所以界面那一格留空时干脆不带，填了才带——填的人知道自己在给复刻音色指定档位
    const model = input.model.trim()
    if (model) reqParams.model = model
    return {
      url: appendApiPath(input.apiBase, VENDOR_SHAPES.volc.path),
      headers: {
        'Content-Type': 'application/json',
        // 这一把 Key 与 OpenAI 那三家不是同一个东西：豆包语音的 API Key 在语音控制台里生成，
        // 拿火山方舟（Ark）的 Key 过来是 401，界面上那句提示要说的是「语音控制台」
        'X-Api-Key': input.apiKey,
        'X-Api-Resource-Id': resourceId,
        // 原厂表格标「必选，推荐随机 UUID」，而它自己的 cURL 示例里没带这一条。
        // 缺它的后果文档没写，一问一个号是它原本的使用方式，照着做
        'X-Api-Request-Id': randomUUID(),
      },
      body: JSON.stringify({ req_params: reqParams }),
    }
  }

  if (vendor === 'minimax') {
    const voiceSetting: Record<string, unknown> = {}
    // 这两家把音色列成必填，空串发过去得到的是「没有这个音色」而不是「没指定」；
    // 拦下它是 ttsConfigProblem 的事，这里只保证真发出去那份不带空值
    if (input.voice) voiceSetting.voice_id = input.voice
    if (speed !== undefined) voiceSetting.speed = speed
    return {
      url: appendApiPath(input.apiBase, VENDOR_SHAPES.minimax.path),
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
      url: appendApiPath(input.apiBase, VENDOR_SHAPES.dashscope.path),
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
    url: appendApiPath(input.apiBase, VENDOR_SHAPES.openai.path),
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

/**
 * HTTP 状态码那一步的提示按厂商分叉：404 对 OpenAI 是「这家没有这个端点」，对另外三家是「地址层级错了」。
 * 都以逗号开头：前面那句已经带了 `（POST 最终地址）`，再套一层括号读不动。
 */
function statusHint(vendor: TtsVendorId, status: number): string {
  const name = TTS_VENDOR_NAMES[vendor]
  if (status === 401) return `，${name} 的 Key 不对、已过期，或没有调用该模型的权限`
  if (status === 404)
    return vendor === 'openai'
      ? '，这个服务商可能没有 OpenAI 标准的音频接口，或 API Base 少/多层路径'
      : `，${name} 的接口路径由应用接上——地址填到域名根为止就行；照对方文档粘完整端点也认，` +
        '那种情况下打的就是上面这一条'
  return ''
}

/**
 * 一次响应换成音频字节。抛错即失败，调用方负责把它变成界面上的那句话——
 * 消息一律是「发生了什么 + 你能改哪一格」，服务商原话原样带在后面。
 *
 * `request` 是调用方刚发出去的那一份（`buildSpeechRequest` 的返回值）：地址那格现在有两种活法
 * （填到根由应用接路径、照文档粘完整端点按原话打），报 404 的人只有看见**真的打了哪一条**
 * 才分得清是自己填深了还是应用接错了。所以这一项是必传的，不给调用方留「懒得带」的余地。
 *
 * `signal` 是调用方那次请求的取消信号：DashScope 拿地址要再发一次 GET，
 * 用户点了「取消配音」时这一次也不能例外，否则取消按钮在最后一跳上失效。
 */
export async function readSpeechAudio(
  vendor: TtsVendorId,
  request: TtsVendorRequest,
  response: Response,
  signal?: AbortSignal
): Promise<TtsAudioResult> {
  const name = TTS_VENDOR_NAMES[vendor]
  if (!response.ok) {
    const detail = errorSnippet(await textOf(response))
    vendorError(
      `配音接口返回 ${response.status}（POST ${request.url}）${statusHint(
        vendor,
        response.status
      )}${detail ? `：${detail}` : ''}`
    )
  }

  if (vendor === 'openai') {
    // 各家兼容程度不一样，接口返回 200 但 body 是 JSON 错误的网关确实存在，所以内容类型必须验，
    // 否则落盘一个 .mp3 里面装着 `{"error":...}`，用户在播放器里只会看到「加载失败」
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('json')) {
      const detail = errorSnippet(await textOf(response))
      vendorError(`配音接口没返回音频，返回的是 JSON（POST ${request.url}）：${detail || '空 body'}`)
    }
    return { bytes: Buffer.from(await response.arrayBuffer()) }
  }

  if (vendor === 'minimax') {
    const raw = await textOf(response)
    const json = parseJsonBody(raw)
    if (!json) vendorError(notJsonMessage(name, request.url, raw))
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

  if (vendor === 'volc') {
    const raw = await textOf(response)
    const audio: Buffer[] = []
    let words = 0
    let sawFrame = false
    // 原厂给的读法就是「一行一帧 JSON」（它的 Python 示例用 iter_lines 逐行 parse），
    // 所以这里整体读完再按行切，不去对齐 HTTP chunk 的边界。
    // 结束帧是 `code: 20000000`（它的 data 是 null），错误帧是 `code > 0` 的其他值——
    // 注意 0 才是「这一段音频」，所以不能把「code 不为 0」一概当失败，也不能只看最后一条
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const frame = parseJsonBody(trimmed)
      if (!frame) {
        vendorError(
          `${name} 的回包按行拆不出 JSON（POST ${request.url}）：${errorSnippet(trimmed)}。` +
            '这一家的正常回包是一行一帧，出现这一句多半是地址指到了非接口的那一层'
        )
      }
      sawFrame = true
      const code = Number(frame.code ?? 0)
      const message = String(frame.message ?? '').trim()
      if (code === 20000000) break
      if (code > 0) vendorError(volcFrameError(code, message))
      const usage = asObject(frame.usage)
      const count = Number(usage.text_words ?? 0)
      if (count > 0) words = count
      const chunk = typeof frame.data === 'string' ? frame.data : ''
      if (chunk) audio.push(Buffer.from(chunk, 'base64'))
    }
    if (!sawFrame) vendorError(notJsonMessage(name, request.url, raw))
    const bytes = Buffer.concat(audio)
    if (bytes.length === 0) {
      vendorError(
        `${name} 回了成功但一个音频字节都没给。这一家对「音色与资源编号不匹配」也会走到这一步——` +
          '先看配音页的音色那一格，再看设置里的资源编号是不是同一版服务'
      )
    }
    return { bytes, note: words > 0 ? `回执 text_words=${words}` : undefined }
  }

  // dashscope：非流式回的是一个签名地址，音频要再去取一次
  const raw = await textOf(response)
  const json = parseJsonBody(raw)
  if (!json) vendorError(notJsonMessage(name, request.url, raw))
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
 * 豆包写在帧里的错误码 → 「你能改哪一格」。
 *
 * 只翻官方错误码页上点得出具体字段的那几条，认不出的一律把对方原话递出去（1.1.0 的口径），
 * 不在这儿替用户猜原因。`45000001` 那一条尤其要说细：原厂把「缺 req_params」「speaker not found」
 * 「InvalidModel」全塞进同一个码，用户看到的消息只有一个字「model」时并不知道该动哪一格。
 */
function volcFrameError(code: number, message: string): string {
  const detail = message ? `：${message}` : '（没有附带说明）'
  // 这一句同时提到音色和资源编号，而它俩在我们界面上是两格，不点出来人只会来回改
  if (/resource\s+id/i.test(message)) {
    return (
      `豆包（火山引擎）回了错误码 ${code}${detail}。` +
      '这一句说的是「这个资源编号下没有这个音色」：资源编号在设置的这一套配音方案里，音色在配音页那一格，' +
      '两边得是同一版服务（系统音色配 seed-tts-2.0，复刻音色配 seed-icl-2.0）'
    )
  }
  const hint: Record<number, string> = {
    45000000: '请求体没被对方解开；超并发、体积过大、音色没授权也走这一码',
    45000001:
      '模型名、音色或资源编号里有一项它不认。「配音模型」那一格只对复刻音色有用，' +
      '用系统音色时留空即可',
    45002000: '音色那一格是空的，或这一家没有这个音色——去配音页的「音色」重填一个',
    45002001: '这一段文本里没有可念的字',
    40402003: '这一段的文本超过了它单次收的长度',
    55000000: '这一家的服务端报错，稍后重试一次即可',
  }
  const fieldHint = hint[code]
  return `豆包（火山引擎）回了错误码 ${code}${detail}${fieldHint ? `。${fieldHint}` : ''}`
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

/**
 * 除 OpenAI 兼容那三家 JSON 接口共用的「回的不是 JSON」那一句。
 * 200 但内容读不出一个 JSON 对象，多半是网关回了一份 HTML 报错页，或地址指到了非接口的主页——
 * 地址是这一句里唯一能改的东西，所以必须点名打了哪一条。
 */
function notJsonMessage(name: string, url: string, raw: string): string {
  return (
    `${name} 回的不是 JSON，没读出音频（POST ${url}）：${errorSnippet(raw) || '空 body'}。` +
    'API Base URL 那格填错了层级时会出现这一句'
  )
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
