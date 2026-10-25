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
 */
import { logger } from './logger'
import { normalizeApiBase } from './settingsService'
import { getLocalEngineDetail } from './asrServiceManager'
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

const TEST_TIMEOUT_MS = 30_000

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
    hint = '连接或等响应超时（30 秒）。地址可能指向了一个不会响应请求的服务，或者网络被拦截'
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
