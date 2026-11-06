/**
 * 云端转写的厂商适配层（1.1.1，#224 转写侧）。
 *
 * 只做一件事：把「这一家要的地址、模型默认值和 multipart 字段名」说清楚。
 * 真实转写（cloudASR）与设置里那颗「测试连接」（connectionTestService）共用这一个函数——
 * 分叉过一次就是「自检报可用、一转写就 404」，#220/#227 记的就是这类分歧。
 *
 * 响应解析**没有**按厂商分叉，这是有意的：两家的 verbose_json 都给
 * `segments[].{start,end,text}`（单位都是秒），OpenAI 多的那个 `avg_logprob` 是可选字段，
 * MiniMax 多的 `speaker/n_speakers` 我们这一版不接。真出现第三家不给时间的，
 * 再在这里加一档，而不是让 cloudASR 自己猜。
 *
 * 口径与配音那一侧一致：
 * - OpenAI 兼容是**默认档**，也是磁盘上没有厂商那一项时（1.1.1 之前建出来的方案）的读法。
 * - 厂商只决定请求形状，不决定「走不走云端」——后者是全局段 `asrProvider`（云端／本地）那一份，
 *   两个名字挨得很近，但它们不是一回事，取值时别混。
 * - 服务商的错误原话照旧由调用方递给界面，这里不拦、不猜。
 */
import { formatBytes } from '../../../../src/utils/formatBytes'

/** 界面上「厂商」那格的取值；`openai` 同时是「留空／不认识」的落点 */
export type AsrVendorId = 'openai' | 'minimax'

const VENDOR_IDS: readonly string[] = ['openai', 'minimax']

/**
 * 空串、老文件里没这一项、手改出来的怪值一律按 OpenAI 兼容处理。
 * 判严的收益是零：一个不认识的书签既不该让请求发不出去，也不该让界面凭空换一家网关。
 * 入参收 unknown 是因为它真的会是别的类型：settings.json 用户可以手改，
 * 「测试连接」那条 IPC 传来的又是渲染层拼的对象。
 */
export function normalizeAsrVendor(raw: unknown): AsrVendorId {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return VENDOR_IDS.includes(value) ? (value as AsrVendorId) : 'openai'
}

/** 界面上说「这一套是哪家」时用的名字（`minimax` 这种 id 用户不认） */
export const ASR_VENDOR_NAMES: Record<AsrVendorId, string> = {
  openai: 'OpenAI 兼容接口',
  minimax: 'MiniMax',
}

/** 各家没填模型名时的兜底：这一项只有厂商自己说得准，界面留空时按它走 */
export const ASR_VENDOR_DEFAULT_MODEL: Record<AsrVendorId, string> = {
  openai: 'whisper-1',
  minimax: 'asr-1.0',
}

/** 转写请求的除文件以外那部分；`url` 里的 apiBase 必须已经过 `normalizeApiBase` */
export interface AsrRequestShape {
  url: string
  /** 除 Authorization 以外要带上的请求头；没有额外头部时给空对象，调用方一律展开 */
  headers: Record<string, string>
  /** 除 file 以外的 multipart 字段，按插入顺序拼 */
  fields: Record<string, string>
}

export interface AsrRequestInput {
  apiBase: string
  /** 用户填的模型名；空串时落回这一家的默认档 */
  model: string
  /** Whisper 语言码（zh/en/ja/…）；空串＝不指定，让服务商自己判 */
  language: string
}

/**
 * 拼这一家的请求形状。
 *
 * MiniMax 那一份是原厂口径（`POST /v1/speech_to_text`，官方 OpenAPI 里 form 字段就这几个）：
 * 它把 OpenAI 兼容只写在文本接口上，音频这条不是同一个路径，所以不能沿用 openai 那一支。
 * `timestamp_level=sentence` 是必填取向：这一项留空时返回里有没有句级时间戳并不确定，
 * 而字幕编辑器整条链路靠的就是 start/end，缺了它就只能给一整段。
 */
export function buildAsrRequest(rawVendor: unknown, input: AsrRequestInput): AsrRequestShape {
  const vendor = normalizeAsrVendor(rawVendor)
  const model = input.model.trim() || ASR_VENDOR_DEFAULT_MODEL[vendor]
  const language = input.language.trim()
  // 语言这一项**两家放的位置不一样**：OpenAI 是 multipart 里的 `language` 字段，
  // MiniMax 原厂口径是 `language` 请求头（值是同一套短码，zh/en/ja/…，没有区域后缀）。
  // 当成字段发给 MiniMax 不会报错，只会静静被忽略——界面选了中文、对方按自动检测跑，
  // 这是最难被发现的那类「配了但没生效」。空串两家都不发，让服务商自己判。
  const fields: Record<string, string> =
    vendor === 'minimax'
      ? // 原厂口径：`POST /v1/speech_to_text`，官方 OpenAPI 里 form 字段就这几个。
        // `timestamp_level=sentence` 是必填取向：留空时返回里有没有句级时间戳并不确定，
        // 而字幕编辑器整条链路靠的就是 start/end，缺了它就只能给一整段
        { model, response_format: 'verbose_json', timestamp_level: 'sentence' }
      : {
          model,
          response_format: 'verbose_json',
          'timestamp_granularities[0]': 'segment',
        }
  if (language && vendor !== 'minimax') fields.language = language
  return {
    url: `${input.apiBase}/${vendor === 'minimax' ? 'v1/speech_to_text' : 'v1/audio/transcriptions'}`,
    headers: vendor === 'minimax' && language ? { language } : {},
    fields,
  }
}

/** 一次请求收多大的文件、收多长的音频；没写的那一项就是对方没给这条限制 */
interface VendorFileLimits {
  maxBytes?: number
  maxSeconds?: number
}

/**
 * 原厂文档里写死的那两条上限。`openai` 这一支留空是**有意的**：25MB 是 OpenAI 自己那家的上限，
 * 而兼容网关各自放多少并不一样（本机起的、内网的常常不收这一项），替它们拦人会把能用的人挡在门外。
 * MiniMax 这两条必须拦：它的 500 秒是硬上限，而一段超过 8 分钟的媒体是这一行最常见的输入，
 * 「一次 POST 整段音频」这条链路对它根本不成立——不拦的话用户在批次跑完前什么都看不到，
 * 只会在日志里撞到一句对方原话。
 *
 * 体积按 `50_000_000` 而不是 `50 * 1024 * 1024`：对方文档写的是 50MB，没说是十进制还是 1024 进制，
 * 取小的那个是**宁可多拦一句也不让对方回 413**。念出来的数走 `formatBytes` 那一把尺（#282）。
 */
const VENDOR_FILE_LIMITS: Record<AsrVendorId, VendorFileLimits> = {
  openai: {},
  minimax: { maxBytes: 50_000_000, maxSeconds: 500 },
}

/**
 * 开工前问一句「这一段这一家收不收」。返回 null＝可以发；返回一句人话＝别发，直接把话递给界面。
 * `seconds` 拿不到（探测失败）时只按体积判，不猜时长。
 */
export function asrFileProblem(
  rawVendor: unknown,
  input: { bytes: number; seconds?: number }
): string | null {
  const vendor = normalizeAsrVendor(rawVendor)
  const limits = VENDOR_FILE_LIMITS[vendor]
  const name = ASR_VENDOR_NAMES[vendor]
  if (limits.maxBytes !== undefined && input.bytes > limits.maxBytes) {
    return `${name} 单次转写上传上限 ${formatBytes(limits.maxBytes)}，这一份音频是 ${formatBytes(input.bytes)}`
  }
  if (limits.maxSeconds !== undefined && input.seconds !== undefined && input.seconds > limits.maxSeconds) {
    return (
      `${name} 单次转写只收 ${limits.maxSeconds} 秒（约 8 分钟）以内的音频，这一份是 ${Math.round(input.seconds)} 秒。` +
      '这一家没有长音频异步接口可用，需要整段转写的任务请换本地转写，或改用支持分段上传的服务'
    )
  }
  return null
}
