/**
 * 讯飞（iFlytek）「录音文件转写大模型版」的适配层（1.1.2，#343）。
 *
 * 这一家单独一个文件，没有并进 `asrVendor.ts`：那一处的契约是「一个函数产出这一趟请求的全部形状」，
 * 而讯飞的形状产不出来——它的鉴权是**每趟现算**的签名（`dateTime` 在待签参数里，轮询一次就得重算一次），
 * 而且转写本身是「上传拿订单号 → 轮询取结果」两步，不是一次 POST 就完。硬塞进 `AsrRequestShape`
 * 只有两种下场：把签名钉成一份（第二趟必然过期），或者在那个类型上再开一个「其实用不上」的口子。
 * 所以这里自己收口，而「这一家是谁」的判据仍然只在 `asrVendor.ts` 一处
 * （`normalizeAsrVendor` / `asrVendorUsesOrderFlow`），两边不许各认一份厂商名单。
 *
 * 真转写（`cloudASR`）与设置里那颗「测试连接」（`connectionTestService`）共用这里的
 * `runIflytekOrderFlow` 一个入口——两处各拼一遍签名就是 #220/#227 那种「自检说可用、一转写就失败」的分歧。
 *
 * 口径全部抄自官方文档《录音文件转写大模型》（www.xfyun.cn/doc/spark/asr_llm/Ifasr_llm.html，
 * 2026-11-07 读的那一份）：请求地址 `https://office-api-ist-dx.iflyaisol.com`，
 * 上传 `POST /v2/upload`（音频以 `application/octet-stream` 的**裸字节**上传，不是 multipart），
 * 查询 `POST /v2/getResult`（请求体必须是 `{}`，文档写明不可省略）。
 *
 * **手上没有这一家的凭据，这份实现一次真请求都没发过**（沿用 #224 那条拍板：先照原厂规范设计好，
 * 之后有 Key 再验）。单测钉的是文档自己给出的形状——签名按它那段 Java 示例逐步对，
 * 结果解析按它那份完成态响应示例逐段对（`tests/iflytekAsr.test.ts` +
 * `tests/fixtures/iflytekOrderResult.json` 就是从文档示例里取出来的那一份）。
 * 所以界面与文档都不得声称这一家验证过。
 */
import { createHmac, randomBytes } from 'node:crypto'
import type { AsrReadResult, AsrSegmentDraft } from './asrVendor'
import { appendApiPath } from '../apiPath'

/** 文档里写死的那一条请求地址。界面上「接口地址」那格仍由用户自己填，这里只做灰字举例 */
export const IFLYTEK_API_BASE_EXAMPLE = 'https://office-api-ist-dx.iflyaisol.com'

const UPLOAD_PATH = '/v2/upload'
const RESULT_PATH = '/v2/getResult'

/**
 * 文档写死的成功码。**它既可能是字符串也可能是数字**：成功示例里是 `"000000"`，
 * 失败示例里是 `100003`（没有引号）。只按字符串比就会把一个失败读成成功，所以一律 String() 之后比。
 */
const CODE_OK = '000000'

/**
 * `language` 这一格只有两个合法取值，而 `autominor`（37 个语种）原厂写明要单独提交工单申请权限。
 * 所以这里钉 `autodialect`（中英 + 202 种方言免切识别），不给用户第二档——
 * 一个默认没开通的选项摆在界面上，选了就是一条 100020「语言验证失败」。
 *
 * 连带一个必须说清的后果：**界面上那个「转写语言」对这一家无效**。它收的不是 Whisper 那套
 * 短码（zh/en/ja），把 `zh` 发过去只会撞 100020。这一条不是「配了但没生效」那种悄悄的分歧，
 * 而是这一家的接口根本没有对应参数，所以界面上要明说（见 `profileSpec.ts` 的 asrVendor 提示）。
 */
const IFLYTEK_LANGUAGE = 'autodialect'

/** 轮询间隔。文档没给建议值，只给了一个「订单预估耗时 taskEstimateTime」 */
const POLL_INTERVAL_MS = 3000

/**
 * 真转写时轮询的上界。原厂收 5 小时以内的音频，而它那个 `taskEstimateTime` 我们手上没有实测数
 * （没有 Key，文档示例里同一份音频一处写 128000、另一处写 25000），所以这一条不是算出来的、
 * 是一个上界。等不到就把订单号交出去——用户还能自己拿它去查，比一句「超时」有用。
 */
const POLL_DEADLINE_MS = 60 * 60 * 1000

/** 「测试连接」用的上界：自检要的是「这套凭据对不对」，不该让人对着弹窗等一小时 */
export const IFLYTEK_PROBE_DEADLINE_MS = 3 * 60 * 1000

export interface IflytekCredentials {
  /** 讯飞开放平台的应用 ID */
  appId: string
  /** 控制台里那把 APIKey；签名与查询参数里它叫 `accessKeyId` */
  apiKey: string
  /** 控制台里那把 APISecret。只用来算 HMAC，**永远不作为参数发出去** */
  apiSecret: string
}

/**
 * Java `URLEncoder.encode` 的那一套，不是 `encodeURIComponent`：空格在 Java 那边编成 `+`
 * （这边是 `%20`），`!` `'` `(` `)` `~` 在 Java 那边要编（这边原样留着）。
 * 签名算的是这一份编码后的串，差一个字符对方就回 100009「签名校验不通过」——
 * 而这一档唯一带得上这些字符的是 `fileName`，恰好就是用户自己那份音频的名字。
 *
 * 注意它与 URL 上那份编码**不是一回事**：文档写明最终 URL 参数要把 `:` 编成 `%3A`、`+` 编成 `%2B`，
 * 那是 `encodeURIComponent` 的口径（`dateTime` 里 `+0800` 那个加号就走这一条）。
 * 两份只在空格上分叉，而 `dateTime` 没有空格——所以拿错一个也不会当场出事，
 * 直到某天用户的音频文件名里有个空格，才变成一条查不出原因的 100009。
 */
function signatureEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/[!'()~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

/** `yyyy-MM-dd'T'HH:mm:ss±HHmm`，本地时间带本地时区偏移（东八区就是 `+0800`） */
export function iflytekDateTime(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  // getTimezoneOffset 的符号与文档要的相反：它对东八区返回 -480，而文档要的是 +0800
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`
  )
}

/**
 * 16 位大小写字母加数字。文档表里这么写，而它自己的请求示例用的是一串带 `-` 的 UUID——
 * 两边不一致时按表来：表是规范，示例只是复制粘贴留下的痕迹。
 * base64 去掉 `+` `/` 之后剩下的正好是这个字符集，比取模 62 少一处偏置。
 */
export function iflytekSignatureRandom(): string {
  return randomBytes(24)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 16)
}

/**
 * 算这一趟的签名。步骤逐条对着文档那段 Java 示例：
 * 排掉 `signature` 自己 → 按参数名自然排序（TreeMap 对 ASCII 键的排法与 `Array.sort` 一致）
 * → 空值不参与 → `编码后的键=编码后的值` 用 `&` 连成 baseString
 * → `base64(HMAC-SHA1(baseString, APISecret))`。
 *
 * 结果放在**请求头** `signature` 里，不是查询参数（文档 4.1.3 / 4.2.3 两张请求头表都列了它）。
 */
export function iflytekSignature(params: Record<string, string>, apiSecret: string): string {
  const baseString = Object.keys(params)
    .filter((key) => key !== 'signature')
    .sort()
    .filter((key) => params[key] !== undefined && params[key] !== '')
    .map((key) => `${signatureEncode(key)}=${signatureEncode(params[key])}`)
    .join('&')
  return createHmac('sha1', Buffer.from(apiSecret, 'utf8'))
    .update(Buffer.from(baseString, 'utf8'))
    .digest('base64')
}

/** 参数拼成查询串。用 `encodeURIComponent`（不是签名那份编码），理由见 signatureEncode 那段 */
function toQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')
}

export interface IflytekRequest {
  url: string
  headers: Record<string, string>
}

/**
 * 上传那一趟。音频本身是请求体（裸字节），不在这里——调用方手上才有那份 Buffer。
 *
 * `durationCheckDisable=true` 是**故意**的，所以我们从不发 `duration`：文档写 duration 要与真实
 * 音频时长一致，对不上就是 failType 5「音频校验失败」。我们这边的时长来自 ffprobe 读容器
 * （README 里那条「ffprobe 读 mp3 拿到的是容器估算」），拿一个估算值去对方那道精确校验上碰，
 * 输的是用户的一次上传。关掉这道校验之后，上限那件事仍由我们自己的 `asrFileProblem` 先拦
 * （500MB / 5 小时，与原厂同一份数），所以并没有少一道防线，只是不把判定权交给一个估算值。
 */
export function buildIflytekUpload(input: {
  apiBase: string
  credentials: IflytekCredentials
  fileName: string
  fileSize: number
  signatureRandom: string
  dateTime?: string
}): IflytekRequest {
  const params: Record<string, string> = {
    appId: input.credentials.appId,
    accessKeyId: input.credentials.apiKey,
    dateTime: input.dateTime ?? iflytekDateTime(),
    signatureRandom: input.signatureRandom,
    fileSize: String(input.fileSize),
    fileName: input.fileName,
    language: IFLYTEK_LANGUAGE,
    durationCheckDisable: 'true',
  }
  return {
    url: `${appendApiPath(input.apiBase, UPLOAD_PATH)}?${toQuery(params)}`,
    headers: {
      'Content-Type': 'application/octet-stream',
      signature: iflytekSignature(params, input.credentials.apiSecret),
    },
  }
}

/**
 * 查询那一趟。与上传有两处不同，都是文档明写的：
 * `dateTime` 要重新生成（「与上传接口的 dateTime 不同」），而 `signatureRandom` 要**沿用**上传那一个
 * （「需与上传接口使用相同的随机串，确保请求关联性」）。这一对很容易记反——记反了签名照样算得出来，
 * 只是对方不认，回一条看不出原因的错。
 *
 * 另外这一趟的参数表里**没有 `appId`**（上传那张表有），所以这里也不发。
 */
export function buildIflytekResult(input: {
  apiBase: string
  credentials: IflytekCredentials
  orderId: string
  signatureRandom: string
  dateTime?: string
}): IflytekRequest {
  const params: Record<string, string> = {
    accessKeyId: input.credentials.apiKey,
    dateTime: input.dateTime ?? iflytekDateTime(),
    signatureRandom: input.signatureRandom,
    orderId: input.orderId,
    resultType: 'transfer',
  }
  return {
    url: `${appendApiPath(input.apiBase, RESULT_PATH)}?${toQuery(params)}`,
    headers: {
      'Content-Type': 'application/json',
      signature: iflytekSignature(params, input.credentials.apiSecret),
    },
  }
}

/**
 * 错误码里那几个「用户改一格就能好」的。原厂那句 `descInfo` 一律照原话带上——
 * 我们这张表只补「改哪一格」，不替对方改写它自己的结论。
 */
const ERROR_HINTS: Record<string, string> = {
  '000001': '参数不对或不全：地址那一格是否粘到了别家的端点上',
  '000002': 'accessKeyId 不存在——这一家的 accessKeyId 就是控制台里那把 APIKey，不是 AppID，也不是 APISecret',
  '100001': '订单不存在或状态异常',
  '100002': '订单的音频还没上传成功',
  '100003': '参数错误。常见的一处是 dateTime 的格式：要 `yyyy-MM-dd\'T\'HH:mm:ss±HHmm`，本机时间被改过也会撞上',
  '100006': '上传音频异常：这一份对方没能收下来',
  '100007': '这把凭据没有开通「录音文件转写大模型」这一项服务，要到讯飞开放平台领额度或开通',
  '100008': '签名异常：请求时间超过限制。签名里带请求时间，本机时间与真实时间差得太多就会撞上（文档没写允许差多少），先校准系统时间',
  '100009': '签名校验不通过：APISecret 那一格不对，或它与 APIKey 不是同一个应用的',
  '100012': '请求超过频率限制，稍后再试',
  '100013': '订单还没完成',
  '100020': '语言验证失败：这一格只收 autodialect / autominor，而 autominor 需要单独提交工单申请',
  '100030': '未知的文件格式。这一家收 mp3/wav/pcm/opus/flac/ogg/speex，我们发出去的一直是 16kHz 单声道 wav',
  '100042': '外链地址无效',
}

/**
 * 异常状态里唯一「对我们不是错误」的那一个。设置里那颗「测试连接」发的正是一份静音样本，
 * 配置全对时对方回的就是 `status 4` + 这一个 failType；判成失败等于让配置正确的用户
 * 永远看到红的自检（见 connectionTestService.testIflytekASR）。
 */
export const IFLYTEK_FAIL_SILENT = 6

/** 订单异常状态（`orderInfo.failType`），逐条抄自文档那张表 */
const FAIL_TYPES: Record<number, string> = {
  1: '音频上传失败',
  2: '音频转码失败',
  3: '音频识别失败',
  4: '音频时长超限（这一家最大收 5 小时）',
  5: '音频校验失败（duration 与真实时长对不上）',
  [IFLYTEK_FAIL_SILENT]: '静音文件',
  7: '翻译失败',
  8: '账号无翻译权限',
  9: '转写质检失败',
  10: '转写质检未匹配出关键词',
  11: '创建任务时没有开启质检或翻译能力',
  12: '音频语种分析失败',
  99: '其他',
}

/** 订单流程状态（`orderInfo.status`） */
export const IFLYTEK_ORDER_DONE = 4
export const IFLYTEK_ORDER_FAILED = -1

export function iflytekFailTypeMessage(failType: number): string {
  return FAIL_TYPES[failType] ?? `未知的异常状态 ${failType}`
}

/** 把非 000000 的那一趟说成一句人话：原厂原话 + 「能改哪一格」 */
export function iflytekErrorMessage(code: string, descInfo: string): string {
  const hint = ERROR_HINTS[code]
  const origin = descInfo && descInfo !== 'success' ? `（对方原话：${descInfo}）` : ''
  return `讯飞转写接口回了错误码 ${code}${origin}${hint ? `。${hint}` : ''}`
}

/** 文档里那些换行与缩进压成一行，否则贴进结果卡时最有用那半句会被挤到看不见 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 报错里能带出去的那一段地址：只留协议 + 域名 + 路径，**整个查询串丢掉**。
 * 查询串里有 `accessKeyId`——那就是用户控制台里那把 APIKey，而下面两处消息一处进 app.log、
 * 一处直接显示在设置弹窗里。`logRedact` 拦不住它：那张表认的是**键名**，这里泄漏的是值。
 *
 * 丢掉查询串不损失诊断力：1.1.1 那次 404 的教训是「看不出应用在后头又接了一层路径」，
 * 说的是路径；而签名那几个参数全是我们自己算出来的，用户照着它也改不了什么。
 */
function safeUrl(url: string): string {
  return url.split('?')[0]
}

interface IflytekEnvelope {
  code?: string | number
  descInfo?: string
  content?: {
    orderId?: string
    taskEstimateTime?: number
    orderResult?: string
    orderInfo?: {
      orderId?: string
      status?: number
      failType?: number
      originalDuration?: number
      expireTime?: number
    }
  }
}

/**
 * 读一趟响应。**这一家的错误可能带着 HTTP 200 回来**（与 MiniMax 同一类），
 * 所以状态码之外还得看 body 里那个 `code`；而 body 也可能根本不是 JSON
 * （地址填错层级时网关回一份 HTML 报错页），那种情况要念出前 200 字，不能当成一次空响应。
 *
 * `url` 是调用方那份完整的（带查询串），这里一律过 `safeUrl` 再往外说，理由见它那段。
 */
async function readEnvelope(response: Response, url: string): Promise<IflytekEnvelope> {
  const where = safeUrl(url)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `讯飞转写接口返回 ${response.status}（POST ${where}）：${oneLine(text).slice(0, 200) || '对方没有附带说明'}`
    )
  }
  let envelope: IflytekEnvelope
  try {
    envelope = JSON.parse(text) as IflytekEnvelope
  } catch {
    throw new Error(
      `讯飞转写接口 200 但响应体不是 JSON（POST ${where}）：${oneLine(text).slice(0, 200) || '空响应'}` +
        '。接口地址那一格大概率填错了层级，这一家的地址填到域名根为止就行'
    )
  }
  const code = String(envelope.code ?? '')
  if (code !== CODE_OK) {
    throw new Error(iflytekErrorMessage(code || '（对方没给错误码）', String(envelope.descInfo ?? '')))
  }
  return envelope
}

interface IflytekWord {
  w?: string
  wp?: string
  wc?: string
}

/**
 * 把 `orderResult` 读成若干带起止秒的段。这一份是**双层字符串化**的：
 * `orderResult` 本身是一个字符串，parse 之后 `lattice[].json_1best` 又是一个字符串，
 * 再 parse 才拿到 `st`。少解一层就会得到一串 `undefined`，而症状是「转写完成、字幕全空」。
 *
 * `st.bg` / `st.ed` 是**毫秒**，而且是字符串（文档示例里是 `"880"`）——别家给的是秒、而且是数字，
 * 所以这一层不能与 `readAsrResponse` 共用。
 *
 * 一段的文字由 `st.rt[].ws[].cw[].w` 拼起来，按 `wp` 取舍（文档：n 正常词 / s 顺滑 / p 标点 / g 分段）：
 * **留 n 与 p，剔掉 s 与 g**。s 是顺滑掉的那一类语气词，g 是分段标记、`w` 本来就是空串——
 * 文档那份完成态示例里，剔掉之后五段分别是「为」「你好｡」「舒高生先生是吧?」「为｡」「听得到吗?一｡」，
 * 留着 s 就会多出一个孤零零的「喂」（`tests/iflytekAsr.test.ts` 钉的就是这份示例）。
 *
 * 置信度取 `wc` 的平均，且**只对 n 那一类取**：标点那一类的 `wc` 在文档示例里恒为 `0.0000`，
 * 算进平均会把每一段都无端压低一截。
 */
export function parseIflytekOrderResult(orderResult: string): {
  segments: AsrSegmentDraft[]
  hasLattice: boolean
} {
  if (!orderResult.trim()) return { segments: [], hasLattice: false }
  const outer = JSON.parse(orderResult) as { lattice?: Array<{ json_1best?: string }> }
  if (!Array.isArray(outer.lattice)) return { segments: [], hasLattice: false }

  const segments: AsrSegmentDraft[] = []
  for (const item of outer.lattice) {
    if (typeof item?.json_1best !== 'string') continue
    const best = JSON.parse(item.json_1best) as {
      st?: {
        bg?: string | number
        ed?: string | number
        rt?: Array<{ ws?: Array<{ cw?: IflytekWord[] }> }>
      }
    }
    const st = best.st
    if (!st) continue

    const words: string[] = []
    const confidences: number[] = []
    for (const rt of st.rt ?? []) {
      for (const ws of rt.ws ?? []) {
        for (const cw of ws.cw ?? []) {
          if (cw.wp !== 'n' && cw.wp !== 'p') continue
          words.push(cw.w ?? '')
          if (cw.wp === 'n') {
            const value = Number(cw.wc)
            if (Number.isFinite(value)) confidences.push(value)
          }
        }
      }
    }

    const text = words.join('').trim()
    if (!text) continue
    segments.push({
      start: Number(st.bg ?? 0) / 1000,
      end: Number(st.ed ?? 0) / 1000,
      text,
      confidence: confidences.length > 0 ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : undefined,
    })
  }
  return { segments, hasLattice: true }
}

export interface IflytekFlowInput {
  /** 已过 `normalizeApiBase` 的地址 */
  apiBase: string
  credentials: IflytekCredentials
  fileName: string
  audio: Uint8Array
  signal?: AbortSignal
  /** 轮询上界，缺省是 POLL_DEADLINE_MS；自检传一个短的 */
  deadlineMs?: number
  /** 拿到订单号、以及每轮询一次，都告诉调用方一声（界面上那句「已提交、在等对方」靠它） */
  onOrder?: (info: { orderId: string; polls: number; status: number }) => void
}

export interface IflytekFlowResult extends AsrReadResult {
  orderId: string
  failType: number
  /** true＝等到订单完成了；false＝到上界时对方还在处理中（订单号仍交出去，用户能自己查） */
  completed: boolean
  polls: number
}

/**
 * 走完「上传 → 轮询 → 解析」整条。真转写与自检共用这一个入口，理由见文件头。
 *
 * 取消这件事**不自己抛**：轮询之间那一段等待被取消时只是提前醒过来，让下一趟 `fetch`
 * 用同一个 signal 抛出与其余网络调用完全相同的 AbortError——取消在全应用只该有一种形状，
 * 多一种就会多一处「点了取消却被报成失败」的地方。
 */
export async function runIflytekOrderFlow(input: IflytekFlowInput): Promise<IflytekFlowResult> {
  const credentials = input.credentials
  // 一次任务一个随机串，查询要沿用它（见 buildIflytekResult 那段）
  const signatureRandom = iflytekSignatureRandom()

  const upload = buildIflytekUpload({
    apiBase: input.apiBase,
    credentials,
    fileName: input.fileName,
    fileSize: input.audio.byteLength,
    signatureRandom,
  })
  const uploadResponse = await fetch(upload.url, {
    method: 'POST',
    headers: upload.headers,
    body: input.audio,
    signal: input.signal,
  })
  const uploaded = await readEnvelope(uploadResponse, upload.url)
  const orderId = uploaded.content?.orderId
  if (!orderId) {
    throw new Error(
      '讯飞收下了这一份但没有回订单号，无法查询结果。对方原话：' +
        (oneLine(JSON.stringify(uploaded.content ?? {})).slice(0, 200) || '（content 是空的）')
    )
  }
  input.onOrder?.({ orderId, polls: 0, status: uploaded.content?.orderInfo?.status ?? 0 })

  const deadline = Date.now() + (input.deadlineMs ?? POLL_DEADLINE_MS)
  let polls = 0
  let status = 0
  let failType = 0
  let orderResult = ''
  let originalDurationMs = 0

  for (;;) {
    await waitBetweenPolls(POLL_INTERVAL_MS, input.signal)
    const result = buildIflytekResult({
      apiBase: input.apiBase,
      credentials,
      orderId,
      signatureRandom,
    })
    const response = await fetch(result.url, {
      method: 'POST',
      headers: result.headers,
      // 文档写明这一趟的请求体必须是 {}，不可省略
      body: '{}',
      signal: input.signal,
    })
    const envelope = await readEnvelope(response, result.url)
    polls += 1

    const info = envelope.content?.orderInfo
    status = info?.status ?? status
    failType = info?.failType ?? failType
    originalDurationMs = info?.originalDuration ?? originalDurationMs
    orderResult = envelope.content?.orderResult || orderResult
    input.onOrder?.({ orderId, polls, status })

    if (status === IFLYTEK_ORDER_DONE || status === IFLYTEK_ORDER_FAILED) break
    if (Date.now() >= deadline) break
  }

  const completed = status === IFLYTEK_ORDER_DONE
  if (!completed) {
    return {
      segments: [],
      text: '',
      hasSegments: false,
      duration: originalDurationMs / 1000,
      orderId,
      failType,
      completed: false,
      polls,
    }
  }

  // status 是「已完成」但 failType 非 0：这一家把「静音文件」这类情况也算完成，
  // 而它对我们并不是错误（自检用的正是一份静音样本）。所以这里不抛，交给调用方按 failType 说话。
  const parsed = parseIflytekOrderResult(orderResult)
  return {
    segments: parsed.segments,
    text: parsed.segments.map((segment) => segment.text).join(''),
    hasSegments: parsed.hasLattice,
    duration: originalDurationMs / 1000,
    orderId,
    failType,
    completed: true,
    polls,
  }
}

/**
 * 轮询之间那一段等待。取消时提前醒过来而不自己抛错，理由见 `runIflytekOrderFlow` 那段。
 * 第一次也等：刚上传完立刻去查必然还是「已创建」，那一趟白花。
 */
function waitBetweenPolls(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(wake, ms)
    function wake() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', wake)
      resolve()
    }
    signal?.addEventListener('abort', wake, { once: true })
  })
}
