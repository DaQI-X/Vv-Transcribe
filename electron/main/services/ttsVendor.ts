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
// 体积走全仓那一把尺（#282）：主进程这条 build 链没装 `@/` 别名，所以走相对路径，与 localTtsEngine 同一写法
import { formatBytes } from '../../../src/utils/formatBytes'

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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 「音色名单能不能问接口要」（1.1.2 #340）。四家里只有 MiniMax 给这一条，其余三家**刻意不接**：
 *
 * - **MiniMax**：`POST /v1/get_voice`，用的就是配音那把 Key，能一次列出系统音色与这个账号复刻出来的音色；
 * - **百炼**：`voice-enrollment` 的 `list_voice` 只列**自己复刻的那些**，CosyVoice 那一大张系统音色表
 *   只有文档页。拿它当候选等于在界面上说「你能选的就这几个」——比不给候选更误导，所以不接；
 * - **豆包**：拿配音这把 Key 只能查**某一个** speaker 的训练状态；真正的清单在控制台那侧的 OpenAPI，
 *   要的是 AK/SK 另一套凭据，与这一格填的东西不是一回事；
 * - **OpenAI 兼容**：规范里没有「列音色」这一条（内置那几个只写在散文里），而兼容网关各自加不加更没法假定。
 *
 * 不接的那三家照旧手输 + 挂厂商文档链接（`voiceListUrl`，#333），不做「假装能匹配」的半张表。
 */
const VENDOR_VOICE_LIST_PATH: Partial<Record<TtsVendorId, string>> = {
  minimax: '/v1/get_voice',
}

/** 这一家的音色名单能不能从接口取；界面按它决定那一格长不长得候选 */
export function ttsVendorListsVoices(vendor: TtsVendorId): boolean {
  return !!VENDOR_VOICE_LIST_PATH[vendor]
}

/** 一条候选音色。界面上要能说清出处，所以系统音色与自己复刻的分开标 */
export interface VendorVoice {
  /** 递给接口的那一个 id（MiniMax 是 `voice_id`，形如 male-qn-qingse） */
  id: string
  /** 给人看的名字，空串＝对方没给这一项 */
  name: string
  /** system＝厂商内置，clone＝这个账号自己复刻的 */
  source: 'system' | 'clone'
}

/**
 * 拼「列音色」这一次请求。头部仍由这里给全（同一把 Bearer），
 * 地址仍走 `appendApiPath`——那一条规则全应用只有一份，这里不许再拼一层。
 */
export function buildVoiceListRequest(
  vendor: TtsVendorId,
  input: { apiBase: string; apiKey: string }
): TtsVendorRequest {
  const path = VENDOR_VOICE_LIST_PATH[vendor]
  if (!path) vendorError(`${TTS_VENDOR_NAMES[vendor]} 没有「列出音色」这一条接口，音色只能手输`)
  // voice_type=all 一次把系统音色、复刻音色、生成音色都拿回来：界面要的是「这一把 Key 能用的全部」，
  // 分三次问既慢又会在中途失败时给出半张表（半张表比空表更难认出错）
  return {
    url: appendApiPath(input.apiBase, path),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({ voice_type: 'all' }),
  }
}

/**
 * 读回音色名单。与 `readSpeechAudio` 同一套口径：这一家的错误会带着 HTTP 200 回来，
 * `base_resp.status_code` 不看就等于把失败读成「这家一个音色都没有」。
 *
 * 拿不到名单不是致命错——界面会落回纯手输（本来就只有手输）。所以这里的措辞是给日志和
 * 那句灰字提示用的，别写成让用户以为配音坏了的话。
 */
export async function readVoiceList(
  vendor: TtsVendorId,
  request: TtsVendorRequest,
  response: Response
): Promise<VendorVoice[]> {
  const name = TTS_VENDOR_NAMES[vendor]
  if (!response.ok) {
    const raw = await textOf(response)
    vendorError(
      `${name} 取音色名单失败：HTTP ${String(response.status)}（POST ${request.url}）${
        raw ? `：${errorSnippet(raw)}` : ''
      }`
    )
  }
  const raw = await textOf(response)
  const json = parseJsonBody(raw)
  if (!json) vendorError(notJsonMessage(name, request.url, raw).replace('没读出音频', '没读出音色名单'))

  const baseResp = asObject(json.base_resp)
  const statusCode = Number(baseResp.status_code ?? 0)
  if (statusCode !== 0) {
    const message = String(baseResp.status_msg ?? '').trim()
    vendorError(
      `${name} 取音色名单回了错误码 ${String(statusCode)}${message ? `：${message}` : '（没有附带说明）'}`
    )
  }

  const voices: VendorVoice[] = []
  const push = (rows: unknown, source: VendorVoice['source']) => {
    for (const row of asArray(rows)) {
      const item = asObject(row)
      const id = String(item.voice_id ?? '').trim()
      if (!id) continue
      voices.push({ id, name: String(item.voice_name ?? '').trim(), source })
    }
  }
  push(json.system_voice, 'system')
  // voice_cloning 是这一把 Key 复刻出来的音色，voice_generation 是「音色生成」那条线的产物，
  // 两者都是这个账号自己的资产，界面上归到同一类「复刻」里说
  push(json.voice_cloning, 'clone')
  push(json.voice_generation, 'clone')
  return voices
}

/**
 * 「这一家能不能在应用里复刻音色」（1.1.2 #330）。四家里两家收，两家**刻意不接**：
 *
 * - **MiniMax**：两步——`POST /v1/files/upload`（multipart，`purpose=voice_clone`）换 `file_id`，
 *   再 `POST /v1/voice_clone` 把它与自己起的 `voice_id` 绑起来。两步用的都是配音那把 Key。
 * - **百炼**：一步——`POST /api/v1/services/audio/tts/customization`，`model=voice-enrollment`，
 *   `input.audio` 收**公网 URL 或 Base64 Data URI**，所以本机那段音频不必先传到哪儿就能递过去。
 * - **豆包**：复刻要先在控制台买一个「音色槽位」，那一步不是这把 API Key 能做的，接口侧只能查
 *   某个 speaker 的训练状态。槽位买不到就复刻不了，所以界面上这一档连按钮都不摆——
 *   摆一个「点了注定失败」的入口比不给入口更糟。
 * - **OpenAI 兼容**：规范里没有「复刻音色」这一条端点。OpenAI 自家那个要单独申请资格并录一段
 *   本人同意声明，而兼容网关各自加不加更没法假定。
 *
 * **两家都没在本机发过一次真复刻请求**（MiniMax 那把 Key 只验过合成与列音色，百炼连 Key 都没有），
 * 形状全部抄自原厂文档。按 #224 拍板的口径先设计上、后验，所以界面上任何一句都不许说「验证过」。
 */
export interface VendorCloneSpec {
  /** 先把音频换成 file_id 的那条端点；`null`＝这一家不分两步，音频直接进复刻请求体 */
  uploadPath: string | null
  clonePath: string
  /** 这一家收的音频后缀（本机预检与「选文件」框的过滤器都按它） */
  formats: readonly string[]
  /** 本机按字节数拦的上限（百炼那一家拦的是「编码后仍 ≤10MB」换算回原文件的数，见那一行注释） */
  maxBytes: number
  /**
   * 同一个上限**照厂商文档原话**的那个数，只用于报错时念给用户听。
   * 它和 `maxBytes` 是一把上限的两种写法（一个是原话、一个是字节数），改一个必须改另一个。
   * 为什么不直接拿 `maxBytes` 现算：全仓那把尺（`formatBytes`）按 1000 进位，念一个按 1024 定的
   * 上限会得到「21.0MB 超过 20MB」这种自己打自己的句子（#282 收拾的正是这一类）。
   */
  sizeLimit: string
  /**
   * 一句话交代这一家收什么样的音频，界面上照原话摆出来。
   * 时长只写在这里、不进预检：ffprobe 对 mp3 报的是按码率估的容器长度（含 LAME 前后填充，
   * 见 ttsService 头），拿它当判据会把一段合规音频判成「太短」；对方自己会拦，
   * 而它那句话里带的是真数字，比我们在本机估一个更可信。
   */
  audioRule: string
  /** `voiceId`＝用户自己起一个音色 id（MiniMax）；`prefix`＝只给前缀，完整 id 由对方拼（百炼） */
  nameKind: 'voiceId' | 'prefix'
  nameLabel: string
  nameRule: string
  /** 本机预检名字用的判式；`null`＝不检，交给对方 */
  namePattern: RegExp | null
  /** 复刻请求要不要带「配音模型」那一格（百炼的 target_model 必须与之后合成用的模型一致） */
  needsTargetModel: boolean
}

/** 厂商文档里那些「MB」按二进制理解：宁可放过一点，也别把对方本来会收的文件在本机拦下 */
const MIB = 1024 * 1024

export const VENDOR_VOICE_CLONE: Partial<Record<TtsVendorId, VendorCloneSpec>> = {
  minimax: {
    uploadPath: '/v1/files/upload',
    clonePath: '/v1/voice_clone',
    formats: ['mp3', 'm4a', 'wav'],
    maxBytes: 20 * MIB,
    sizeLimit: '20MB',
    audioRule: 'mp3 / m4a / wav，10 秒–5 分钟，≤20MB，一段连续清楚的朗读（无背景音乐、噪声或别人的声音）',
    nameKind: 'voiceId',
    nameLabel: '新音色 ID',
    nameRule:
      '8–256 个字符，字母开头、字母或数字结尾，只用字母/数字/-/_，且不能与已有音色重名',
    namePattern: /^[A-Za-z][A-Za-z0-9_-]{6,254}[A-Za-z0-9]$/,
    needsTargetModel: false,
  },
  dashscope: {
    uploadPath: null,
    clonePath: '/api/v1/services/audio/tts/customization',
    formats: ['wav', 'mp3', 'm4a'],
    // 对方那份「≤10MB」说的是 **Base64 编码后**（文档原话：编码会增大体积，确保编码后仍小于 10MB），
    // 编码要涨三分之一，所以按原文件 7.5MB 拦——拦在编码前才拦得住，编码后再发现超了已经白传一趟
    maxBytes: 7.5 * MIB,
    sizeLimit: '7.5MB',
    audioRule:
      'wav / mp3 / m4a，10–20 秒（最长 60 秒），采样率 ≥16kHz，原文件 ≤7.5MB（对方那 10MB 限的是编码后）',
    nameKind: 'prefix',
    nameLabel: '新音色名前缀',
    nameRule: '只用数字和字母、不超过 10 个字符；建好的完整音色名由对方拼（模型-前缀-唯一标识）',
    namePattern: /^[A-Za-z0-9]{1,10}$/,
    needsTargetModel: true,
  },
}

/** 这一家能不能在应用里复刻音色；界面按它决定那一块面板摆不摆 */
export function ttsVendorClonesVoices(vendor: TtsVendorId): boolean {
  return !!VENDOR_VOICE_CLONE[vendor]
}

export function ttsVendorCloneSpec(vendor: TtsVendorId): VendorCloneSpec {
  const spec = VENDOR_VOICE_CLONE[vendor]
  if (!spec) vendorError(`${TTS_VENDOR_NAMES[vendor]} 不支持在应用里复刻音色`)
  return spec
}

/**
 * 选完录音顺手填进「新音色 ID」那一格的建议值。
 *
 * 之所以由主进程生成、跟着 `pickCloneAudio` 的回执一起给：这一格原本要用户自己想一个名字，
 * 而「想名字」是复刻里唯一一件对方没要求、我们却把负担挪给用户的事——MiniMax 那条规则
 * （字母开头、字母或数字结尾、8–256 字符）光读就要看一眼，填错了一趟 120 秒的请求换回一句被拒。
 * 后缀取 `Date.now()` 的 36 进制末 8 位：同一个账号里重名会直接被拒，时间戳比 `Math.random` 好复现，
 * 长度也刚好卡在百炼那条「≤10 字符」的上限内（`vv` + 8）。
 */
export function suggestCloneName(vendor: TtsVendorId): string {
  const spec = ttsVendorCloneSpec(vendor)
  const tail = Date.now().toString(36).slice(-8)
  return spec.nameKind === 'prefix' ? `vv${tail}` : `vv-clone-${tail}`
}

/**
 * 复刻这一趟真会打到的那几条地址，按发出去的先后（MiniMax 两条、百炼一条）。
 *
 * 摆出来是因为**它和配音不是同一条端点**：复刻用的是「配音那一格地址的根 + 这一家复刻那条路径」，
 * 而这一格用户填过的原话可能是整条配音端点，也可能是只转发了配音那一条的中转地址——后者接上
 * 复刻的路径就成了一条不存在的路由，而界面上一句都不说。真发请求那一条走的是同一个函数，
 * 所以这里念的就是待会儿打的那几条，不是第二份推导。
 */
export function voiceCloneEndpoints(vendor: TtsVendorId, apiBase: string): string[] {
  const spec = ttsVendorCloneSpec(vendor)
  return [spec.uploadPath, spec.clonePath]
    .filter((path): path is string => path !== null)
    .map((path) => appendApiPath(apiBase, path))
}

/** Base64 Data URI 的 mediatype 按后缀定：写错一个 mime，对方解不出音频，回的是「参数错误」 */
const CLONE_AUDIO_MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
}

function extOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase()
}

/**
 * 复刻前的本机预检：只拦**能测准的**三样（名字形状、后缀、字节数），返回 null 就是可以发。
 * 时长为什么不拦，见 `VendorCloneSpec.audioRule` 那段注释。
 */
export function voiceCloneProblem(
  vendor: TtsVendorId,
  input: { name: string; fileName: string; bytes: number }
): string | null {
  const spec = ttsVendorCloneSpec(vendor)
  const name = input.name.trim()
  if (!name) return `先把「${spec.nameLabel}」那一格填上`
  if (spec.namePattern && !spec.namePattern.test(name)) {
    return `「${spec.nameLabel}」不合这一家的规矩：${spec.nameRule}（现在填的是 ${name}）`
  }
  const ext = extOf(input.fileName)
  if (!spec.formats.includes(ext)) {
    return `这一家复刻只收 ${spec.formats.join(' / ')}，你选的是 ${ext ? `.${ext}` : '一个认不出后缀的文件'}`
  }
  if (input.bytes === 0) return '这个音频文件是空的（0 字节），换一个'
  if (input.bytes > spec.maxBytes) {
    // 量出来的那一半走全仓那把尺（与访达、与「按需组件」列表同一个数），上限那一半念厂商文档的原话。
    // 两边刻意不同源：拿 SI 的尺去念一个按二进制定的上限，会得到「21.0MB 超过 21.0MB」这种自己打自己的句子
    return `这段音频 ${formatBytes(input.bytes)}，超过这一家复刻收的 ${spec.sizeLimit}，换一段短一点或先压一压`
  }
  return null
}

/** 「上传复刻音频」这一次请求：body 是 FormData，所以与 `TtsVendorRequest` 不是一个形状 */
export interface TtsVendorUploadRequest {
  url: string
  headers: Record<string, string>
  form: FormData
}

/**
 * 拼「上传复刻音频」这一步（只有分两步的那一家用得上）。
 *
 * 头部**刻意不给 Content-Type**：multipart 的 boundary 是 fetch 序列化 FormData 时现算的，
 * 手写一个 `multipart/form-data` 上去就等于发一个没有 boundary 的请求体，对方解不开，
 * 回的那句多半是「参数缺失」——看着像少填了什么，其实是头写多了一行。
 */
export function buildVoiceCloneUploadRequest(
  vendor: TtsVendorId,
  input: { apiBase: string; apiKey: string; fileName: string; bytes: Buffer }
): TtsVendorUploadRequest {
  const spec = ttsVendorCloneSpec(vendor)
  if (!spec.uploadPath) vendorError(`${TTS_VENDOR_NAMES[vendor]} 的复刻不用先上传音频`)
  const form = new FormData()
  // purpose 决定这一家把文件当什么用：写成别的值 file_id 照样拿得到，
  // 但下一步 voice_clone 会回「这个 file_id 不是复刻用的」，用户看不出问题出在上一步
  form.set('purpose', 'voice_clone')
  form.set('file', new Blob([input.bytes]), input.fileName)
  return {
    url: appendApiPath(input.apiBase, spec.uploadPath),
    headers: { Authorization: `Bearer ${input.apiKey}` },
    form,
  }
}

/**
 * 拼「复刻」这一步请求。两家的差别全在这里收口：MiniMax 递上一步换到的 file_id 与自己起的
 * voice_id，百炼把音频本身编成 Data URI 塞进 `input.audio`，并要求 `target_model`
 * 与之后合成用的模型一致——不一致对方直接拒，而那一格里填的就是配音方案的「配音模型」。
 */
export function buildVoiceCloneRequest(
  vendor: TtsVendorId,
  input: {
    apiBase: string
    apiKey: string
    /** 用户填的那一格：MiniMax 当 voice_id 用，百炼当 prefix 用 */
    name: string
    /** 配音模型那一格的值；只有 `needsTargetModel` 的那一家看它 */
    model: string
    /** 上一步换到的 file_id（分两步的那一家必给） */
    fileId?: string
    /** 本机那段音频与它的文件名（一步到位的那一家必给） */
    fileName?: string
    bytes?: Buffer
  }
): TtsVendorRequest {
  const spec = ttsVendorCloneSpec(vendor)
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${input.apiKey}`,
  }
  const url = appendApiPath(input.apiBase, spec.clonePath)

  if (spec.uploadPath) {
    if (!input.fileId) vendorError(`${TTS_VENDOR_NAMES[vendor]} 的复刻要先上传音频换 file_id，这一步没做`)
    // 文档里 file_id 是 int64：上传回来是纯数字时就按数字发，别把 "123" 这种字符串塞进请求体。
    // 但它不能走 `Number()`：原厂给的是 18 位时间戳样的 id，超过 2^53 就被 IEEE754 收掉尾数
    // （202611071234567890 发出去成 …900，那是一个不存在的文件号，对方只会回「文件找不到」）。
    // 所以纯数字直接把数字串接进 JSON、其余情况按字符串发，两条都保持对方文档里的类型。
    const fileId = /^\d+$/.test(input.fileId) ? input.fileId : JSON.stringify(input.fileId)
    return {
      url,
      headers,
      body: `{"file_id":${fileId},"voice_id":${JSON.stringify(input.name.trim())}}`,
    }
  }

  if (!input.bytes || !input.fileName) {
    vendorError(`${TTS_VENDOR_NAMES[vendor]} 的复刻要把音频本身递过去，这一步没拿到文件`)
  }
  if (spec.needsTargetModel && !input.model.trim()) {
    vendorError(
      `${TTS_VENDOR_NAMES[vendor]} 复刻要求「配音模型」与之后合成用的是同一个，` +
      '而这一套方案的模型那格是空的：先去设置里把配音模型填上'
    )
  }
  const mime = CLONE_AUDIO_MIME[extOf(input.fileName)] ?? 'application/octet-stream'
  return {
    url,
    headers,
    body: JSON.stringify({
      model: 'voice-enrollment',
      input: {
        action: 'create_voice',
        target_model: input.model.trim(),
        prefix: input.name.trim(),
        audio: `data:${mime};base64,${input.bytes.toString('base64')}`,
      },
      // language_hints 刻意不发：它只是给对方一个提示，发错一个语种比不发更容易让复刻跑偏，
      // 而用户在界面上没有这一格可填
    }),
  }
}

/** 读回上传那一步的 file_id。与 `readVoiceList` 同一套口径：错误可能带着 HTTP 200 回来 */
export async function readVoiceCloneUpload(
  vendor: TtsVendorId,
  request: TtsVendorUploadRequest,
  response: Response
): Promise<string> {
  const name = TTS_VENDOR_NAMES[vendor]
  if (!response.ok) {
    const raw = await textOf(response)
    vendorError(
      `${name} 上传复刻音频失败：HTTP ${String(response.status)}（POST ${request.url}）${
        raw ? `：${errorSnippet(raw)}` : ''
      }${statusHint(vendor, response.status)}`
    )
  }
  const raw = await textOf(response)
  const json = parseJsonBody(raw)
  if (!json) vendorError(notJsonMessage(name, request.url, raw).replace('没读出音频', '没读出上传回执'))

  const baseResp = asObject(json.base_resp)
  const statusCode = Number(baseResp.status_code ?? 0)
  if (statusCode !== 0) {
    const message = String(baseResp.status_msg ?? '').trim()
    vendorError(
      `${name} 上传复刻音频回了错误码 ${String(statusCode)}${message ? `：${message}` : '（没有附带说明）'}`
    )
  }
  const fileId = String(asObject(json.file).file_id ?? '').trim()
  if (!fileId) vendorError(`${name} 上传成功了但没给 file_id，下一步复刻拿不到这段音频`)
  return fileId
}

/**
 * 读回复刻结果，也就是那把新音色的 id。
 *
 * `requestedName` 是用户刚填的那一格：MiniMax 的 voice_id 就是用户自己起的，回执里不再重复一遍，
 * 所以那一家的答案是「你填的那个」；百炼的 id 由对方拼（模型-前缀-唯一标识），只能从回执里读，
 * 读不到就是没复刻成——这时候拿前缀当 id 用，后面每次合成都会失败在「没有这个音色」上。
 */
export async function readVoiceCloneResult(
  vendor: TtsVendorId,
  request: TtsVendorRequest,
  response: Response,
  requestedName: string
): Promise<string> {
  const name = TTS_VENDOR_NAMES[vendor]
  if (!response.ok) {
    const raw = await textOf(response)
    vendorError(
      `${name} 复刻音色失败：HTTP ${String(response.status)}（POST ${request.url}）${
        raw ? `：${errorSnippet(raw)}` : ''
      }${statusHint(vendor, response.status)}`
    )
  }
  const raw = await textOf(response)
  const json = parseJsonBody(raw)
  if (!json) vendorError(notJsonMessage(name, request.url, raw).replace('没读出音频', '没读出复刻回执'))

  if (ttsVendorCloneSpec(vendor).uploadPath) {
    const baseResp = asObject(json.base_resp)
    const statusCode = Number(baseResp.status_code ?? 0)
    if (statusCode !== 0) {
      const message = String(baseResp.status_msg ?? '').trim()
      // 这一家把「voice_id 与已有的重复」「音频不合规矩」「账号没实名」都塞在错误码里，
      // 对方原话是唯一能分清的东西，所以它必须在前，我们只补一句「多半是哪一格」
      vendorError(
        `${name} 复刻音色回了错误码 ${String(statusCode)}${message ? `：${message}` : '（没有附带说明）'}。` +
          '音色 id 与已有的重复、或那段音频不合这一家的规矩时都会走到这一步'
      )
    }
    return requestedName.trim()
  }

  const code = String(json.code ?? '').trim()
  const message = String(json.message ?? '').trim()
  if (code) {
    vendorError(`${name} 复刻音色失败（${code}）${message ? `：${message}` : ''}`)
  }
  const voiceId = String(asObject(json.output).voice_id ?? '').trim()
  if (!voiceId) {
    vendorError(
      `${name} 回了成功但没给 voice_id${message ? `：${message}` : ''}。` +
        '这一家的音色名是它自己拼的，读不到就等于没复刻成，别拿前缀当音色用'
    )
  }
  return voiceId
}
