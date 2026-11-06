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
  // 语言这一项两家都收、键名也一样，所以跟着形状一起给；空串干脆不发，
  // 让服务商自己判——把一个空 language 递过去，两家各自的默认行为并不一样
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
  if (input.language) fields.language = input.language
  return {
    url: `${input.apiBase}/${vendor === 'minimax' ? 'v1/speech_to_text' : 'v1/audio/transcriptions'}`,
    fields,
  }
}
