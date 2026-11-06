/**
 * 设置里的「测试连接 / 检查引擎状态」
 *
 * 为什么必须真发一次请求：只探活（GET /v1/models 之类）证明不了这套配置能干活。
 * 模型名写错是最常见的失败，而绝大多数兼容网关对任意模型名都照常返回 200 列表，
 * 探活全绿、真正转写时才报错。所以这里带上 1 秒静音音频和一条最小校对样例，
 * 走的就是干活时那两个接口，把失败提前到用户还在填表的时候。
 *
 * 测试用的是表单里的当前值，不读已保存设置、也不写盘 —— 用户应当在「没点保存」的情况下
 * 就能验证刚填的这组配置。
 *
 * 云端那几条腿都靠真发请求；本地配音那一腿是「起引擎 + 真合成一句」（见 testLocalTTS）：
 * 它没有接口可探，而且「服务能收请求」和「模型能出声」之间还隔着解包与惰性加载两步。
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { logger } from './logger'
import { normalizeApiBase, normalizeLocalVoice, normalizeTtsEngine } from './settingsService'
import { getLocalEngineDetail } from './asrServiceManager'
import {
  COMPONENT_ROW_TITLES,
  getLocalTtsStatus,
  missingComponentsMessage,
  normalizeLocalTtsEngine,
  parseLocalTtsSid,
  synthesizeLocally,
} from './localTtsEngine'
import { hasActiveTTSSynthesis } from './ttsService'
import {
  buildSpeechRequest,
  normalizeTtsVendor,
  readSpeechAudio,
  ttsVendorNeedsModel,
  ttsVendorNeedsVoice,
  ttsVendorProbeVoice,
  TTS_VENDOR_NAMES,
  TTS_VENDOR_RESOURCE_ID,
  type TtsAudioResult,
} from './ttsVendor'
import {
  ASR_VENDOR_DEFAULT_MODEL,
  ASR_VENDOR_NAMES,
  buildAsrRequest,
  normalizeAsrVendor,
  readAsrResponse,
  type AsrReadResult,
} from './asr/asrVendor'
import { engineBinaryInManifest } from './componentService'
import { AI_CHAT_PATH, DEFAULT_PROMPT } from './ai/openaiCompatible'
import { appendApiPath } from './apiPath'
// 相对路径而非 @/ 别名：主进程这条 build 链（vite.config.ts 里 electron 那两项）没有配别名，
// 用 @/ 会在打包时才炸，tsc 却是过的
import { formatBytes } from '../../../src/utils/formatBytes'

export type TestLevel = 'pass' | 'warn' | 'fail'

export interface TestOutcome {
  /** pass=可以直接干活；warn=能用但有会让工作阶段掉级的坑；fail=干活一定失败 */
  level: TestLevel
  /** 一句话结论，加粗显示 */
  title: string
  /** 人话解释 + 下一步该改什么 */
  message: string
}

export interface AsrTestValues {
  /** 云端／本地这一档（不是厂商）——名字沿用界面那格，别和下面的 vendor 混 */
  provider: string
  /**
   * 云端走哪一家（'openai' | 'minimax'），决定这次自检发的请求长什么样。
   * 表单里带了这一格就按它测；没带（空串）落回 OpenAI 兼容——与真转写的取值口径同一个函数。
   */
  vendor?: string
  apiBase: string
  apiKey: string
  model: string
}

export interface AITestValues {
  apiBase: string
  apiKey: string
  model: string
}

export interface TTSTestValues {
  /**
   * 配音引擎档（'cloud' | 'local'）。不传按云端处理——界面表单在用户还没点保存时也要能测，
   * 所以这一档必须跟着表单走，不能读已保存设置（那样测的就不是他刚选的那个组合了）。
   */
  engine?: string
  /** 本地档要用哪个引擎（如 sherpa-onnx-vits-zh-ll / kokoro-multi-lang-v1_1），同样来自表单当前值 */
  localEngine?: string
  /**
   * 云端档走哪一家（'openai' | 'minimax' | 'dashscope' | 'volc'），决定这次自检发的请求是什么形状。
   * 表单里带了这一格就按它测；没带时（配音页那颗按钮只带地址/Key/模型）由 settingsHandlers
   * 回落成设置里保存的那一份——测的必须是干活时那一家，理由与下面音色那一项相同。
   */
  provider?: string
  apiBase: string
  apiKey: string
  model: string
  /**
   * 资源编号（1.1.2，#342）：那一格只在豆包时画得出来（`TTS_VENDOR_RESOURCE_ID` 里不是 null 的一家）。
   * 豆包拿它选「哪一版配音服务」，标准音色与复刻音色是两条不同的编号，所以它既不是模型也不是密钥。
   */
  resourceId?: string
  /**
   * 云端＝服务商的音色名，本地＝音色编号。
   * 本地档跟着表单走：表单换引擎时把编号归回第一个，这一档测的就是换完那档的第一个说话人；
   * 表单没带（空串）按真配音同一口径落回推荐档 0，不拦人——1.1.0 起设置页没有这一格，空串才是常态。
   * 云端档面板上没有这一格（1.1.0 起音色不在方案里），传来的空串由 settingsHandlers 回落成
   * 设置里那一份全局值。两边都空时：OpenAI 兼容那档干脆不发这一项（有些模型不收音色），
   * MiniMax、阿里云百炼与豆包那三家必填，空着就当场判「还测不了」（1.1.1 起按厂商分叉）。
   */
  voice: string
}

const TEST_TIMEOUT_MS = 30_000

/**
 * 配音这一腿单独放宽到 60 秒，与 ttsService 里真实合成的超时对齐。
 * 共用 30 秒会出现「自检报超时、批量配音却跑得通」的分歧，那种结论比不测更误导。
 */
const TTS_TEST_TIMEOUT_MS = 60_000

/** HTTP 状态码 → 用户能照着做的解释。键是常见错误码，其余走兜底文案 */
const STATUS_HINTS: Record<number, string> = {
  400: '请求被拒绝，最常见的原因是模型名写错',
  401: '鉴权失败：API Key 无效、已过期，或该服务不只接受 Bearer 方式',
  403: 'API Key 有效，但没有访问这个模型/接口的权限',
  // 404 的两种成因要分开说：地址填深了（粘了完整端点）和模型名不存在。
  // 旧那句「检查是否填成站点根地址」把方向写反了——根地址才是对的，这次 404 就是这么来的。
  // 1.1.1 起「已经是这条端点」的地址按原话打、不再二次接路径（见 apiPath.appendApiPath），
  // 所以这句不能只说「只该填到根」；最终地址由 httpFail 念出来，对照对方文档即可
  404: '接口或模型不存在：API Base 那格填到域名根为止就行（形如 https://服务商域名），接口路径由应用自己接上；照对方文档粘完整端点也认；也可能是模型名不存在',
  405: '这个地址不接受 POST，可能填成了网页地址而不是 API 地址',
  408: '服务端处理超时',
  413: '请求体过大（本次只发了 1 秒静音音频，正常不该命中）',
  422: '参数校验失败：模型名或字段与该服务的期望不一致',
  429: '被限流：额度用尽或并发过高',
}

/**
 * `url` 是这一次真的打出去的那个地址（归一化后的根 + 应用自己接上的路径）。
 * 报 404 时只说「检查地址」用户没法自查：他粘的是文档里的原话，看不出应用在后面又接了一层。
 * 把最终 URL 念出来，路径拼错这件事当场就能自己看出来；这里绝不带 Key。
 */
function httpFail(status: number, body: string, url?: string): TestOutcome {
  const hint = STATUS_HINTS[status] || (status >= 500 ? '服务端正出错，稍后再试' : '服务返回了错误')
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 200)
  const where = url ? `。本次请求打的是 ${url}` : ''
  return {
    level: 'fail',
    title: `服务返回 ${status}`,
    message: snippet ? `${hint}${where}。服务端的说明：${snippet}` : `${hint}${where}`,
  }
}

/**
 * undici 把真实原因藏在 err.cause 里，直接抛给用户只会看到一句 "fetch failed"。
 * 这里按错误码翻成可操作的中文。
 */
function connectFail(err: unknown): TestOutcome {
  const e = err as Error & { cause?: { code?: string; message?: string } }
  const code = String(e.cause?.code || '').toUpperCase()
  const raw = e.cause?.message || e.message || String(err)

  let hint: string
  // TimeoutError 是 AbortSignal.timeout 到点时抛的那个名字（不是 AbortError），
  // 漏掉它会把一次「等响应等太久」报成「无法建立连接」
  if (e.name === 'AbortError' || e.name === 'TimeoutError' || code.includes('TIMEOUT')) {
    hint = '连接或等响应超时（转写、校对最长等 30 秒，配音等 60 秒）。地址可能指向了一个不会响应请求的服务，或者网络被拦截'
  } else if (code.includes('ENOTFOUND') || code.includes('EAI_AGAIN')) {
    hint = '域名解析失败。API Base 可能写错了；如果是海外服务，需要开代理或 VPN 后再试'
  } else if (code.includes('ECONNREFUSED')) {
    hint = '对方拒绝连接。地址对应的端口上没有服务在监听'
  } else if (code.includes('ECONNRESET')) {
    hint = '连接被对方重置。地址可能不是 HTTP 服务，或 TLS 版本不匹配'
  } else if (code.includes('CERT') || code.includes('SSL') || code.includes('SELF_SIGNED')) {
    hint = 'HTTPS 证书校验不通过。服务可能用了自签证书，或链路被中间设备改写'
  } else if (code.includes('PROXY') || code.includes('TUNNEL')) {
    hint = '代理连接失败。应用会沿用系统代理，请确认代理本身可用'
  } else {
    hint = '无法建立连接'
  }

  logger.warn('ConnTest', 'connect failed', { code, raw })
  // 括号里给原始原因：错误码经常是空的，只剩一句 TypeError 对用户毫无意义
  const label = code || raw
  return { level: 'fail', title: '连不上这个地址', message: `${hint}（${label}）` }
}

/** 亚秒级请求显示成「0.0 秒」会像坏了，这种情况下直接给毫秒 */
function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.max(10, Math.round(ms / 10) * 10)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`
}

/**
 * 自检产物的体积：两档共用一句话，0 字节在上面已经被拦成失败了。
 * 尺子用 src/utils/formatBytes.ts 那一把（1000 进位），和界面「按需组件」「关于」里念出来的体积
 * 同源。以前这里自己按 1024 除一遍，结果是同一份产物在自检弹窗里和在设置页里数字对不上——
 * 用户只会当成应用自己不清楚自己在说什么。
 */
function audioSize(bytes: number): string {
  return `${formatBytes(bytes)} 音频`
}

/** 校验地址是否可作为请求前缀；返回 null 表示通过，否则返回该改什么 */
function invalidBase(base: string): string | null {
  if (!base) return 'API Base URL 是空的'
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return `API Base URL「${base}」不是一个完整地址，需要带上 https:// 开头`
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `API Base URL 只支持 http/https，当前是 ${url.protocol}`
  }
  return null
}

/**
 * 1 秒 16kHz 单声道静音 PCM WAV，在内存里拼，不落盘也不打进安装包。
 * 静音是为了让成本压到最低：它只考察「鉴权是否通过、模型名是否存在、能不能解码并回结构」，
 * 不考察识别质量。
 */
function buildSilentWav(seconds = 1): Buffer {
  const sampleRate = 16000
  const dataSize = sampleRate * seconds * 2
  const buf = Buffer.alloc(44 + dataSize)

  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  return buf
}

/** provider=local 时不叫「测试连接」，因为没有任何连接可测，改成查本机引擎 */
async function checkLocalEngine(): Promise<TestOutcome> {
  const detail = await getLocalEngineDetail()
  if (!detail.ready) {
    return {
      level: 'fail',
      title: '本地转写引擎不可用',
      message: detail.error || '引擎没有应答，可点本页的「重启本地引擎」再试，不必退出应用',
    }
  }

  // 档位只报引擎自己说的，不读设置：这里要说的是「此刻干活用的是哪一档」，
  // 用户表单里刚改还没保存的值不算数，报出来只会让人以为已经生效了
  const tierNote = detail.loadedModel ? `，当前档位 ${detail.loadedModel}` : ''
  const modelNote = detail.modelLoaded
    ? `模型已在内存中${tierNote}，转写会很快`
    : '模型还没加载（首次转写时才加载，第一次会慢一些）'
  if (detail.protocol !== null && detail.protocol < 2) {
    return {
      level: 'warn',
      title: '本地引擎在线，但协议偏旧',
      message: `引擎协议为 ${detail.protocol}，当前应用期望逐句流式（协议 2）。端口上大概率是上一代引擎的残留，点本页的「重启本地引擎」会自动回收并重开`,
    }
  }
  return {
    level: 'pass',
    title: '本地转写引擎正常',
    message: `引擎在 ${detail.port} 端口应答正常，${modelNote}`,
  }
}

export async function testASRConfig(values: AsrTestValues): Promise<TestOutcome> {
  if (values.provider !== 'cloud') return checkLocalEngine()

  const base = normalizeApiBase(values.apiBase)
  const baseProblem = invalidBase(base)
  if (baseProblem) return { level: 'fail', title: '还测不了', message: baseProblem }
  if (!values.apiKey.trim()) {
    return {
      level: 'fail',
      title: '还测不了',
      message: '云端转写需要 API Key。如果只是在本机转写，把转写模式改回「本地转写」即可，不用填这些',
    }
  }

  const vendor = normalizeAsrVendor(values.vendor)
  const model = values.model.trim() || ASR_VENDOR_DEFAULT_MODEL[vendor]
  const usedDefault = !values.model.trim()
  // 路径与头部（含凭据）全问同一层：这里只要自己拼一次，
  // 「自检报可用、一转写就 404」就回来了（#220/#227）
  const probeAudio = buildSilentWav()
  const shape = buildAsrRequest(vendor, {
    apiBase: base,
    apiKey: values.apiKey.trim(),
    model: values.model,
    // 不带语言：这一格在设置页是全局那一项，不在方案表单里，表单里没有的值不该替用户猜一份发出去
    language: '',
  })

  const form = new FormData()
  form.append('file', new Blob([probeAudio], { type: 'audio/wav' }), 'vv-probe.wav')
  for (const [key, value] of Object.entries(shape.fields)) {
    form.append(key, value)
  }

  const started = Date.now()
  let response: Response
  try {
    response = await fetch(shape.url, {
      method: 'POST',
      // 整份头部（含鉴权）都由适配层给，这里不补 Bearer：
      // 自己补一次就是「自检发一份头、真转写发另一份」，正是这一路在躲的分歧
      headers: shape.headers,
      body: form,
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
  } catch (err) {
    return connectFail(err)
  }

  const latencyMs = Date.now() - started
  if (!response.ok) return httpFail(response.status, await response.text().catch(() => ''), shape.url)

  const originNote = usedDefault
    ? `（模型留空，本次用的是${ASR_VENDOR_NAMES[vendor]}的默认值 ${model}）`
    : ''

  let read: AsrReadResult
  try {
    read = await readAsrResponse(response)
  } catch (err) {
    if (err instanceof SyntaxError) {
      return {
        level: 'fail',
        title: '返回的不是 JSON',
        message: `接口 200 但响应体无法解析成 JSON，这个地址大概率不是 ${ASR_VENDOR_NAMES[vendor]} 的转写接口`,
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('ConnTest', 'cloud asr probe failed', { vendor, model, message })
    return { level: 'fail', title: '云端转写没成功', message }
  }

  logger.info('ConnTest', 'cloud asr probe done', {
    vendor,
    model,
    latencyMs,
    segments: read.segments.length,
  })

  if (read.text === null) {
    return {
      level: 'fail',
      title: '响应结构不对',
      message: `没有拿到 text 字段，这个服务的返回格式和 ${ASR_VENDOR_NAMES[vendor]} 的转写接口不一致，转写结果无法解析`,
    }
  }

  // 静音样本本来就转不出字，segments 是空数组不代表不支持分段；字段在不在才是判据
  if (!read.hasSegments) {
    // MiniMax 这条对「判据」是例外，而且是原厂行为：没听出字时它干脆不给 segments 这一项
    // （实测返回的键只有 text / duration / n_speakers / trace_id）。真给音频时它给的是秒级
    // start/end（实测过），所以这里报「不支持分段、建议换 whisper-1」是把一句对的判断
    // 说成了错的建议——用户照提示换服务，而问题本来不存在。
    if (vendor === 'minimax') {
      return {
        level: 'pass',
        title: '云端转写可用',
        message:
          `${originNote}耗时 ${formatLatency(latencyMs)}，地址、Key 和模型「${model}」都通。` +
          '分段时间戳这次没验到：这一家对没听出字的样本直接不返回 segments，真实转写里再看',
      }
    }
    return {
      level: 'warn',
      title: '能转写，但不返回分段时间戳',
      message: `${originNote}耗时 ${formatLatency(latencyMs)}。这个服务忽略了分段粒度，字幕会整条压在时间 0 上、播放器逐句高亮也会失效，建议换成支持分段的服务（如 whisper-1）`,
    }
  }
  return {
    level: 'pass',
    title: '云端转写可用',
    message: `${originNote}耗时 ${formatLatency(latencyMs)}，模型「${model}」存在且能返回分段时间戳`,
  }
}

/** 示例句里的两处同音错字，用来粗判这个模型是否真会校对 */
const AI_PROBE_TEXT = '今天天气绝常好，我们一起去公圆散步。'

export async function testAIConfig(values: AITestValues): Promise<TestOutcome> {
  const base = normalizeApiBase(values.apiBase)
  const baseProblem = invalidBase(base)
  if (baseProblem) return { level: 'fail', title: '还测不了', message: baseProblem }
  if (!values.apiKey.trim()) return { level: 'fail', title: '还测不了', message: 'AI 校对需要 API Key 才能调用' }

  const model = values.model.trim() || 'gpt-4o-mini'
  const usedDefault = !values.model.trim()
  const originNote = usedDefault ? '（模型留空，本次用的是默认值 gpt-4o-mini）' : ''

  const started = Date.now()
  const chatUrl = appendApiPath(base, AI_CHAT_PATH)
  let response: Response
  try {
    response = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${values.apiKey.trim()}` },
      // 与真实校对请求保持同一契约：同样的 prompt、同样要求只回 JSON、同样的 temperature
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: DEFAULT_PROMPT + AI_PROBE_TEXT }],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
  } catch (err) {
    return connectFail(err)
  }

  const latencyMs = Date.now() - started
  if (!response.ok) return httpFail(response.status, await response.text().catch(() => ''), chatUrl)

  const data = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: unknown } }>
  } | null
  if (!data) {
    return { level: 'fail', title: '返回的不是 JSON', message: '接口 200 但响应体无法解析，这个地址可能不是 OpenAI 兼容接口' }
  }

  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    return {
      level: 'fail',
      title: '没有返回内容',
      message: `耗时 ${formatLatency(latencyMs)}，但 choices[0].message.content 是空的。这类服务通常需要换模型名，或不接受 response_format=json_object`,
    }
  }

  logger.info('ConnTest', 'ai probe done', { model, latencyMs, contentLength: content.length })

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(content) as Record<string, unknown>
  } catch {
    return {
      level: 'fail',
      title: '这个模型不遵守输出格式',
      message: `接口能通，但它没有按要求只返回 JSON（开头是「${content.trim().replace(/\s+/g, ' ').slice(0, 40)}」）。校对结果会解析失败，建议换 gpt-4o-mini / deepseek-chat 这类支持 json_object 的模型`,
    }
  }

  if (typeof parsed.corrected !== 'string' || !Array.isArray(parsed.changes)) {
    return {
      level: 'fail',
      title: '返回的 JSON 结构不对',
      message: '需要同时包含 corrected（字符串）和 changes（数组），实际返回的字段是 ' + (Object.keys(parsed).join('、') || '空对象'),
    }
  }

  const fixedSomething = /非常|公园/.test(parsed.corrected)
  if (!fixedSomething) {
    return {
      level: 'warn',
      title: '接口可用，但没改对该改的字',
      message: `${originNote}耗时 ${formatLatency(latencyMs)}。格式正确，但示例句里的「绝常」「公圆」它都原样留着，这个模型的中文校对能力可能偏弱，建议先小段试用再上正式稿`,
    }
  }
  return {
    level: 'pass',
    title: 'AI 校对可用',
    message: `${originNote}耗时 ${formatLatency(latencyMs)}，输出格式正确，示例句里的同音错字也改对了`,
  }
}

/** 自检只合成这一句，成本压到最低；句子本身没有含义，不考察音色好不好听 */
const TTS_PROBE_TEXT = '这是一次配音接口自检。'

/**
 * 本地配音自检：真起引擎、真合成一句。
 * 为什么不满足于「组件在不在场」：模型齐了也可能起不来（端口被上一代占着、二进制和这台机器不匹配），
 * 首次启动还多一道解包——这些只有真跑一次才暴露得出来，跟云端那腿「必须真发一次请求」是同一个理由。
 * 本地档不花钱、不走网络，所以这里可以放开手真合成，不用像云端那样先确认段数。
 */
async function testLocalTTS(rawEngine: unknown, rawVoice: string): Promise<TestOutcome> {
  // 有一批正在逐段合成时不放行：自检要真起引擎，而表单里那档可能和正在跑的不是同一档——
  // 引擎被换掉，剩下几十段全报「没能连上本地配音服务」。与 tts:localStop 那条闸门同一个口径。
  if (hasActiveTTSSynthesis()) {
    return {
      level: 'fail',
      title: '现在不能测',
      message: '有一批配音正在逐段合成。等它跑完（或先在配音页取消这一批）再测，' +
        '否则这边会把正在用的引擎换掉，剩下的段落全部失败',
    }
  }
  const engine = normalizeLocalTtsEngine(rawEngine)
  const status = getLocalTtsStatus(engine)
  if (!status.binaryPresent || !status.modelPresent) {
    // 这句话与「第一次配音时启动失败」弹的是同一份（localTtsEngine.missingComponentsMessage）：
    // 缺哪样报哪样、点名「按需组件」里的那一行，模型已在磁盘上时明说不用重下。
    // 自检这一路拿得到清单会话缓存，所以把 binaryInManifest 传进去——
    // false＝那一行收着按钮，就不说「去下载」，给的是换回云端档这条出路。
    return {
      level: 'fail',
      title: '本地配音组件还没下载',
      message: missingComponentsMessage(engine, status.binaryPresent, status.modelPresent, engineBinaryInManifest(), '下完再测'),
    }
  }

  // 空串按真配音那一条收口（`normalizeLocalVoice`：空 → 推荐档 0），别在这儿拦下。
  // 1.1.0 起设置页没有「本地音色」那格了，磁盘上那份默认值就是空串——把它当「音色填错」
  // 报出去，等于给每个没动过音色的用户一条永远按不动的自检。非空的怪值（云端残留的 alloy）
  // 照旧拦：那是真填坏的东西，悄悄换成 0 只会让用户以为自己的选择通过了验证。
  const sid = parseLocalTtsSid(normalizeLocalVoice(rawVoice))
  if (sid === null) {
    return {
      level: 'fail',
      title: '还测不了',
      message: `本地配音的音色要选配音页「音色」里的一项，当前是「${rawVoice.trim()}」。设置页从 1.1.0 起没有这一格了，请到配音页那一格重选一个编号`,
    }
  }

  // 目录名带 transcribe- 前缀：万一 rm 没跑到（进程被强杀），启动清扫也能兜住
  const probeDir = join(tmpdir(), `transcribe-tts-probe-${randomUUID()}`)
  const started = Date.now()
  try {
    const clip = await synthesizeLocally(TTS_PROBE_TEXT, engine, sid, 1, probeDir)
    const latencyMs = Date.now() - started
    logger.info('ConnTest', 'local tts probe done', { engine, sid, latencyMs, bytes: clip.bytes })
    // 时长读不出来时不报「0.0 秒」：那看起来像坏了，而真实情况只是引擎没回 X-Vv-Duration
    const sizeNote = clip.duration > 0 ? `${clip.duration.toFixed(1)} 秒、${audioSize(clip.bytes)}` : audioSize(clip.bytes)
    // 档位名与音色编号都按界面上的叫法给：sherpa 的 sid 从 0 数起、用户在配音页「音色」里从 1 数起，
    // 这里若直出「音色 0」，看着就像跟下拉里选的那一个对不上。
    return {
      level: 'pass',
      title: '本地配音可用',
      message: `耗时 ${formatLatency(latencyMs)}，用「${COMPONENT_ROW_TITLES.models[engine].name} · 音色 ${sid + 1}」合成出 ${sizeNote}（首次启动含引擎解包，之后会快很多）。本地档不花钱、不走网络`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('ConnTest', 'local tts probe failed', { engine, sid, message })
    return { level: 'fail', title: '本地配音跑不通', message }
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 配音接口自检：真发一次合成请求，请求体和响应解析都走 ttsService 干活时那一份（ttsVendor）。
 * 为什么必须真调：模型名和音色 id 是这两项最容易填错的地方，而兼容网关常常对任意模型名都照常
 * 返回 200——探活全绿，等用户在批量配音点了「开始」才撞上 400，烧的是他自己 Key 上的额度。
 * 为什么必须共用：这一条链路只要自己拼过一次 URL、自己解过一次响应，「自检通过、配音失败」
 * 就重新出现了（#220/#227 记的都是这类分歧）。
 * 本地档走 testLocalTTS：那三样（地址/Key/模型）根本不参与，按云端那套问只会把能用的人拦在门外。
 */
export async function testTTSConfig(values: TTSTestValues): Promise<TestOutcome> {
  if (normalizeTtsEngine(values.engine) === 'local') {
    return testLocalTTS(values.localEngine, values.voice)
  }

  const vendor = normalizeTtsVendor(values.provider)
  const base = normalizeApiBase(values.apiBase)
  const baseProblem = invalidBase(base)
  if (baseProblem) return { level: 'fail', title: '还测不了', message: baseProblem }
  if (!values.apiKey.trim()) {
    return { level: 'fail', title: '还测不了', message: '配音需要 API Key 才能调用' }
  }

  // 模型不替用户猜，空着就是没配；音色看不选的那一家（下面按 vendorNeedsVoice 分叉）。
  const model = values.model.trim()
  // 界面那格空着时补一个音色：必填那几家在设置这一页没有音色格（1.1.0 摘掉的），
  // 不补就是这颗按钮对它们永远红，而提示让人去配音页填、那一格的值又不落盘——回来再点还是红。
  // 补的是这一家的系统音色（`ttsVendorProbeVoice` 只收「有出处」的那一个：MiniMax 是本机真 Key
  // 实测过的，豆包是官方 2.0 音色表的第一行、按 #224 拍板先照规范设计后验——两者都得和
  // `seed-tts-2.0` 那个资源编号成对，1.0 的音色配 2.0 的编号换回的是一句看不出哪一格错的 mismatched），
  // 跟用户自己填的那个不是一回事，所以结论里要点名；一个出处都没有的家（百炼）留空，
  // 让下面那句 fail 说「这页测不了，去配音页试听」——猜一个 id 等于替用户发明一个值。
  const probeVoice = ttsVendorProbeVoice(vendor)
  const voice = values.voice.trim()
  const usedVoice = voice || probeVoice
  const voiceSubstituted = !voice && !!probeVoice
  // 资源编号那一格只有豆包画得出来（`TTS_VENDOR_RESOURCE_ID` 里不是 null 的一家）。
  // 留空时发出去的是文档里那一条，结论必须点名——不然用户以为「空着＝不发」，
  // 而标准音色配错资源编号（拿 1.0 的音色配 2.0 的编号）恰恰是这一家最常见的失败形状。
  const formResourceId = (values.resourceId ?? '').trim()
  const defaultResourceId = TTS_VENDOR_RESOURCE_ID[vendor] ?? ''
  const usedResourceId = formResourceId || defaultResourceId
  const resourceSubstituted = !formResourceId && !!defaultResourceId
  const resourceNote = resourceSubstituted
    ? `（资源编号「${defaultResourceId}」是这一家的文档默认值，那一格留空时应用发的是它）`
    : ''
  if (ttsVendorNeedsModel(vendor) && !model) {
    return {
      level: 'fail',
      title: '还测不了',
      message: `配音模型还没填。${TTS_VENDOR_NAMES[vendor]} 收的是它自己的配音模型 id，` +
        '拿校对的 chat 模型去调会被直接拒；填在「设置 → 配音配置」里当前使用那一条的「配音模型」那一格',
    }
  }
  if (ttsVendorNeedsVoice(vendor) && !usedVoice) {
    return {
      level: 'fail',
      title: '这一页测不了这一家',
      message: `${TTS_VENDOR_NAMES[vendor]} 必须有音色才出声，而设置这一页没有音色格，` +
        `应用也不替你猜一个没有出处的音色 id。要验这一套的地址、Key 和模型，` +
        '去字幕配音页的「音色」那一格填一个（以对方文档为准）再点「试听」——那一次用的就是这套方案',
    }
  }

  const request = buildSpeechRequest(vendor, {
    apiBase: base,
    apiKey: values.apiKey.trim(),
    model,
    voice: usedVoice,
    resourceId: formResourceId,
    speed: 1,
    text: TTS_PROBE_TEXT,
  })

  // 一个 signal 用到底：阿里云百炼拿地址要再发一次 GET，不递进去那一次就没有超时
  const signal = AbortSignal.timeout(TTS_TEST_TIMEOUT_MS)
  const started = Date.now()
  let response: Response
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal,
    })
  } catch (err) {
    return connectFail(err)
  }

  const latencyMs = Date.now() - started
  let audio: TtsAudioResult
  try {
    audio = await readSpeechAudio(vendor, request, response, signal)
  } catch (err) {
    // 适配层那句已经是「发生了什么 + 能改哪一格」，原样贴出来，不再翻成通用文案
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('ConnTest', 'tts probe got no audio', { vendor, model, message })
    // 这个 id 是应用补的、不是用户填的，不点名就会让人去配音页改一个本来就没错的音色
    return {
      level: 'fail',
      title: '配音接口没出声',
      message: message +
        (voiceSubstituted ? `（本次的音色「${probeVoice}」是应用补的，不是你填的那一个）` : '') +
        resourceNote,
    }
  }

  const bytes = audio.bytes.length
  if (bytes === 0) {
    return {
      level: 'fail',
      title: '接口没返回音频',
      message: `耗时 ${formatLatency(latencyMs)}，body 是 0 字节。模型名或音色 id 很可能不被这家支持，以服务商文档为准` +
        (voiceSubstituted ? `（音色「${probeVoice}」是应用补的，这一格在设置里没有入口，不用去配音页找它改）` : '') +
        resourceNote,
    }
  }

  logger.info('ConnTest', 'tts probe done', {
    vendor,
    model,
    voice: usedVoice,
    resourceId: usedResourceId,
    latencyMs,
    bytes,
  })
  return {
    level: 'pass',
    title: '配音接口可用',
    // 没带音色时不能写成「tts-1 · 」：那一串看着像音色被吃了，而这一档本来就没指定音色。
    // 豆包同理不收模型（见 ttsVendorNeedsModel），空模型也不能念成「用「 · 音色」」
    message: `耗时 ${formatLatency(latencyMs)}，用「${model || '未指定模型'}${usedVoice ? ` · ${usedVoice}` : '（未指定音色）'}」` +
      `合成出 ${audioSize(bytes)}${audio.note ? `（${audio.note}）` : ''}。` +
      // 补来的音色只证明「这一家认这个 id、这条端点能出声」，不证明用户自己填的那个听得到——
      // 那句要到配音页点「试听」才算，别说成「这一套全都通了」
      (voiceSubstituted
        ? `这次用的是${TTS_VENDOR_NAMES[vendor]}的系统音色「${probeVoice}」（实测能用那一个），设置这一页没有音色格；`
        : '') +
      resourceNote +
      '本次只合成一句，按字符计费的接口上这是最小的一笔',
  }
}
