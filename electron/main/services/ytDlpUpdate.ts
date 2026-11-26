/**
 * yt-dlp 组件的应用内更新
 *
 * 为什么要它：yt-dlp 每隔几周就得跟着站点改解析规则，而安装包里的这一版是发布那天钉死的。
 * 没有应用内更新，用户遇到「昨天还能解析，今天全失败」就只能整包重装 —— 于是这条链路
 * 变成「网站写着支持，实际取决于你哪天装的包」。
 *
 * 信任模型（自家清单，不是上游自证）：
 * - 版本与 SHA2-256 指纹来自仓库里人工核对后提交的 yt-dlp-manifest.json；
 * - 下载地址由本文件拼死（下面的候选前缀表 + 清单里的版本号与资产名，两者都过正则），
 *   清单里没有 URL 字段，所以换掉清单也指不到别的服务器；多出来那条加速前缀拼的是同一个
 *   「版本号/资产名」，只换 host，而换 host 换不掉下面那道指纹闸门；
 * - 下载完先比对字节数与指纹再落地，不匹配就删掉临时文件，绝不留下半个二进制；
 * - 剩下的边界：能写这个仓库的人可以同时换掉清单和官方 release 产物（同源自证，#182 记着）。
 *   构建期的第二道关（scripts/fetch-yt-dlp.mjs、pnpm check:yt-dlp-manifest 与上游 sums 对账）
 *   只覆盖安装包，覆盖不到用户机器上的这次下载。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { net } from 'electron'
import { formatBytes } from '../../../src/utils/formatBytes'
import { logger } from './logger'
import {
  EARLY_BUDGET,
  LAST_BUDGET,
  WATCHDOG_MS,
  hostOf,
  stallReason,
  type Budget,
} from './componentService'
import {
  hasActiveMediaDownload,
  invalidateYtDlpProbes,
  probeYtDlpVersion,
  resolveYtDlp,
  updatedYtDlpPath,
  type YtDlpSource,
} from './urlDownloader'

const TAG = 'YtDlpUpdate'

/**
 * 清单的两个读法，按顺序试：
 * - raw.githubusercontent.com：不需要鉴权、没有速率限制，但国内直连时很慢。
 *   本机实测第一次 20 秒没吐出首字节、重试才在 30 秒内完成。
 * - api.github.com 的 contents 接口（Accept 要 raw）：应用检查自己更新时已经在用这个域名，
 *   本机实测 0.77 秒返回。未鉴权有 60 次/小时的速率限制，用户点一下「检查组件更新」远用不完。
 */
const MANIFEST_URLS = [
  'https://raw.githubusercontent.com/DaQI-X/Vv-Transcribe/main/yt-dlp-manifest.json',
  'https://api.github.com/repos/DaQI-X/Vv-Transcribe/contents/yt-dlp-manifest.json?ref=main',
]

/**
 * 拼下载地址的前缀表，顺序即试序：官方原件在前，公开加速前缀在后。三条拼的是同一个
 * 「版本号/资产名」，换的只是 host，下面那道 SHA2-256 闸门来自清单、换 host 换不掉它。
 *
 * 为什么不把加速前缀放前面（#413 调研时另一种推荐）：那样每位用户的二进制默认都出自第三方镜像，
 * 官方原件反倒只在镜像出问题时才用。放在第二腿，它只在「官方被速率判死」时上场——正常网络下
 * 用户拿到的仍是官方那份，多花的成本是最坏 3 秒快刀时间。本机实测 2026-11-24 同一段时间窗：
 * 官方 23 秒只漏进 351KB（≈13.8KB/s），加速前缀整份 37MB 用 9.9 秒（≈3.8MB/s）且落地指纹
 * 与清单逐字符相同。第三方的可用性不作假设：它挂了就走「兜回第一腿」那条慢但正确的一棒。
 *
 * 第三腿（gh-proxy.com，#423）是为「单点」本身加的，不是为了提速：#423 摸底时试了几枚公开前缀，
 * 从本机直连只有这两枚能整份取回（其余要么不通，要么慢到取不完，`ghproxy.net` 实测 5.9KB/s），
 * 只留一枚等于把换源这件事押在一家的心情上。本机实测 2026-11-26 同一份资产
 * （37,180,736 字节，落地 SHA2-256 与清单逐字符相同）：gh-proxy.com 74.6 秒、ghfast.top 119.6 秒，
 * 官方直连 15 秒内 0 字节——同一枚前缀的速率在两天之间从 3.8MB/s 掉到 0.3MB/s，
 * 这正是不能只靠一枚的实测理由。新那枚放在最后一棒而不是第二棒：最后一棒不吃快刀、有 20 分钟
 * 耐心，把它给已经在 1.2.3 真实用户链路上跑通过的那一枚，未经使用的候选先只当兜底。
 */
const RELEASE_BASES = [
  'https://github.com/yt-dlp/yt-dlp/releases/download',
  'https://ghfast.top/https://github.com/yt-dlp/yt-dlp/releases/download',
  'https://gh-proxy.com/https://github.com/yt-dlp/yt-dlp/releases/download',
]

/** 拼这一版的候选地址；导出只为让单测钉得住表序与「每条拼的是同一份版本号/资产名」 */
export function releaseUrls(entry: Pick<ManifestEntry, 'version' | 'asset'>): string[] {
  return RELEASE_BASES.map((base) => `${base}/${entry.version}/${entry.asset}`)
}

/** 与 scripts/lib/yt-dlp-manifest.mjs 一致：日历版本号 */
const VERSION_RE = /^\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/
/** 资产名会直接拼进下载 URL，所以不允许 / 与 .. */
const ASSET_RE = /^[A-Za-z0-9._-]+$/
const SHA256_RE = /^[0-9a-f]{64}$/

const NETWORK_HINT = '连不上更新服务器（多为国内直连 GitHub 过慢或被拦所致），可开启网络加速后重试'

/** 清单里本机这一条 */
interface ManifestEntry {
  version: string
  asset: string
  sha256: string
  bytes: number
}

export interface YtDlpLocalInfo {
  version: string | null
  source: YtDlpSource
  /** 磁盘上的实际字节数，文件不存在时为 null */
  bytes: number | null
}

export interface YtDlpCheckResult {
  ok: boolean
  error: string | null
  local?: YtDlpLocalInfo
  remote?: { version: string; bytes: number }
  hasUpdate?: boolean
}

export interface YtDlpApplyResult {
  success: boolean
  error?: string
  version?: string
  bytes?: number
  /** 更新后跑不起来，已把原来的副本换回去（安装包内置的那份仍然可用） */
  rolledBack?: boolean
  /** 失败特征像「系统拦住了这个二进制的执行」，界面据此给「打开隐私设置」按钮 */
  systemSettingsHint?: boolean
}

export interface YtDlpProgress {
  received: number
  total: number
}

/** 探测本机当前生效的那份 yt-dlp。spawn 一次要一两秒，只在用户主动看这一栏时才做 */
export async function getLocalYtDlpInfo(): Promise<YtDlpLocalInfo> {
  const resolved = resolveYtDlp()
  const version = await probeYtDlpVersion(resolved.path)
  let bytes: number | null = null
  try {
    bytes = (await stat(resolved.path)).size
  } catch {
    // 走 PATH 兜底且命令不存在时探不到体积，界面显示「未知」而不是编一个数
  }
  logger.info(TAG, 'local yt-dlp', {
    path: resolved.path,
    source: resolved.source,
    version,
    bytes,
  })
  return { version, source: resolved.source, bytes }
}

/**
 * VV_YTDLP_MANIFEST_URL 是自测口子：指到本机静态服务就能在不往 main 推送的前提下跑完整链路。
 * 它只换「清单从哪读」，不换「二进制从哪下」——后者永远是上面那个官方前缀，所以这个口子
 * 撑不开「把用户机器上的二进制换成攻击者的文件」这条路：伪造清单的人还得给出官方产物的真指纹。
 */
function manifestUrls(): string[] {
  const override = process.env.VV_YTDLP_MANIFEST_URL
  return override ? [override] : MANIFEST_URLS
}

/** 本机该取清单里哪一条：macOS 官方包是 Universal，两种架构共用一份，其余按 platform-arch */
function manifestKey(): string {
  if (process.platform === 'darwin') return 'darwin-universal'
  return `${process.platform}-${process.arch}`
}

/** 网络回来的 JSON 一律当外部输入对待：逐字段验，任何一条不合规矩就整份拒绝 */
function pickEntry(raw: unknown, key: string): ManifestEntry {
  if (raw === null || typeof raw !== 'object') throw new Error('更新清单不是一个对象')
  const manifest = raw as Record<string, unknown>
  if (manifest.component !== 'yt-dlp') throw new Error('更新清单的 component 不是 yt-dlp')
  if (typeof manifest.version !== 'string' || !VERSION_RE.test(manifest.version)) {
    throw new Error('更新清单里的版本号不合规矩（应为 yt-dlp 的日历版本号）')
  }
  const assets = manifest.assets
  if (assets === null || typeof assets !== 'object') throw new Error('更新清单缺少 assets')
  const entry = (assets as Record<string, unknown>)[key]
  if (entry === null || typeof entry !== 'object')
    throw new Error(`更新清单没有 ${key} 这一条，这个平台没有对应的更新包`)
  const { upstream, sha256, bytes } = entry as Record<string, unknown>
  if (typeof upstream !== 'string' || !ASSET_RE.test(upstream)) {
    throw new Error(`更新清单里 ${key} 的资产名不合法`)
  }
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
    throw new Error(`更新清单里 ${key} 的 sha256 不是 64 位小写十六进制`)
  }
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0) {
    throw new Error(`更新清单里 ${key} 的体积不是正整数`)
  }
  return { version: manifest.version, asset: upstream, sha256, bytes }
}

/**
 * 走 Electron 的 net.fetch 而不是全局 fetch：全局 fetch 是 Node 的实现，
 * 只认 HTTP_PROXY 环境变量，看不见系统代理；net.fetch 走 Chromium 网络栈，会跟随系统的代理/PAC。
 * 本机实测（VPN 系统代理开着）：全局 fetch 直连 GitHub releases 约 19KB/s，37MB 要 30 分钟以上；
 * 同一个资产经代理约 0.5MB/s。这一栏能不能更新完，取决于这里用哪个。
 *
 * cache: 'no-store' 的理由同 componentService 的 netFetch —— 大二进制不进 Chromium 磁盘缓存。
 */
const netFetch = (url: string, init: Parameters<typeof net.fetch>[1]) =>
  net.fetch(url, { ...init, cache: 'no-store' })

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await netFetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // contents 接口只有带上这个 Accept 才直接回文件正文，否则回的是包一层 base64 的元数据
        Accept: 'application/vnd.github.raw+json',
        'User-Agent': 'vv-transcribe',
      },
    })
    if (!res.ok) throw new Error(`更新服务器返回 ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 判定「这是网络问题还是清单问题」：只有前者才配得上那句加速建议。
 * net.fetch 走的是 Chromium 网络栈，失败时抛的是 net::ERR_CONNECTION_REFUSED / ERR_NAME_NOT_RESOLVED
 * 这类错误码（本机实测），和 Node 的 ECONN* 完全不是一套字样，两边都得列进来。
 */
const NETWORK_ERROR_RE =
  /net::ERR_|abort|Failed to fetch|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i

/** 两个域名都失败时把两次的原因都带上，否则「连不上」这种话用户没法判断是网还是清单 */
async function fetchEntry(key: string): Promise<ManifestEntry> {
  const failures: string[] = []
  for (const url of manifestUrls()) {
    try {
      return pickEntry(await fetchJson(url), key)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push(message)
      logger.warn(TAG, 'manifest fetch failed', { url, message })
      // 结构不合规矩是清单本身的问题，换域名再读一遍还是同一份文件，直接停
      if (!/更新服务器返回\s*(4\d{2}|5\d{2})/.test(message) && !NETWORK_ERROR_RE.test(message))
        break
    }
  }
  // 「开网络加速」只对网络失败有意义：404 是服务器答得清清楚楚「这份清单不在」，
  // 挂上加速照样 404，那句话会把人引去查自己家的网（本机实测：清单还没合进 main 时就是两次 404）
  const allNetwork = failures.every((message) => NETWORK_ERROR_RE.test(message))
  const detail = failures.length === 1 ? failures[0] : `两个入口分别：${failures.join(' / ')}`
  if (failures.length === 1 && !allNetwork) throw new Error(detail)
  throw new Error(`${allNetwork ? NETWORK_HINT : '更新清单读取失败'}（${detail}）`)
}

/** 逐段按数字比，字符串比会把 2026.10.9 判成比 2026.10.21 新 */
function isOlderThan(local: string, remote: string): boolean {
  const a = local.split('.').map((n) => parseInt(n, 10) || 0)
  const b = remote.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

export async function checkYtDlpUpdate(): Promise<YtDlpCheckResult> {
  const key = manifestKey()
  const local = await getLocalYtDlpInfo()
  try {
    const entry = await fetchEntry(key)
    const remote = { version: entry.version, bytes: entry.bytes }
    // 本机版本探不出来（内置那份被 Gatekeeper 拦了、或走的是 PATH 上的怪包装）时不能说「已是最新」，
    // 也不能假装更新成功过——把未知如实报出来，并把「试一次更新」作为出路给出。
    const hasUpdate = local.version === null || isOlderThan(local.version, remote.version)
    logger.info(TAG, 'yt-dlp update checked', {
      key,
      local: local.version,
      source: local.source,
      remote: remote.version,
      hasUpdate,
    })
    return { ok: true, error: null, local, remote, hasUpdate }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(TAG, 'yt-dlp update check failed', message)
    return { ok: false, error: message, local }
  }
}

export async function applyYtDlpUpdate(
  onProgress?: (p: YtDlpProgress) => void
): Promise<YtDlpApplyResult> {
  if (hasActiveMediaDownload()) {
    return {
      success: false,
      error: '有链接正在解析，等它结束后再更新组件（Windows 上运行中的程序文件改不动）',
    }
  }

  const key = manifestKey()
  const target = updatedYtDlpPath()
  const partFile = `${target}.part`
  const prevFile = `${target}.prev`

  let entry: ManifestEntry
  try {
    entry = await fetchEntry(key)
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  const urls = releaseUrls(entry)
  logger.info(TAG, 'downloading yt-dlp update', { urls, sha256: entry.sha256, bytes: entry.bytes })

  try {
    await mkdir(dirname(target), { recursive: true })
    const from = await downloadToPartFile(urls, partFile, entry, onProgress)
    logger.info(TAG, 'download finished with matching fingerprint', {
      url: from,
      bytes: entry.bytes,
    })
    return await promotePartFile(partFile, target, prevFile, entry)
  } catch (err) {
    await rm(partFile, { force: true }).catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    logger.error(TAG, 'yt-dlp update failed', message)
    if (isExecBlocked(err)) {
      return {
        success: false,
        systemSettingsHint: true,
        error: '组件文件没能写入或运行，请到「系统设置 → 隐私与安全性」允许 Vv Transcribe 后重试',
      }
    }
    return { success: false, error: message }
  }
}

/** 某个源亲口说「这一版里没有这份件」——对它的重跑只会再拿到同一个 404，不该兜回 */
class AbsentAtSource extends Error {}

/**
 * 最后一棒的预算：沿用 #407 那份不设快刀的耐心阈值，只把硬上限收在本文件原本那句 20 分钟
 * （37MB 的包，慢网里十几分钟是常态，但不能无限挂着把界面钉死在「更新中」）。
 */
const LAST_LEG: Budget = { ...LAST_BUDGET, hardMs: 20 * 60_000 }

/**
 * 按候选前缀的顺序把文件取到 `.part`，字节数与 SHA2-256 两道闸门都过才算成；任一棒没过就换下一棒，
 * 全棒失败才抛。返回成功那一棒的地址——日志要靠它说清这份二进制是从哪个 host 拿的。
 * 队列形状与阈值都取自组件那条链路（#407 导出的那一份），两条下载路径共用一把尺子，
 * 免得日后调「这一棒算不算取不动」时只调了一边。
 * 没有直接复用它的 downloadToPart：那一个要把用户的「取消」开关串进本棒 signal，进度还要按组件 id
 * 归到另一根条上；这条一次性更新没有取消入口，硬套得先造两个假对象。
 * 导出只为让单测能喂假网络：换源会不会真发生、换 host 换不换得掉指纹闸门，走公开 API 测要把
 * 清单服务、归档、探测版本整条链都搭起来。
 */
export async function downloadToPartFile(
  urls: string[],
  partFile: string,
  entry: ManifestEntry,
  onProgress?: (p: YtDlpProgress) => void
): Promise<string> {
  const problems: string[] = []
  const absent = new Set<string>()
  const delivered = new Set<string>()
  /** 某一棒抛的是 EACCES/EPERM 时把 errno 带出去，界面那颗「打开隐私设置」的按钮靠它才点得出来 */
  let blocked: string | undefined

  const take = async (url: string, budget: Budget, note: string): Promise<boolean> => {
    const label = `${hostOf(url)}${note}`
    let taken: { received: number; digest: string }
    try {
      taken = await downloadOnce(url, partFile, entry, budget, onProgress)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof AbsentAtSource) absent.add(url)
      if (isExecBlocked(err)) blocked = (err as NodeJS.ErrnoException).code
      problems.push(`${label}：${message}`)
      logger.warn(TAG, 'yt-dlp download attempt failed', { url, error: message })
      return false
    }
    if (taken.received !== entry.bytes) {
      problems.push(
        `${label}：下载不完整（收到 ${formatBytes(taken.received)} / 应有 ${formatBytes(entry.bytes)}）`
      )
      return false
    }
    // 走到这里，这个源已经把整份文件交出来了：下面拒的是内容，不是链路，重跑它等于再赌一次
    delivered.add(url)
    if (taken.digest !== entry.sha256) {
      logger.error(TAG, 'yt-dlp fingerprint mismatch', {
        url,
        expected: entry.sha256,
        actual: taken.digest,
      })
      problems.push(
        `${label}：指纹和更新清单对不上（${taken.digest.slice(0, 12)}… ≠ ${entry.sha256.slice(0, 12)}…）`
      )
      return false
    }
    return true
  }

  for (const [index, url] of urls.entries()) {
    const budget = index === urls.length - 1 ? LAST_LEG : EARLY_BUDGET
    if (await take(url, budget, '')) {
      if (index > 0)
        logger.info(TAG, 'yt-dlp recovered from another source', { url, attempts: index + 1 })
      return url
    }
  }

  /**
   * 兜回第一腿：换源只能让这条链路变好，不能把「慢但本来能下完」变成彻底失败——快刀掐断官方、
   * 加速前缀又恰好关站时，得有人用不设快刀的预算把官方那一棒跑完。判据与组件那条一致：
   * 官方既没亲口说没有（absent），也没整份交出来过（delivered）才补跑。
   */
  const first = urls[0]
  if (urls.length > 1 && !absent.has(first) && !delivered.has(first)) {
    if (await take(first, LAST_LEG, '（换回官方源跑到底）')) return first
  }

  /**
   * 「挂加速」只对链路有意义：指纹对不上是源上那份内容不对，网络再快拿回来的还是它
   * （判据同 fetchEntry 里那句「404 不套 NETWORK_HINT」）。
   */
  const tail = problems.every((problem) => problem.includes('指纹'))
    ? '（换网络不会让它对上）'
    : '。可开启网络加速后重试'
  const text =
    problems.length === 1
      ? `${problems[0]}${tail}`
      : `几个源都没取到 ${entry.asset}：${problems.join('；')}${tail}`
  const err = new Error(text)
  if (blocked) (err as NodeJS.ErrnoException).code = blocked
  throw err
}

/**
 * 从一个源取一棒：边下边算 SHA2-256，进度按 200ms 节流上报（37MB 分块回来有几百个回调，
 * 每个都发等于刷屏）。没有断点续传，换棒就是从 0 再来一遍，所以进棒先清掉上一棒的半件。
 */
async function downloadOnce(
  url: string,
  partFile: string,
  entry: ManifestEntry,
  budget: Budget,
  onProgress?: (p: YtDlpProgress) => void
): Promise<{ received: number; digest: string }> {
  await rm(partFile, { force: true })

  const controller = new AbortController()
  const startedAt = Date.now()
  let lastTouch = Date.now()
  let lastReport = 0
  let received = 0
  let stalled = ''
  const hash = createHash('sha256')
  const watchdog = setInterval(() => {
    const reason = stallReason(Date.now(), startedAt, lastTouch, received, budget)
    if (reason) {
      stalled = reason
      controller.abort()
    }
  }, WATCHDOG_MS)
  const hardTimer = setTimeout(() => {
    stalled = `约 ${formatBytes(entry.bytes)} 在 ${Math.round(budget.hardMs / 60_000)} 分钟内没下完`
    controller.abort()
  }, budget.hardMs)

  try {
    const res = await netFetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'vv-transcribe' },
    })
    if (!res.ok) {
      // 只有 404 算「这个源亲口说没有」：上面兜回第一腿那条判据要靠它区分「重跑没意义」和「这棒没跑动」
      if (res.status === 404) {
        throw new AbsentAtSource(
          `下载失败 ${res.status}（${entry.asset} 在 ${entry.version} 这一版里取不到？）`
        )
      }
      throw new Error(`下载失败 ${res.status}（${hostOf(url)} 这一棒没取到文件）`)
    }
    if (!res.body) throw new Error('下载响应没有内容')
    const handle = await open(partFile, 'w')
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        hash.update(chunk)
        received += chunk.length
        lastTouch = Date.now()
        await handle.write(chunk)
        const now = Date.now()
        if (now - lastReport > 200) {
          lastReport = now
          onProgress?.({ received, total: entry.bytes })
        }
      }
    } finally {
      await handle.close()
    }
    onProgress?.({ received, total: entry.bytes })
  } catch (err) {
    if (err instanceof AbsentAtSource) throw err
    // 判死原因优先于错误本身：看门狗 abort 之后 body stream 抛回来的只是「流被中断」那句，
    // 把它包成「请求没通到对端」就把「3 秒只进来 351KB」这条真判据弄丢了（顺序同 attemptDownload）
    if (stalled || (err as { name?: string })?.name === 'AbortError') {
      throw new Error(
        `${stalled || '下载中断'}（已收到 ${formatBytes(received)} / 约 ${formatBytes(entry.bytes)}）`
      )
    }
    const message = err instanceof Error ? err.message : String(err)
    if (NETWORK_ERROR_RE.test(message)) throw new Error(`请求没通到对端（${message}）`)
    throw err
  } finally {
    clearInterval(watchdog)
    clearTimeout(hardTimer)
  }

  return { received, digest: hash.digest('hex') }
}

/**
 * 校验过了才动现有文件：先把上一轮的副本挪去 .prev，出任何问题都能换回去。
 * 挪完立刻重新探版本——路径没变但文件换了，按路径缓存的「支不支持浏览器模拟」还是旧结论，
 * 不重探的话 --impersonate chrome 会一直按上一版的能力来拼参数。
 */
async function promotePartFile(
  partFile: string,
  target: string,
  prevFile: string,
  entry: ManifestEntry
): Promise<YtDlpApplyResult> {
  if (process.platform !== 'win32') await chmod(partFile, 0o755)

  const hadPrevious = existsSync(target)
  if (hadPrevious) await rename(target, prevFile)
  try {
    await rename(partFile, target)
  } catch (err) {
    if (hadPrevious) await rename(prevFile, target).catch(() => {})
    throw err
  }

  invalidateYtDlpProbes()
  const applied = await probeYtDlpVersion(target)
  if (applied === entry.version) {
    await rm(prevFile, { force: true }).catch(() => {})
    logger.info(TAG, 'yt-dlp updated', { version: applied, path: target })
    return { success: true, version: applied, bytes: entry.bytes }
  }

  const restoredText = hadPrevious ? '，已换回原来的副本' : '，已删除，安装包内置的那份仍然可用'
  if (hadPrevious) await rename(prevFile, target).catch(() => {})
  else await rm(target, { force: true }).catch(() => {})
  invalidateYtDlpProbes()
  logger.error(TAG, 'yt-dlp update failed to run, rolled back', {
    expected: entry.version,
    got: applied,
  })
  return {
    success: false,
    rolledBack: true,
    // 探不到版本 = 下载完整却跑不起来，macOS 上最典型的就是未授权执行
    systemSettingsHint: applied === null && process.platform === 'darwin',
    error:
      applied === null
        ? `新版组件下载成功但没能运行${restoredText}。可能是系统拦住了它的执行，请到「系统设置 → 隐私与安全性」允许后再试`
        : `新版组件下载后自报版本为 ${applied}，与更新清单的 ${entry.version} 不符${restoredText}`,
  }
}

/** EACCES/EPERM 在两个系统上都可能是「系统拦住了这个文件的执行/写入」，值得单独给按钮 */
function isExecBlocked(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code
  return code === 'EACCES' || code === 'EPERM'
}
