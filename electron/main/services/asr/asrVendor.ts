/**
 * 云端转写的厂商适配层（1.1.1 起，#224 转写侧）。
 *
 * 只做一件事：把「这一家要的地址、鉴权头、模型默认值和 multipart 字段名」说清楚。
 * 真实转写（cloudASR）与设置里那颗「测试连接」（connectionTestService）共用这几函数——
 * 分叉过一次就是「自检报可用、一转写就 404」，#220/#227 记的就是这类分歧。
 *
 * 前两家的响应解析**故意没分叉**：OpenAI 兼容与 MiniMax 都给 `segments[].{start,end,text}`
 * （单位都是秒），多的字段都是可选的（OpenAI 的 `avg_logprob`、MiniMax 的 `speaker`），
 * 所以读响这一层共用一个函数。讯飞给的是另一套（订单里一段双层字符串化的 lattice），
 * 那份解析也在 `iflytekAsr.ts`，但**出口是同一个 `AsrReadResult`**——调用方拿到手还是「秒 + 段」。
 *
 * 口径与配音那一侧一致：
 * - OpenAI 兼容是**默认档**，也是磁盘上没有厂商那一项时（1.1.1 之前建出来的方案）的读法。
 * - 厂商只决定请求形状，不决定「走不走云端」——后者是全局段 `asrProvider`（云端／本地）那一份，
 *   两个名字挨得很近，但它们不是一回事，取值时别混。
 * - 服务商的错误原话照旧由调用方递给界面，这里不拦、不猜。
 *
 * 讯飞（#343）是第三家，也是唯一一家**不走 multipart** 的：它的录音文件转写大模型版是
 * 「上传音频换订单号 → 轮询订单取结果」两步异步接口，每趟请求还要现算一次 HMAC 签名，
 * 一次调用产不出一份固定形状，所以那份形状整个收在 `iflytekAsr.ts` 里，
 * 这里的 `buildAsrRequest` 只服务前两家（见该函数的守卫）。
 *
 * 配音那一侧收了豆包（`ttsVendor.ts`），转写这一侧没有，这不是漏掉的：豆包在架的转写接口
 * 只收**公网可访问的音频 URL**（`audio.url` 必填，文档里已经没有 `audio.data` 那一条），
 * 阿里云百炼的录音文件识别同样是这个口径。本机文件换不到一个能递给对方的地址——
 * 官方给的那条「上传换临时 URL」自己写着「请勿用于生产环境」（48 小时过期、凭证 100 QPS 不可扩容）。
 * 与其在下拉里挂一个「选了大概率失败」的选项，不如先不列它，理由的完整那一份在
 * `src/utils/profileSpec.ts` 的 asrVendor 提示里（界面不许说做不到的事）。
 */
import { formatBytes } from '../../../../src/utils/formatBytes'
import { appendApiPath } from '../apiPath'

/** 界面上「厂商」那格的取值；`openai` 同时是「留空／不认识」的落点 */
export type AsrVendorId = 'openai' | 'minimax' | 'iflytek'

const VENDOR_IDS: readonly string[] = ['openai', 'minimax', 'iflytek']

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
  iflytek: '讯飞（录音文件转写大模型版）',
}

/**
 * 各家没填模型名时的兜底：这一项只有厂商自己说得准，界面留空时按它走。
 *
 * 讯飞那一格是空串，因为**这一家的接口根本没有模型这一项**（上传那张参数表里没有它，
 * 选的是 `language` 与 `pd` 领域参数）。空串在这里不是「还没兜底」，而是「没有这一格」——
 * 界面上那一格按厂商不出现（`profileSpec.ts` 的 `visibleWhen`），别在这儿替它编一个名字。
 */
export const ASR_VENDOR_DEFAULT_MODEL: Record<AsrVendorId, string> = {
  openai: 'whisper-1',
  minimax: 'asr-1.0',
  iflytek: '',
}

/**
 * 这一家是不是走「上传拿订单号 → 轮询取结果」那条异步链路。
 *
 * 判据放在这一层（而不是让调用方自己 `vendor === 'iflytek'`）是因为它是**厂商的属性**，
 * 与「这一家是谁」同一件事：真转写（`cloudASR`）、设置里那颗「测试连接」
 * （`connectionTestService`）、以及界面上那句「这一家转写要等，不是点完就出字」都要按它分叉，
 * 三处各写一遍 id 比较，就是下一次加一家时漏掉一处的形状（#220/#227）。
 *
 * 走这条链路的那一家，请求形状由 `iflytekAsr.ts` 收口，**不经过** `buildAsrRequest`——
 * 它的签名每趟都得现算，一次调用产不出一份固定形状。
 */
export function asrVendorUsesOrderFlow(rawVendor: unknown): boolean {
  return normalizeAsrVendor(rawVendor) === 'iflytek'
}

/** 转写请求的除文件以外那部分；`url` 里的 apiBase 必须已经过 `normalizeApiBase` */
export interface AsrRequestShape {
  url: string
  /**
   * 这一趟要带的**全部**请求头，凭据也在里面。
   * 收进这一层而不是让调用方各自补 `Authorization: Bearer`：头部这件事只许写一次，
   * 两个调用点必须发同一份头——少发或多发一条的症状都是「自检和真转写结论不一致」（#220/#227）。
   */
  headers: Record<string, string>
  /** multipart 里除 file 以外的表单字段，按插入顺序拼 */
  fields: Record<string, string>
}

export interface AsrRequestInput {
  apiBase: string
  apiKey: string
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
 *
 * 讯飞不在这儿：它那份形状（两步异步 + 每趟现算签名）由 `iflytekAsr.ts` 收口，
 * 走不到这个函数。守卫是抛错而不是静默落回 openai 那一支——落回去的结果是一条
 * 「自检过了、真转写 404」的分叉，正是 #220/#227 那个形状。
 */
export function buildAsrRequest(rawVendor: unknown, input: AsrRequestInput): AsrRequestShape {
  const vendor = normalizeAsrVendor(rawVendor)
  if (vendor === 'iflytek') {
    throw new Error('讯飞转写不走 buildAsrRequest，请用 iflytekAsr.ts 的 runIflytekOrderFlow')
  }
  const model = input.model.trim() || ASR_VENDOR_DEFAULT_MODEL[vendor]
  const language = input.language.trim()

  // 两家都是 OpenAI 那一套 multipart：文件加几个表单字段，鉴权走 Bearer。
  // 语言这一项**两家放的位置不一样**：OpenAI 是 multipart 里的 `language` 字段，
  // MiniMax 原厂口径是 `language` 请求头（值是同一套短码，zh/en/ja/…，没有区域后缀）。
  // 当成字段发给 MiniMax 不会报错，只会静静被忽略——界面选了中文、对方按自动检测跑，
  // 这是最难被发现的那类「配了但没生效」。空串两家都不发。
  const fields: Record<string, string> =
    vendor === 'minimax'
      ? // 原厂口径：`POST /v1/speech_to_text`，官方 OpenAPI 里 form 字段就这几个
        { model, response_format: 'verbose_json', timestamp_level: 'sentence' }
      : {
          model,
          response_format: 'verbose_json',
          'timestamp_granularities[0]': 'segment',
        }
  if (language && vendor !== 'minimax') fields.language = language
  const headers: Record<string, string> = { Authorization: `Bearer ${input.apiKey}` }
  if (vendor === 'minimax' && language) headers.language = language
  return {
    url: appendApiPath(input.apiBase, vendor === 'minimax' ? '/v1/speech_to_text' : '/v1/audio/transcriptions'),
    headers,
    fields,
  }
}

/** 一次请求收多大的文件、收多长的音频；没写的那一项就是对方没给这条限制 */
interface VendorFileLimits {
  maxBytes?: number
  maxSeconds?: number
}

/**
 * 原厂文档里写死的那几条上限。
 *
 * `openai` 这一支留空是**有意的**：25MB 是 OpenAI 自己那家的上限，
 * 而兼容网关各自放多少并不一样（本机起的、内网的常常不收这一项），替它们拦人会把能用的人挡在门外。
 * MiniMax 这两条必须拦：它的 500 秒是硬上限，而一段超过 8 分钟的媒体是这一行最常见的输入，
 * 「一次 POST 整段音频」这条链路对它根本不成立——不拦的话用户在批次跑完前什么都看不到，
 * 只会在日志里撞到一句对方原话。
 *
 * 体积按 `50_000_000` 而不是 `50 * 1024 * 1024`：对方文档写的是 50MB，没说是十进制还是 1024 进制，
 * 取小的那个是**宁可多拦一句也不让对方回 413**。念出来的数走 `formatBytes` 那一把尺（#282）。
 *
 * 讯飞这两条也要拦，但拦的是完全不同的量级：500MB / 5 小时是原厂文档写死的硬上限（超时长的表现是
 * 订单直接判 `failType 4`，用户上传完还得等一轮轮询才知道）。它同时也是**目前唯一真能收长音频的一家**，
 * 所以超限那句尾巴不能沿用前两家那句「没有长音频异步接口可用」——对讯飞说这句是错的。
 */
const VENDOR_FILE_LIMITS: Record<AsrVendorId, VendorFileLimits> = {
  openai: {},
  minimax: { maxBytes: 50_000_000, maxSeconds: 500 },
  iflytek: { maxBytes: 500_000_000, maxSeconds: 5 * 3600 },
}

/**
 * 把分钟数念成人话：满一小时说小时，不到说分钟。
 * 300 分钟没人读得下去，而讯飞那条上限正好是 5 小时。
 * 小时位**向上**取整，理由见调用点那句注释；分钟位原样输出，
 * 所以调用方必须先自己把秒换成整数分钟（上限向下、这一份向上，两边方向不同，见调用点）。
 */
function humanDuration(minutes: number): string {
  return minutes >= 60 ? `${Math.ceil(minutes / 60)} 小时` : `${minutes} 分钟`
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
    // 这份自己多长要**向上**取整：501 秒四舍五入是 8 分钟，于是那句变成「只收 8 分钟，这一份是 8 分钟」——
    // 读起来像被误拦，而它真的超了。向上取整只会把 8 分 21 秒念成 9 分钟，不会反过来。
    // 同一道坑在小时位上更近：5 小时零 1 分钟四舍五入还是 5 小时，只有 ceil 才念得出「6 小时」
    //
    // 上限那一头方向相反，必须**向下**：MiniMax 写的是 500 秒（＝8 分 20 秒），ceil 会念成「只收 9 分钟」，
    // 于是一个 8 分 40 秒的用户看到「只收 9 分钟以内，这一份是 9 分钟」——像是我们拦错了。
    // 说 8 分钟顶多保守 20 秒，说 9 分钟是把对方会拒的那一段说成能收。
    return (
      `${name} 单次转写只收 ${humanDuration(Math.floor(limits.maxSeconds / 60))}以内的音频，` +
      `这一份是 ${humanDuration(Math.ceil(input.seconds / 60))}。` +
      (vendor === 'iflytek'
        ? '这一家已经是「上传换订单号再轮询」的异步接口，5 小时就是它的硬上限，超过只能先把音频切开分几次转'
        : '这一家没有长音频异步接口可用，或改用支持分段上传的服务')
    )
  }
  return null
}

/** 一段识别结果，单位与字段名已经收成 cloudASR 那一家共用的一套（秒） */
export interface AsrSegmentDraft {
  start: number
  end: number
  text: string
  /** 只有 OpenAI 兼容那一支给得出（avg_logprob 换算）；MiniMax 不给段级置信度，这里就是 undefined */
  confidence?: number
}

export interface AsrReadResult {
  segments: AsrSegmentDraft[]
  /**
   * 整篇文本；`null`＝对方根本没给这个字段，空串＝给了但这段没听出字。
   * segments 为空时调用方拿它兜一条整段（沿用 1.1.1 的行为），而「测试连接」要按这两件事分别说话：
   * 拿不到字段是「这个地址不是转写接口」，拿到空串只是「这段样本是静音」。
   */
  text: string | null
  /**
   * 对方有没有给「分段」这一层。静音样本里数组本来就可能是空的，字段在不在才是判据——
   * 这条区分 1.1.1 就写在自检里（`Array.isArray(body.segments)`），收到这一层来就不能把它丢掉。
   */
  hasSegments: boolean
  /** 音频总时长（秒）。对方没给就是 0，调用方要当成「不知道」而不是「零长度」 */
  duration: number
}

/**
 * 把这一次的响应读成「若干带起止秒的段 + 整篇文本」。
 *
 * 两家的 `verbose_json` 形状一致：`segments[].{start,end}` 就是秒，直接搬，所以这里不按厂商分叉。
 * 读法与「测试连接」共用这一个函数，所以自检里验到的结构和真转写解出的结构必然是同一份。
 */
export async function readAsrResponse(response: Response): Promise<AsrReadResult> {
  const body = (await response.json()) as {
    segments?: Array<{ start?: number; end?: number; text?: string; avg_logprob?: number }>
    text?: string
    duration?: number
  }
  return {
    segments: (body.segments ?? []).map((seg) => ({
      start: seg.start ?? 0,
      end: seg.end ?? 0,
      text: (seg.text ?? '').trim(),
      confidence: seg.avg_logprob != null ? Math.min(1, Math.max(0, 1 + seg.avg_logprob * 0.1)) : undefined,
    })),
    text: typeof body.text === 'string' ? body.text : null,
    // MiniMax 对没听出字的样本直接不给 segments 这一项（实测），所以「有没有这个字段」
    // 和「数组空不空」是两件事，自检要靠前者区分「不支持分段」与「这段是静音」
    hasSegments: Array.isArray(body.segments),
    duration: body.duration ?? 0,
  }
}
