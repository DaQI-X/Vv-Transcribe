/**
 * yt-dlp 组件的应用内更新
 *
 * 为什么要它：yt-dlp 每隔几周就得跟着站点改解析规则，而安装包里的这一版是发布那天钉死的。
 * 没有应用内更新，用户遇到「昨天还能解析，今天全失败」就只能整包重装 —— 于是这条链路
 * 变成「网站写着支持，实际取决于你哪天装的包」。
 *
 * 信任模型（自家清单，不是上游自证）：
 * - 版本与 SHA2-256 指纹来自仓库里人工核对后提交的 yt-dlp-manifest.json；
 * - 下载地址由本文件拼死（官方 release 前缀 + 清单里的版本号与资产名，两者都过正则），
 *   清单里没有 URL 字段，所以换掉清单也指不到第三方服务器；
 * - 下载完先比对指纹再落地，不匹配就删掉临时文件，绝不留下半个二进制；
 * - 剩下的边界：能写这个仓库的人可以同时换掉清单和官方 release 产物（同源自证，#182 记着）。
 *   构建期的第二道关（scripts/fetch-yt-dlp.mjs、pnpm check:yt-dlp-manifest 与上游 sums 对账）
 *   只覆盖安装包，覆盖不到用户机器上的这次下载。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { net } from 'electron'
import { logger } from './logger'
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

/** 官方 release 资产前缀，写死。清单改不了它 */
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/download'

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
 */
const netFetch = (url: string, init: Parameters<typeof net.fetch>[1]) => net.fetch(url, init)

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

  const url = `${RELEASE_BASE}/${entry.version}/${entry.asset}`
  logger.info(TAG, 'downloading yt-dlp update', { url, sha256: entry.sha256, bytes: entry.bytes })

  try {
    await mkdir(dirname(target), { recursive: true })
    await rm(partFile, { force: true })
    const received = await downloadToPartFile(url, partFile, entry, onProgress)

    if (received !== entry.bytes) {
      await rm(partFile, { force: true })
      return {
        success: false,
        error: `下载不完整（收到 ${received} / 应有 ${entry.bytes} 字节），已放弃`,
      }
    }
    logger.info(TAG, 'download finished with matching fingerprint', { url, bytes: received })
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

/** 边下边算 SHA2-256，进度按 200ms 节流上报（37MB 分块回来有几百个回调，每个都发等于刷屏） */
async function downloadToPartFile(
  url: string,
  partFile: string,
  entry: ManifestEntry,
  onProgress?: (p: YtDlpProgress) => void
): Promise<number> {
  const controller = new AbortController()
  // 按 37MB 的包算：慢网里这一下可能是十几分钟。给足余量，但不能无限挂着把界面钉死在「更新中」
  const timer = setTimeout(() => controller.abort(), 20 * 60_000)
  let received = 0
  let lastReport = 0
  const hash = createHash('sha256')
  try {
    const res = await netFetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'vv-transcribe' },
    })
    if (!res.ok) {
      throw new Error(
        `下载失败 ${res.status}（${entry.asset} 在 ${entry.version} 这个 release 里不存在？）`
      )
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
    // 超时中断原生抛的是 "The operation was aborted"，用户看了只会以为程序坏了
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new Error(
        `下载超时：约 ${(entry.bytes / 1e6).toFixed(0)}MB 在 20 分钟内没下完（收到 ${(received / 1e6).toFixed(1)}MB）。可开启网络加速后重试`
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
  }

  const digest = hash.digest('hex')
  if (digest !== entry.sha256) {
    logger.error(TAG, 'yt-dlp update hash mismatch', { expected: entry.sha256, actual: digest })
    throw new Error(
      `校验不通过：下载到的文件与更新清单的指纹不一致（${digest.slice(0, 12)}… ≠ ${entry.sha256.slice(0, 12)}…），已放弃`
    )
  }
  return received
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
