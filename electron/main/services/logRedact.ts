/**
 * 日志落盘前的统一处理（#281）
 *
 * 「日志不带原文」这句口径以前靠调用点自觉：#123 那批改动给一批调用点各自补了 `basename()`
 * （`electron/` 下的非注释调用点数得出 29 个），但仍有人把裸路径直接写进盘——按 grep 数出来是 13 处
 * 把路径塞进 data 对象（`fileHandlers.ts:346` 的 `{ path: logDir }`、`audioProcessor.ts:68` 的
 * `{ ffmpegPath, ffprobePath }`、`ytDlpUpdate.ts:399` 的 `path: target`，`urlDownloader.ts` 一个文件就占 7 处），
 * 另有 4 处拼在 message 里（`audioProcessor.ts:35/37/40/45`）；错误对象带的 stack 更没人管——本机那份
 * app.log（15,946 行）里数得出 1,837 处 `/Users/daqi/`，`ServiceError` 那类把整段 stack 原样写进去，
 * `file:///Users/…` 开头的栈帧有 64 行，最长的一行 1,538 字符、超过 400 字符的行有 503 条。
 * 和 #280 之前那句「不跨 IPC 抛错」是同一个毛病：写在注释里的规矩，等于没有规矩。
 *
 * 所以这里把处理做成**一道闸门**，由 logger 的两个写盘口（`write` 与 `errorSync`）在序列化之前跑一遍，
 * 调用点没法关掉、也没法「这次先不脱敏」。三段：
 * 1. **按键名**：`asrApiKey` / `api_key` / `token` 这类凭据字段，和 `text` / `content` / `transcript`
 *    这类装用户文稿的字段，整值换成一句带尺寸的说明（`[已隐去:文本 2145 字符]`）——尺寸要留着，
 *    不然「接口返回了 0 字节音频」这类现场就查不出来了。装文本的键名用**全等**（归一化后），
 *    凭据用**包含**：`contentLength` 得留下（它是调试用的），`asrApiKey` 必须走。
 * 2. **按形状**：文本里裸着的 `sk-…`、`Bearer …`、`api_key=…`、签名 URL 的查询参数、`data:…;base64,`
 *    内嵌音频、以及绝对路径（POSIX 与 Windows 两种）→ 路径收成 basename，因为「是哪个文件」有用、
 *    「用户把它放在哪」没用。
 * 3. **按尺寸**：单条字符串截到 `MAX_STRING`，**头尾各留一半**——只留头会把 ffprobe 那句
 *    `No such file or directory` 截掉，而决定性的话常常在尾巴上（本机实测一次失败的
 *    `execFile('ffprobe', ['-i', ...])`：`err.message` 长 924 字符，开头是版本横幅与一整套
 *    libav* 版本号，最后一行才是那句原因）。数组按条数截，深度按层截，循环引用打 `[循环引用]`。
 *
 * 刻意不做的事：不删 DEBUG、不改任何调用点的措辞（那是级别治理，另一件事）；也不追求「读起来漂亮」，
 * 这份日志的唯一用途是用户把它发回来之后能定位问题。
 */

/** 单条字符串（含 message、stack、子进程输出）截到这个长度 */
export const MAX_STRING = 400
/** 一个数组最多落几项，多出来的按条数说明 */
export const MAX_ARRAY_ITEMS = 20
/** 对象嵌套超过这几层就不再往下走 */
export const MAX_DEPTH = 6

/** 键名归一：去掉大小写与分隔符，好让 asrApiKey / api_key / API-KEY 落进同一条规则 */
function normKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * 凭据类键名（**包含**匹配，外加一条「以 key 结尾」）：各家叫法太散（`x-api-key`、
 * `Ocp-Apim-Subscription-Key`、`access_key_secret`），全等会漏。
 * 单靠包含抓不到 `...Subscription-Key` 这种把 key 放在词尾的写法，所以补 `key$`；
 * 它同时会误伤 `cacheKey` / `sortKey` 这类调试字段——代价只是日志里少一个无所谓的名字，
 * 而漏掉一把 Key 的代价是把它发给任何人。
 */
const CREDENTIAL_KEY =
  /apikey|apisecret|secret|token|password|passwd|authorization|credential|accesskey|signingkey|sessionkey|privatekey|cookie|setcookie|key$/

/**
 * 装用户原文的键名（归一化后**全等**）：文稿、提示词、接口 body、内嵌音频。
 * 用全等就是为了 `contentLength`、`textLength`、`diffCount` 这类派生值要留下。
 * 段落数组不在这里整块隐去——它们的时间轴是定位问题要看的，交给递归只把里面每个
 * `text` / `original` / `corrected` / `context` 收掉（`ASRSegment` 与 `differences` 就是这几个字段名）。
 */
const CONTENT_KEY = new Set([
  'text',
  'content',
  'transcript',
  'prompt',
  'messages',
  'body',
  'html',
  'markdown',
  'lyrics',
  'reference',
  'script',
  'original',
  'corrected',
  'context',
  'audio',
  'audiodata',
  'base64audio',
  'dataurl',
  'image',
  'imagedata',
])

/** 被隐去的值只留尺寸，不留内容 */
function summarize(value: unknown): string {
  if (typeof value === 'string') return `[已隐去:文本 ${value.length} 字符]`
  if (Array.isArray(value)) return `[已隐去:数组 ${value.length} 条]`
  if (value === null || value === undefined) return '[已隐去]'
  if (typeof value === 'object') return `[已隐去:对象 ${Object.keys(value).length} 个字段]`
  return `[已隐去:${typeof value}]`
}

const DATA_URI = /data:[^"'`\s]{0,200}?;base64,[A-Za-z0-9+/=]{8,}/gi
const SK_STYLE_KEY = /\bsk-[A-Za-z0-9_\-]{6,}\b/g
/** 裸着的 `Bearer <jwt>`（没有 `Authorization:` 前缀那种，多半是从 header 值里单独抄出来的） */
const BEARER = /\b(bearer[ \t]+)[A-Za-z0-9._\-]{6,}/gi
/**
 * `名字: 值` / `名字=值` 形式的凭据。值这一段允许带一个 `Bearer ` 前缀：
 * `Authorization: Bearer eyJ…` 是 HTTP header 最常见的写法，不把这一节收进值里，
 * 下面那条 BEARER 就会先把它打成 `Bearer ****`，再被这一条把 `Bearer` 当成值吃掉，
 * 剩下 `Authorization: ****`——字没漏，但读日志的人分不清这是 Bearer 还是 Basic。
 */
const INLINE_SECRET =
  /\b(api[_-]?key|apikey|secret|access[_-]?key|token|password|passwd|authorization)(["']?\s*[:=]\s*)((?:bearer[ \t]+)?[^\s"',;)\]]{6,})/gi
/** file:///a/b/c.ts → /a/b/c.ts，好让下面那条路径规则一并收掉 */
const FILE_SCHEME = /file:\/\/(?=\/)/gi
/**
 * 绝对路径：必须以 / 开头且至少两段，前一个字符只能是空白或引号括号那几种。
 * 这条约束是为了不破掉 `http://host/path`（第二个斜杠前面还是斜杠 → 不匹配）和 `:8010/v1/tts`
 * （端口数字直接挨着斜杠 → 不匹配）；`/health` 这种单段也不动。
 * 段内字符用 `\p{L}\p{N}`（不是 `[A-Za-z0-9]`）：这应用装的就是中文命名的媒体文件，
 * 写成 ASCII 类的话 `/Users/daqi/Movies/采访第3期.mp3` 只会匹配到 `Movies` 为止，
 * 用户名和目录名收掉了、`Movies/采访第3期.mp3` 照抄进盘——那是最难发现的一种漏。
 */
const POSIX_PATH = /(?:^|(?<=[\s"'=([]))((?:\/[\p{L}\p{N}._~+@-]+){2,})/gu
const WINDOWS_PATH = /(?:^|(?<=[\s"'=(]))[A-Za-z]:[\\/][^\s"'`<>|:;?*,)]{1,200}/g
/** 只收掉带凭据形状参数的查询串，公开链接的 `?v=1` 那种没必要毁 */
const SUSPECT_QUERY = /[?&][^#=]*(?:sig|token|key|secret|password|credential|expires|policy|auth)[^#=]*=/i

/** 一眼能认出是「某台机器的目录树」的首段：这种即使只有两段也要收，`/Users/<用户名>` 本身就是隐私 */
const KNOWN_ROOTS = new Set([
  'users',
  'home',
  'var',
  'private',
  'tmp',
  'temp',
  'volume',
  'volumes',
  'applications',
  'opt',
  'usr',
  'system',
  'library',
  'mnt',
  'media',
  'root',
  'programdata',
])

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  /**
   * 两段又没有一个带扩展名、首段也不像机器目录树的根（`/v1/models`、`/health`）多半是接口路径，
   * 不是用户的文件，收成 `models` 只会让人看不懂日志——这种原样留着。
   */
  const looksLikeFilePath = parts.some((part) => /\.[A-Za-z0-9]{1,8}$/.test(part))
  const rootedAt = KNOWN_ROOTS.has((parts[0] ?? '').toLowerCase())
  if (parts.length < 3 && !looksLikeFilePath && !rootedAt) return path
  return last
}

/** 文本里裸着的凭据、内嵌音频、绝对路径；顺序有讲究：先拆 data URI，再谈路径 */
export function redactText(text: string): string {
  let out = text
    .replace(DATA_URI, '[data 内嵌内容已隐去]')
    .replace(SK_STYLE_KEY, 'sk-****')
    .replace(INLINE_SECRET, (_all, name: string, sep: string, value: string) => {
      const withScheme = /^bearer[ \t]+/i.exec(value)
      return `${name}${sep}${withScheme ? `${value.slice(0, withScheme[0].length)}****` : '****'}`
    })
    .replace(BEARER, '$1****')
    .replace(FILE_SCHEME, '')

  out = out.replace(/https?:\/\/[^\s"'`<>()]+/g, (url) =>
    SUSPECT_QUERY.test(url) ? url.replace(/\?.*/, '?…（查询参数已隐去）') : url
  )

  out = out.replace(POSIX_PATH, (_all, path: string) => basenameOf(path))
  out = out.replace(WINDOWS_PATH, (path) => basenameOf(path))
  return out
}

/** 长文本两头各留一半：决定性的话常常在尾巴上（ffprobe 那句 No such file 就是） */
export function clampText(text: string, max: number = MAX_STRING): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  const dropped = text.length - half * 2
  return `${text.slice(0, half)}…（中间省略 ${dropped} 字符，共 ${text.length}）…${text.slice(text.length - half)}`
}

/**
 * 递归处理一个 data 载荷：按键名隐去、按形状改写、按条数与深度截断。
 * 返回的仍是一个能被 JSON.stringify 的值，不预先 stringify——否则丢掉结构，
 * 「哪个字段是空的」和「哪个字段被隐去了」就分不开了。
 */
export function redactValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return clampText(redactText(value))
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'function') return `[函数 ${value.name || '匿名'}]`
  if (typeof value === 'symbol') return `[符号 ${String(value.description ?? '')}]`

  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return `[二进制 ${value.length} 字节]`
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const bytes = value instanceof ArrayBuffer ? value.byteLength : value.byteLength
    return `[二进制 ${bytes} 字节]`
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    // Error 直接 stringify 会得到 {}，所以显式收 message 与 stack 两项
    return {
      message: clampText(redactText(value.message ?? '')),
      stack: value.stack ? clampText(redactText(value.stack)) : undefined,
    }
  }

  if (depth >= MAX_DEPTH) return `[已截断:超过 ${MAX_DEPTH} 层]`
  if (seen.has(value as object)) return '[循环引用]'
  seen.add(value as object)

  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1, seen))
    if (value.length > MAX_ARRAY_ITEMS) {
      kept.push(`[其余 ${value.length - MAX_ARRAY_ITEMS} 条已省略，共 ${value.length} 条]`)
    }
    return kept
  }

  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    const norm = normKey(key)
    if (CREDENTIAL_KEY.test(norm) || CONTENT_KEY.has(norm)) {
      out[key] = summarize(item)
    } else {
      out[key] = redactValue(item, depth + 1, seen)
    }
  }
  return out
}

/** 一条日志在序列化之前要过的这道闸门 */
export function redactEntry(
  message: string,
  data: unknown
): { message: string; data: unknown } {
  return {
    message: clampText(redactText(typeof message === 'string' ? message : String(message ?? ''))),
    data: redactValue(data),
  }
}
