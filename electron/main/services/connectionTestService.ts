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
import { normalizeApiBase, normalizeTtsEngine } from './settingsService'
import { getLocalEngineDetail } from './asrServiceManager'
import {
  componentsSizeHint,
  getLocalTtsStatus,
  normalizeLocalTtsEngine,
  parseLocalTtsSid,
  synthesizeLocally,
} from './localTtsEngine'
import { DEFAULT_PROMPT } from './ai/openaiCompatible'

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
  provider: string
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
  apiBase: string
  apiKey: string
  model: string
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
  404: '接口或模型不存在：检查 API Base 是否填成了站点根地址，以及模型名是否拼写正确',
  405: '这个地址不接受 POST，可能填成了网页地址而不是 API 地址',
  408: '服务端处理超时',
  413: '请求体过大（本次只发了 1 秒静音音频，正常不该命中）',
  422: '参数校验失败：模型名或字段与该服务的期望不一致',
  429: '被限流：额度用尽或并发过高',
}

function httpFail(status: number, body: string): TestOutcome {
  const hint = STATUS_HINTS[status] || (status >= 500 ? '服务端正出错，稍后再试' : '服务返回了错误')
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 200)
  return {
    level: 'fail',
    title: `服务返回 ${status}`,
    message: snippet ? `${hint}。服务端的说明：${snippet}` : hint,
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
  if (e.name === 'AbortError' || code.includes('TIMEOUT')) {
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

/** 自检产物的体积：两档共用一句话，0 字节在上面已经被拦成失败了 */
function audioSize(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB 音频`
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

  const model = values.model.trim() || 'whisper-1'
  const url = `${base}/v1/audio/transcriptions`

  const form = new FormData()
  form.append('file', new Blob([buildSilentWav()], { type: 'audio/wav' }), 'vv-probe.wav')
  form.append('model', model)
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[0]', 'segment')

  const started = Date.now()
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${values.apiKey.trim()}` },
      body: form,
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
  } catch (err) {
    return connectFail(err)
  }

  const latencyMs = Date.now() - started
  if (!response.ok) return httpFail(response.status, await response.text().catch(() => ''))

  let body: Record<string, unknown>
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    return {
      level: 'fail',
      title: '返回的不是 JSON',
      message: '接口 200 但响应体无法解析成 JSON，这个地址大概率不是 OpenAI 兼容的转写接口',
    }
  }

  logger.info('ConnTest', 'cloud asr probe done', { model, latencyMs, keys: Object.keys(body) })

  if (typeof body.text !== 'string') {
    return {
      level: 'fail',
      title: '响应结构不对',
      message: '没有拿到 text 字段，这个服务的返回格式和 OpenAI 转写接口不一致，转写结果无法解析',
    }
  }

  const usedDefault = !values.model.trim()
  const originNote = usedDefault ? '（模型留空，本次用的是默认值 whisper-1）' : ''
  // 静音样本本来就转不出字，segments 是空数组不代表不支持分段；字段在不在才是判据
  if (!Array.isArray(body.segments)) {
    return {
      level: 'warn',
      title: '能转写，但不返回分段时间戳',
      message: `${originNote}耗时 ${formatLatency(latencyMs)}。这个服务忽略了 verbose_json 的 segment 粒度，字幕会整条压在时间 0 上、播放器逐句高亮也会失效，建议换成支持分段的服务（如 whisper-1）`,
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
  let response: Response
  try {
    response = await fetch(`${base}/v1/chat/completions`, {
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
  if (!response.ok) return httpFail(response.status, await response.text().catch(() => ''))

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
  const engine = normalizeLocalTtsEngine(rawEngine)
  const status = getLocalTtsStatus(engine)
  if (!status.binaryPresent || !status.modelPresent) {
    return {
      level: 'fail',
      title: '本地配音组件还没下载',
      message: `还缺${status.binaryPresent ? '模型' : '引擎二进制'}：${componentsSizeHint(engine)}。请在「设置 → 配音配置」里下载本地配音组件后再测`,
    }
  }

  const sid = parseLocalTtsSid(rawVoice)
  if (sid === null) {
    return {
      level: 'fail',
      title: '还测不了',
      message: `本地配音的音色是一个编号（如 0），当前是「${(rawVoice || '').trim() || '空'}」。请在「设置 → 配音配置 → 本地音色」里选一个`,
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
    return {
      level: 'pass',
      title: '本地配音可用',
      message: `耗时 ${formatLatency(latencyMs)}，用「${engine} · 音色 ${sid}」合成出 ${sizeNote}（首次启动含引擎解包，之后会快很多）。本地档不花钱、不走网络`,
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
 * 配音接口自检：真发一次合成请求，请求体与 ttsService 干活时完全一致。
 * 为什么必须真调：模型名和音色 id 是这两项最容易填错的地方，而兼容网关常常对任意模型名都照常
 * 返回 200——探活全绿，等用户在批量配音点了「开始」才撞上 400，烧的是他自己 Key 上的额度。
 * 本地档走 testLocalTTS：那三样（地址/Key/模型）根本不参与，按云端那套问只会把能用的人拦在门外。
 */
export async function testTTSConfig(values: TTSTestValues): Promise<TestOutcome> {
  if (normalizeTtsEngine(values.engine) === 'local') {
    return testLocalTTS(values.localEngine, values.voice)
  }

  const base = normalizeApiBase(values.apiBase)
  const baseProblem = invalidBase(base)
  if (baseProblem) return { level: 'fail', title: '还测不了', message: baseProblem }
  if (!values.apiKey.trim()) {
    return { level: 'fail', title: '还测不了', message: '配音需要 API Key 才能调用' }
  }

  // 与 getTTSConfig 同一个口径：模型和音色不替用户猜，空着就是没配
  const model = values.model.trim()
  const voice = values.voice.trim()
  if (!model || !voice) {
    return {
      level: 'fail',
      title: '还测不了',
      message: `配音${model ? '音色' : '模型'}还没填。音频接口收的是配音模型 id 与音色 id（如 tts-1 / alloy），拿校对的 chat 模型去调会被直接拒`,
    }
  }

  const started = Date.now()
  let response: Response
  try {
    response = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${values.apiKey.trim()}`,
      },
      body: JSON.stringify({ model, input: TTS_PROBE_TEXT, voice, response_format: 'mp3' }),
      signal: AbortSignal.timeout(TTS_TEST_TIMEOUT_MS),
    })
  } catch (err) {
    return connectFail(err)
  }

  const latencyMs = Date.now() - started
  if (!response.ok) return httpFail(response.status, await response.text().catch(() => ''))

  // 200 但 body 是 JSON 的网关确实存在（真实配音链路也验这一条），不验就等于把错误当成功
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('json')) {
    const body = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200)
    return {
      level: 'fail',
      title: '接口 200 但没给音频',
      message: `返回的是 JSON${body ? `：${body}` : ''}。这家的音频接口大概率不是 OpenAI 标准的 /v1/audio/speech`,
    }
  }

  const audio = await response.arrayBuffer().catch(() => null)
  const bytes = audio?.byteLength ?? 0
  if (bytes === 0) {
    return {
      level: 'fail',
      title: '接口没返回音频',
      message: `耗时 ${formatLatency(latencyMs)}，body 是 0 字节。模型名或音色 id 很可能不被这家支持，以服务商文档为准`,
    }
  }

  logger.info('ConnTest', 'tts probe done', { model, voice, latencyMs, bytes })
  return {
    level: 'pass',
    title: '配音接口可用',
    message: `耗时 ${formatLatency(latencyMs)}，用「${model} · ${voice}」合成出 ${audioSize(bytes)}。本次只合成一句，按字符计费的接口上这是最小的一笔`,
  }
}
