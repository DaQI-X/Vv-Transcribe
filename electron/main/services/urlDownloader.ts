/**
 * URL 下载服务
 * 使用 yt-dlp 从视频/音频链接下载媒体文件到临时目录
 * 优先用无头浏览器获取 cookies → yt-dlp with --cookies cookies.txt
 * 降级：yt-dlp without cookies
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { app } from 'electron'
import { logger } from './logger'
import { fetchCookiesFromUrl, cleanupBrowserTemp } from './browserCookieFetcher'

export interface DownloadResult {
  success: boolean
  filePath?: string
  tempDir?: string
  title?: string
  error?: string
  /** 失败原因是「系统层面拦住了包内二进制执行」时置真：界面据此给「打开隐私设置」按钮 */
  systemSettingsHint?: boolean
}

/** 获取 ffmpeg 二进制路径（适配打包环境） */
function getFfmpegPath(): string | null {
  const isPackaged = process.env.NODE_ENV === 'production' || app.isPackaged
  const platform = process.platform
  const arch = process.arch

  if (isPackaged) {
    const unpackedPath = join(
      process.resourcesPath || '',
      'app.asar.unpacked',
      'node_modules',
      '@ffmpeg-installer',
      `${platform}-${arch}`,
      platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    )
    if (existsSync(unpackedPath)) {
      logger.info('UrlDownloader', 'Found bundled ffmpeg', { path: unpackedPath })
      return unpackedPath
    }
  }

  try {
    const resolved = require.resolve(
      `@ffmpeg-installer/${platform}-${arch}/${platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'}`
    )
    logger.info('UrlDownloader', 'Resolved ffmpeg path', { path: resolved })
    return resolved
  } catch {
    logger.warn('UrlDownloader', 'ffmpeg not found, yt-dlp postprocessing will fail')
    return null
  }
}

/** 内置二进制的落盘位置：打包后在 Resources/yt-dlp/，开发时在仓库 vendor/yt-dlp/<平台目录>/ */
function getBundledYtDlpPath(binary: string): string {
  if (process.env.VITE_DEV_SERVER_URL) {
    const dir =
      process.platform === 'darwin' ? 'darwin-universal' : `${process.platform}-${process.arch}`
    return join(import.meta.dirname, '../../vendor/yt-dlp', dir, binary)
  }
  return join(process.resourcesPath, 'yt-dlp', binary)
}

export type YtDlpSource = 'updated' | 'bundled' | 'system' | 'path'

/** 应用内更新的落点；resolveYtDlp 的第一优先级就是这个路径，两边必须用同一个函数取 */
export function updatedYtDlpPath(): string {
  const binary = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  return join(app.getPath('userData'), 'bin', binary)
}

/**
 * yt-dlp 可执行文件路径，按「用户更新过 > 安装包内置 > 本机安装 > PATH 兜底」取第一个存在的。
 * 内置档排在系统档前面：包里的版本至少保证「能跑起来」，而 Homebrew 装的那台机器可能根本没装、
 * 也可能被别的软件改过。用户手装的版本仍走最后一档，不算丢功能。
 */
export function resolveYtDlp(): { path: string; source: YtDlpSource } {
  const binary = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  const candidates: Array<{ path: string; source: YtDlpSource }> = [
    // 应用内更新的副本落在 userData/bin，升级不需要重装整包（写入方见 ytDlpUpdate.ts）
    { path: updatedYtDlpPath(), source: 'updated' },
    { path: getBundledYtDlpPath(binary), source: 'bundled' },
    ...(process.platform === 'darwin'
      ? [
          { path: '/opt/homebrew/bin/yt-dlp', source: 'system' as const },
          { path: '/usr/local/bin/yt-dlp', source: 'system' as const },
          { path: '/usr/bin/yt-dlp', source: 'system' as const },
        ]
      : []),
  ]

  const found = candidates.find((candidate) => existsSync(candidate.path))
  // 全都没有就交给 PATH：Windows 上 winget/scoop 装的位置千差万别，spawn 起不来会再提示安装
  return found ?? { path: binary, source: 'path' }
}

/**
 * 探测结果按路径缓存，省掉每次下载都白跑一次 --list-impersonate-targets。
 * 但「应用内更新」会原地换掉同一路径的文件，光按路径缓存就会读到上一版的结论，
 * 所以更新成功后必须调 invalidateYtDlpProbes()。
 */
const impersonateCache = new Map<string, boolean>()
const versionCache = new Map<string, string | null>()

export function invalidateYtDlpProbes(): void {
  impersonateCache.clear()
  versionCache.clear()
}

/** 在途的媒体下载数量：Windows 上正在跑的 yt-dlp.exe 占着文件，改名会失败；更新流程据此拒绝执行 */
let mediaDownloads = 0
export function hasActiveMediaDownload(): boolean {
  return mediaDownloads > 0
}

/** yt-dlp 官方用日历版本号（2026.10.21，同天重发带第四段），从 --version 输出里抠出来 */
const PROBE_VERSION_RE = /\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?/

/**
 * 跑一次 yt-dlp 拿合并输出。这类探测只求「能不能跑、说了什么」，
 * 起不来（ENOENT、被 Gatekeeper 杀掉）统一回 null，由调用方按探测失败处理，不抛异常。
 * 带超时：包内二进制第一次跑要解包，正常几秒；真卡住（系统弹窗拦下执行）不能把
 * 更新流程挂在「更新中」永不返回，超时就按探测失败处理并回滚。
 */
function runYtDlpProbe(
  path: string,
  args: string[],
  timeoutMs = 30_000
): Promise<{ out: string; code: number | null } | null> {
  return new Promise((resolve) => {
    let out = ''
    let proc: ReturnType<typeof spawn>
    let settled = false
    const done = (value: { out: string; code: number | null } | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      logger.warn('UrlDownloader', 'yt-dlp probe timed out', { path, args, timeoutMs })
      try {
        proc.kill()
      } catch {
        /* 已经退了 */
      }
      done(null)
    }, timeoutMs)
    try {
      proc = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      done(null)
      return
    }
    proc.stdout?.on('data', (d) => {
      out += d.toString()
    })
    proc.stderr?.on('data', (d) => {
      out += d.toString()
    })
    proc.on('error', (err) => {
      logger.warn('UrlDownloader', 'yt-dlp probe failed to spawn', {
        path,
        args,
        error: err.message,
      })
      done(null)
    })
    proc.on('exit', (code) => done({ out, code }))
  })
}

/** 当前生效的 yt-dlp 报的版本号；探不出来是 null（版本未知的二进制不能算「已是最新」，界面要如实说） */
export async function probeYtDlpVersion(path: string): Promise<string | null> {
  if (versionCache.has(path)) return versionCache.get(path) ?? null
  const probe = await runYtDlpProbe(path, ['--version'])
  const version = probe?.code === 0 ? (PROBE_VERSION_RE.exec(probe.out)?.[0] ?? null) : null
  versionCache.set(path, version)
  logger.info('UrlDownloader', 'yt-dlp version probed', { path, version })
  return version
}

/** 验证 URL 是否为合法的 http/https 链接 */
function isValidMediaUrl(url: string): boolean {
  try {
    const urlObj = new URL(url)
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 探测 yt-dlp 是否支持 chrome 浏览器模拟（--impersonate）
 * 该能力依赖 Python 的 curl_cffi 包；系统自带的 yt-dlp（如 Homebrew）通常未安装，
 * 此时传入 --impersonate chrome 会直接报错 "Impersonate target chrome is not available"。
 * 探测方式：运行 --list-impersonate-targets 并检查输出是否包含 chrome。
 */
async function probeImpersonateSupport(path: string): Promise<boolean> {
  if (impersonateCache.has(path)) return impersonateCache.get(path) ?? false
  const probe = await runYtDlpProbe(path, ['--list-impersonate-targets'])
  const supported = probe?.code === 0 && /chrome/i.test(probe.out)
  impersonateCache.set(path, supported)
  logger.info('UrlDownloader', 'Impersonate support probed', {
    path,
    supported,
    code: probe?.code ?? null,
  })
  return supported
}

// 从 URL 下载音视频文件。计数器包住整个流程：Windows 上正在跑的 yt-dlp.exe 占着文件，
// 应用内更新必须等它结束才能改名。
export async function downloadFromUrl(url: string): Promise<DownloadResult> {
  mediaDownloads++
  try {
    return await runDownload(url)
  } finally {
    mediaDownloads--
  }
}

async function runDownload(url: string): Promise<DownloadResult> {
  logger.serviceCall('UrlDownloader', 'downloadFromUrl', { url })

  if (!isValidMediaUrl(url)) {
    logger.warn('UrlDownloader', 'Invalid URL format', { url })
    return { success: false, error: '请使用正确的音视频链接' }
  }

  const tempDir = join(tmpdir(), `transcribe-url-${randomUUID()}`)
  await mkdir(tempDir, { recursive: true })

  const ytDlp = resolveYtDlp()
  const ytDlpPath = ytDlp.path
  const outputPath = join(tempDir, '%(title)s.%(ext)s')
  const ffmpegPath = getFfmpegPath()
  logger.info('UrlDownloader', 'Resolved yt-dlp', { source: ytDlp.source, path: ytDlpPath })
  // 仅当 yt-dlp 支持时才启用浏览器模拟，否则该 flag 会导致解析直接失败
  const canImpersonate = await probeImpersonateSupport(ytDlpPath)

  const origin = new URL(url).origin
  const isDomestic =
    /\.(bilibili|douyin|tiktok|xinpianchang|youku|iqiyi|qq|kuaishou|weibo)\.com|b23\.tv/i.test(url)

  const baseArgs = [
    '--no-playlist',
    ...(canImpersonate ? ['--impersonate', 'chrome'] : []),
    '--referer',
    origin,
    '--retries',
    '3',
    ...(isDomestic ? ['--proxy', ''] : []),
    ...(ffmpegPath ? ['--ffmpeg-location', ffmpegPath] : []),
    '-f',
    'bestaudio[ext=m4a]/bestaudio/best',
    '--extract-audio',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '0',
    '-o',
    outputPath,
  ]

  // 第一轮：无头浏览器获取 cookies → yt-dlp with --cookies
  const cookieResult = await fetchCookiesFromUrl(url)
  if (cookieResult.success && cookieResult.cookiesPath) {
    const result1 = await runYtDlp(
      ytDlpPath,
      [...baseArgs, '--cookies', cookieResult.cookiesPath, url],
      tempDir,
      !isDomestic
    )
    await cleanupBrowserTemp(cookieResult.tempDir)
    if (result1.success) return result1
    logger.warn(
      'UrlDownloader',
      'First attempt with browser cookies failed, retrying without',
      result1.error
    )
  } else {
    // 失败分支同样要清：浏览器临时目录里可能已经写过 cookies.txt
    await cleanupBrowserTemp(cookieResult.tempDir)
    logger.warn('UrlDownloader', 'Browser cookie fetch failed', cookieResult.error)
  }

  // 第二轮：不带 cookies
  const result2 = await runYtDlp(ytDlpPath, [...baseArgs, url], tempDir, !isDomestic)
  return result2
}

/**
 * 把 yt-dlp 的英文报错翻成「下一步该做什么」。
 * 只说「链接解析失败，请重试」等于把诊断成本全推给用户：站点风控、视频私有、
 * 需要代理网络、链接本身不支持，用户能做的完全不一样。
 */
export function explainYtDlpFailure(stderr: string, signal: string | null): string {
  if (signal) {
    return '链接解析进程被系统中断，可能是包内 yt-dlp 未获授权执行。请到「系统设置 → 隐私与安全性」允许 Vv Transcribe，或完全退出应用后重试'
  }
  if (/unsupported url|no formats? (were )?found|is not a valid/i.test(stderr)) {
    return '这个链接的站点暂不支持，或页面里取不到音视频。可以先下载好，再用「本地文件」上传转写'
  }
  if (/private video|video unavailable|not available to|requested video/i.test(stderr)) {
    return '这个视频看不了：私密、已删除，或需要登录才能访问'
  }
  if (/age[ _-]?restrict|confirm your age/i.test(stderr)) {
    return '这个视频有年龄限制，需要在浏览器登录后才能取到音频'
  }
  if (
    /412|precondition failed|captcha|unusual traffic|are you a bot|not a bot|verify you.?re human|风控|滑块/i.test(
      stderr
    )
  ) {
    return '站点做了人机校验，应用带着登录 cookies 也没通过。请稍后重试，或下载好文件再走「本地文件」上传'
  }
  if (/(401|403)\b|log ?in|sign in|authentication|premium|membership/i.test(stderr)) {
    return '这个链接需要登录（或会员）才能取到音频。请先在本机浏览器登录该站点后重试'
  }
  if (
    /getaddrinfo|network is unreachable|timed out|unable to download|connection (reset|closed)|ssl|certificate/i.test(
      stderr
    )
  ) {
    return '连不上这个站点。境外站点（YouTube 等）需要代理网络，请确认代理已开启；国内站点建议关掉代理再试'
  }
  return '链接解析失败，请重试；也可以下载好文件后用「本地文件」上传转写'
}

function runYtDlp(
  ytDlpPath: string,
  args: string[],
  tempDir: string,
  preserveProxy: boolean
): Promise<DownloadResult> {
  logger.info('UrlDownloader', 'Spawning yt-dlp', {
    args: args.filter((a) => !a.startsWith('http')),
  })

  const env = { ...process.env }
  // 站点决定代理：国内站点挂代理会被王叔 CDN 直接 403，命令行 --proxy '' 只压得住
  // yt-dlp 自己那层，环境里的 *_PROXY 仍会被底层 urllib 读走，所以必须连 env 一起清；
  // 境外站点（YouTube 等）恰恰相反，用户挂的代理就是要让它生效，一个都不能动。
  if (!preserveProxy) {
    delete env.HTTP_PROXY
    delete env.HTTPS_PROXY
    delete env.http_proxy
    delete env.https_proxy
    delete env.ALL_PROXY
    delete env.all_proxy
    delete env.NO_PROXY
    delete env.no_proxy
  }

  return new Promise((resolve) => {
    const proc = spawn(ytDlpPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    })

    let stderr = ''

    proc.stdout?.on('data', (data) => {
      const line = data.toString().trim()
      if (line) logger.debug('UrlDownloader', 'yt-dlp stdout', line)
    })

    proc.stderr?.on('data', (data) => {
      const line = data.toString().trim()
      stderr += line + '\n'
      logger.debug('UrlDownloader', 'yt-dlp stderr', line)
    })

    proc.on('exit', async (code, signal) => {
      if (code !== 0) {
        logger.error('UrlDownloader', 'yt-dlp failed', {
          code,
          signal,
          stderr: stderr.slice(-400),
        })
        // signal（非 0 退出码、被系统杀掉）是「包内二进制被拦下执行」的典型特征，给直达隐私设置的入口
        resolve({
          success: false,
          error: explainYtDlpFailure(stderr, signal),
          systemSettingsHint: signal !== null,
        })
        return
      }

      try {
        const files = await readdir(tempDir)
        // 认「不是 yt-dlp 的中间产物/字幕/封面」的第一个文件，而不是认固定后缀：
        // 站点给的音频容器不止这 6 种（opus/aac/m4b…），漏一种就是「下载完成但找不到媒体文件」
        const mediaFile = files.find(
          (f) => !/\.(part|ytdl|json|txt|srt|vtt|ass|lrc|jpg|jpeg|png|webp|gif)$/i.test(f)
        )
        if (!mediaFile) {
          resolve({ success: false, error: '下载完成但未找到媒体文件' })
          return
        }
        const filePath = join(tempDir, mediaFile)
        const title = mediaFile.replace(/\.[^.]+$/, '')
        logger.info('UrlDownloader', 'Download completed', { name: mediaFile, title })
        resolve({ success: true, filePath, tempDir, title })
      } catch (err) {
        resolve({ success: false, error: err instanceof Error ? err.message : '读取下载文件失败' })
      }
    })

    proc.on('error', (err) => {
      logger.serviceError('UrlDownloader', 'runYtDlp', err)
      const code = (err as NodeJS.ErrnoException).code
      // yt-dlp 已随包内置，ENOENT 不再是「用户没装」，而是包内产物缺失/路径异常——让用户重启或重装，别再教 brew
      if (code === 'ENOENT') {
        resolve({
          success: false,
          error:
            '内置的转写组件没能启动，请完全退出 Vv Transcribe 后重新打开；仍然不行请重新安装（无需自行安装 yt-dlp）',
        })
        return
      }
      // EACCES/EPERM：二进制在但系统不让执行（macOS 未授权 / 文件权限），这是唯一值得给「打开隐私设置」按钮的情形
      if (code === 'EACCES' || code === 'EPERM') {
        resolve({
          success: false,
          error:
            '包内 yt-dlp 没有执行权限。macOS 请到「系统设置 → 隐私与安全性」允许 Vv Transcribe 后重试',
          systemSettingsHint: true,
        })
        return
      }
      resolve({ success: false, error: `无法启动 yt-dlp: ${err.message}` })
    })
  })
}
