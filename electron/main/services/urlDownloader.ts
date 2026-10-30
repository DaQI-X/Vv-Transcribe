/**
 * URL 媒体服务（链接转写 + 链接下载视频）
 * 两段式：先 yt-dlp -J 解析出标题/时长/可选清晰度 → 界面选「转写音频」或「下载视频」→ 再真正下载。
 * 优先用无头浏览器获取 cookies → yt-dlp with --cookies cookies.txt
 * 降级：yt-dlp without cookies
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { app, dialog } from 'electron'
import { logger } from './logger'
import { userDataPath } from './userDataStore'
import { fetchCookiesFromUrl, cleanupBrowserTemp } from './browserCookieFetcher'

/** 解析这一步只取元信息，正常几秒；卡住（站点风控挂住连接）不能让界面永远转圈 */
const META_TIMEOUT_MS = 45_000
/** 下载阶段不能按总时长掐：下 4K 本来就可能是十几分钟。改掐「没有新进展」 */
const STALL_TIMEOUT_MS = 180_000

export interface MediaQualityOption {
  /** null = 站点给到的最高清晰度 */
  height: number | null
  label: string
  /** 站点自报的估算体积，取不到就 null（界面要如实显示「大小未知」而不是猜） */
  approxBytes: number | null
  /** 1 = 站点直接给带音轨的整片；2 = 视频轨和音频轨分开下再合并 */
  streams: number
}

export interface MediaInfo {
  title: string
  durationSeconds: number | null
  uploader: string | null
  isLive: boolean
  audioApproxBytes: number | null
  /** 空数组 = 这个链接只有音频，没有可下载的视频画面 */
  videoOptions: MediaQualityOption[]
}

export interface ResolveResult {
  success: boolean
  sessionId?: string
  info?: MediaInfo
  error?: string
  /** 失败原因是「系统层面拦住了包内二进制执行」时置真：界面据此给「打开隐私设置」按钮 */
  systemSettingsHint?: boolean
}

export interface DownloadResult {
  success: boolean
  filePath?: string
  fileSizeBytes?: number
  canceled?: boolean
  error?: string
  systemSettingsHint?: boolean
}

export interface MediaProgress {
  sessionId: string
  kind: 'audio' | 'video'
  stage: 'downloading' | 'merging' | 'converting'
  /** 多流合并时是「第几路」，单流恒为 1 */
  streamIndex: number
  streamCount: number
  percent: number | null
  /** yt-dlp 原样吐的速度与剩余时间（"1.23MiB/s" / "00:09"）：自己换算单位只会换来错数字 */
  speed: string | null
  eta: string | null
}

interface MediaSession {
  id: string
  url: string
  info: MediaInfo
  /** 一次会话独占一个目录，cookies 和产物都在里面；会话结束时整目录删掉 */
  tempDir: string
  cookiesPath: string | null
  ytDlpPath: string
  commonArgs: string[]
  /** 国内站点要清掉环境里的代理，境外站点要保留用户挂的代理 */
  preserveProxy: boolean
  /** stdio 是 ['ignore','pipe','pipe']：stdin 为 null，类型要按 ChildProcessByStdio<null, …> 写 */
  proc: ChildProcessByStdio<null, Readable, Readable> | null
  /** 中止原因：用户点取消与「站点不再传数据」要给出不同的话，不能都写成「已取消」 */
  abortReason: 'canceled' | 'stalled' | null
  lastFilePath: string | null
}

const sessions = new Map<string, MediaSession>()

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
  return userDataPath('bin', binary)
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
    return '这个链接需要登录（或会员）才能取到音视频。请先在本机浏览器登录该站点后重试'
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

/** 按站点决定是否清掉环境里的代理变量：命令行 --proxy '' 只压得住 yt-dlp 那层，底层 urllib 仍会读 env */
function buildEnv(preserveProxy: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (preserveProxy) return env
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) {
    delete env[key]
  }
  return env
}

/** 跑一次 yt-dlp -J 拿元信息：stdout 是 JSON，stderr 留着翻译报错 */
function runYtDlpMeta(
  path: string,
  args: string[],
  preserveProxy: boolean
): Promise<{ json: any | null; stderr: string; signal: string | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let proc: ReturnType<typeof spawn>
    const done = (value: { json: any | null; stderr: string; signal: string | null; timedOut: boolean }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const fail = (signal: string | null, timedOut = false) =>
      done({ json: null, stderr, signal, timedOut })
    const timer = setTimeout(() => {
      logger.warn('UrlDownloader', 'yt-dlp metadata timed out', { path, timeoutMs: META_TIMEOUT_MS })
      try {
        proc.kill()
      } catch {
        /* 已经退了 */
      }
      fail(null, true)
    }, META_TIMEOUT_MS)

    try {
      proc = spawn(path, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildEnv(preserveProxy),
        windowsHide: true,
      })
    } catch {
      fail(null)
      return
    }

    proc.stdout?.on('data', (d) => {
      stdout += d.toString()
    })
    proc.stderr?.on('data', (d) => {
      stderr += d.toString()
      logger.debug('UrlDownloader', 'yt-dlp -J stderr', d.toString().trim())
    })
    proc.on('error', (err) => {
      logger.warn('UrlDownloader', 'yt-dlp metadata failed to spawn', { error: err.message })
      stderr += err.message
      fail(null)
    })
    proc.on('exit', (code, signal) => {
      if (code !== 0) return fail(signal)
      try {
        done({ json: JSON.parse(stdout), stderr, signal: null, timedOut: false })
      } catch {
        logger.warn('UrlDownloader', 'yt-dlp -J output is not valid JSON', { length: stdout.length })
        fail(null)
      }
    })
  })
}

interface YtdlpFormat {
  format_id?: string
  height?: number | null
  vcodec?: string | null
  acodec?: string | null
  ext?: string | null
  filesize?: number | null
  filesize_approx?: number | null
  tbr?: number | null
}

function formatBytes(f: YtdlpFormat): number | null {
  const v = f.filesize ?? f.filesize_approx
  return typeof v === 'number' && v > 0 ? v : null
}

const isVideoFormat = (f: YtdlpFormat) => !!f.vcodec && f.vcodec !== 'none'
const isAudioFormat = (f: YtdlpFormat) => !!f.acodec && f.acodec !== 'none'

/**
 * -J 的结果压成界面要的东西：标题、时长、音频体积，以及「有画面可下」的清晰度档位。
 * 只留最高的几档 + 一档「最高」，否则 4K/8K 站点能列出十几个选项，用户反而找不到北。
 */
function buildMediaInfo(raw: any, url: string): MediaInfo {
  const formats: YtdlpFormat[] = Array.isArray(raw?.formats) ? raw.formats : []
  // 三种轨：只有画面 / 只有声音 / 画面声音打包在一起（站点直给的整片）
  const videoOnly = formats.filter((f) => isVideoFormat(f) && !isAudioFormat(f))
  const audioOnly = formats.filter((f) => isAudioFormat(f) && !isVideoFormat(f))
  const progressive = formats.filter((f) => isVideoFormat(f) && isAudioFormat(f))
  // 「转写音频」会下哪一路，体积就按哪一路估：`bestaudio/best` 有纯音频轨时取纯音频，
  // 没有才退到整片。这里曾经误用 videoOnly 的最大值，于是 B 站 1080p 那路 188MB 被当成音频体积，
  // 而实际下下来的 mp3 只有 8.4MB——每一档视频的估算也跟着多算了这 188MB。
  const bestAudioBytes = maxBytes(audioOnly.length ? audioOnly : progressive)

  const byHeight = new Map<number, { videoBytes: number | null; progressive: boolean }>()
  for (const f of formats) {
    if (!isVideoFormat(f) || !f.height || f.height <= 0) continue
    const size = formatBytes(f)
    const prev = byHeight.get(f.height)
    if (!prev) {
      byHeight.set(f.height, { videoBytes: size, progressive: isAudioFormat(f) })
    } else {
      if (size && (!prev.videoBytes || size > prev.videoBytes)) prev.videoBytes = size
      if (isAudioFormat(f)) prev.progressive = true
    }
  }

  const options: MediaQualityOption[] = [...byHeight.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, 4)
    .map(([height, entry]) => ({
      height,
      label: `${height}p`,
      approxBytes: entry.videoBytes && bestAudioBytes ? entry.videoBytes + bestAudioBytes : entry.videoBytes,
      streams: entry.progressive ? 1 : 2
    }))

  const allVideo = [...videoOnly, ...progressive]
  const topVideoBytes = maxBytes(allVideo)
  const optionsWithBest: MediaQualityOption[] = options.length
    ? [
        {
          height: null,
          label: '最高',
          approxBytes: topVideoBytes && bestAudioBytes ? topVideoBytes + bestAudioBytes : topVideoBytes,
          // 「最高」拿的是站点最好的视频轨，只有整片格式本身就到顶时才可能单流
          streams: allVideo.some((f) => isAudioFormat(f) && formatBytes(f) === topVideoBytes) ? 1 : 2
        },
        ...options,
      ]
    : []

  return {
    title: (typeof raw?.title === 'string' && raw.title.trim()) || basenameOf(url),
    durationSeconds: typeof raw?.duration === 'number' && raw.duration > 0 ? raw.duration : null,
    uploader: typeof raw?.uploader === 'string' ? raw.uploader : raw?.channel ?? null,
    isLive: !!raw?.is_live || !!raw?.live_status?.includes('is_now'),
    audioApproxBytes: bestAudioBytes,
    videoOptions: optionsWithBest,
  }
}

function maxBytes(list: YtdlpFormat[]): number | null {
  const sizes = list.map(formatBytes).filter((s): s is number => s !== null)
  return sizes.length ? Math.max(...sizes) : null
}

function basenameOf(url: string): string {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop()
    return seg ?? url
  } catch {
    return url
  }
}

/** 建会话时目录已经建好；失败路径上调用方负责把 tempDir 删掉，不留孤儿目录 */
export async function resolveMediaUrl(url: string): Promise<ResolveResult> {
  logger.serviceCall('UrlDownloader', 'resolveMediaUrl', { url })
  if (!isValidMediaUrl(url)) {
    logger.warn('UrlDownloader', 'Invalid URL format', { url })
    return { success: false, error: '请使用正确的音视频链接' }
  }

  // 会话 id 直接当地址名用：日志里「stalled / released 的 sessionId」和磁盘上的临时目录能一眼对上
  const sessionId = randomUUID()
  const tempDir = join(tmpdir(), `transcribe-url-${sessionId}`)
  await mkdir(tempDir, { recursive: true })

  try {
    const ytDlp = resolveYtDlp()
    const ffmpegPath = getFfmpegPath()
    logger.info('UrlDownloader', 'Resolved yt-dlp', { source: ytDlp.source, path: ytDlp.path })
    const canImpersonate = await probeImpersonateSupport(ytDlp.path)
    const origin = new URL(url).origin
    const isDomestic =
      /\.(bilibili|douyin|tiktok|xinpianchang|youku|iqiyi|qq|kuaishou|weibo)\.com|b23\.tv/i.test(url)
    const commonArgs = [
      '--no-playlist',
      ...(canImpersonate ? ['--impersonate', 'chrome'] : []),
      '--referer',
      origin,
      '--retries',
      '3',
      ...(isDomestic ? ['--proxy', ''] : []),
      ...(ffmpegPath ? ['--ffmpeg-location', ffmpegPath] : []),
    ]

    let cookiesPath: string | null = null
    const cookieResult = await fetchCookiesFromUrl(url)
    if (cookieResult.success && cookieResult.cookiesPath) {
      // cookies 原件在无头浏览器的临时目录里，那份会被立刻删掉，所以要复制进会话目录
      cookiesPath = join(tempDir, 'cookies.txt')
      await copyFile(cookieResult.cookiesPath, cookiesPath)
    }
    await cleanupBrowserTemp(cookieResult.tempDir)
    if (!cookiesPath) {
      logger.warn('UrlDownloader', 'Browser cookie fetch failed', cookieResult.error)
    }

    const attempts = [cookiesPath, null]
    let lastStderr = ''
    let lastSignal: string | null = null
    let timedOut = false
    for (const cookie of attempts) {
      const probe = await runYtDlpMeta(
        ytDlp.path,
        [...commonArgs, ...(cookie ? ['--cookies', cookie] : []), '-J', url],
        !isDomestic
      )
      if (probe.json) {
        const info = buildMediaInfo(probe.json, url)
        if (info.isLive) {
          await rm(tempDir, { recursive: true, force: true }).catch(() => {})
          return { success: false, error: '这是正在直播的场次，取到的是无限流，不能下载也不能转写。请找回放或录播链接' }
        }
        sessions.set(sessionId, {
          id: sessionId,
          url,
          info,
          tempDir,
          cookiesPath,
          ytDlpPath: ytDlp.path,
          commonArgs,
          preserveProxy: !isDomestic,
          proc: null,
          abortReason: null,
          lastFilePath: null,
        })
        logger.info('UrlDownloader', 'Media resolved', {
          title: info.title,
          durationSeconds: info.durationSeconds,
          videoOptions: info.videoOptions.map((o) => o.label),
        })
        return { success: true, sessionId, info }
      }
      lastStderr = probe.stderr
      lastSignal = probe.signal
      timedOut = probe.timedOut
      if (!cookie) break // 本来就没有 cookies，不必再试第二轮
      logger.warn('UrlDownloader', 'Metadata with cookies failed, retrying without', {
        stderr: probe.stderr.slice(-400),
      })
    }

    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    const error = timedOut
      ? '链接解析超时（站点 45 秒没有响应）。可能是代理不通或站点风控过严，请稍后重试，或下载好文件再走「本地文件」上传'
      : explainYtDlpFailure(lastStderr, lastSignal)
    logger.error('UrlDownloader', 'resolve failed', { error, stderr: lastStderr.slice(-400) })
    return { success: false, error, systemSettingsHint: lastSignal !== null }
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    logger.serviceError('UrlDownloader', 'resolveMediaUrl', err)
    return { success: false, error: err instanceof Error ? err.message : '链接解析失败' }
  }
}

function audioArgs(): string[] {
  return [
    '-f',
    'bestaudio[ext=m4a]/bestaudio/best',
    '--extract-audio',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '0',
  ]
}

function videoArgs(height: number | null): string[] {
  return [
    '-f',
    height
      ? `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`
      : 'bv*+ba/b',
    '--merge-output-format',
    'mp4',
  ]
}

/** [download] Destination: /tmp/xxx/标题.f30015.mp4 → 取后面的路径 */
function destOf(line: string): string {
  return line.slice('[download] Destination:'.length).trim()
}

/**
 * 真正下载。产物留在会话自己的临时目录里：音频交给转写流程，视频还要再「另存为」一次，
 * 所以这里不删目录，删除统一走 releaseMediaSession / saveMediaFileAs。
 */
export async function downloadMedia(
  sessionId: string,
  target: { kind: 'audio' } | { kind: 'video'; height: number | null },
  onProgress: (p: MediaProgress) => void
): Promise<DownloadResult> {
  const session = sessions.get(sessionId)
  if (!session) return { success: false, error: '链接信息已过期，请重新解析' }
  if (session.proc) return { success: false, error: '这个链接正在下载中，请先等它跑完或点取消' }

  const streamCount =
    target.kind === 'audio'
      ? 1
      : (target.height === null
          ? session.info.videoOptions.find((o) => o.height === null)?.streams
          : session.info.videoOptions.find((o) => o.height === target.height)?.streams) ?? 2
  const outputPath = join(session.tempDir, '%(title)s.%(ext)s')
  const args = [
    ...session.commonArgs,
    ...(target.kind === 'audio' ? audioArgs() : videoArgs(target.height)),
    // 每行一条进度，省掉解析回车覆盖的那套（--newline 之后才是真正的逐行刷新）
    '--newline',
    '-o',
    outputPath,
    ...(session.cookiesPath ? ['--cookies', session.cookiesPath] : []),
    session.url,
  ]

  mediaDownloads++
  logger.info('UrlDownloader', 'Spawning yt-dlp download', {
    kind: target.kind,
    height: target.kind === 'video' ? target.height : null,
    args: args.filter((a) => !a.startsWith('http')),
  })

  try {
    const result = await new Promise<DownloadResult>((resolve) => {
      const proc = spawn(session.ytDlpPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildEnv(session.preserveProxy),
        windowsHide: true,
      })
      session.proc = proc
      session.abortReason = null

      let stderr = ''
      let stage: MediaProgress['stage'] = 'downloading'
      let lastPercent: number | null = null
      let speed: string | null = null
      let eta: string | null = null
      let streamIndex = 1
      let destinationsSeen = 0
      /**
       * 产物路径优先认 yt-dlp 自己在日志里报的那个，而不是「扫目录挑第一个不像中间文件的」：
       * 合并/转码后目录里同时躺过 .f30015.mp4 与 .f30280.m4a 这类中间产物，靠后缀猜迟早挑错，
       * 挑错就是「下载完成，转写出来的却是没音轨的那一路」。扫目录只留作兜底。
       */
      let producedFile: string | null = null
      let settled = false
      let stall: NodeJS.Timeout

      const emit = () =>
        onProgress({
          sessionId,
          kind: target.kind,
          stage,
          streamIndex,
          streamCount,
          percent: lastPercent,
          speed,
          eta,
        })
      const resetStall = () => {
        clearTimeout(stall)
        stall = setTimeout(() => {
          logger.warn('UrlDownloader', 'download stalled', { sessionId, stallMs: STALL_TIMEOUT_MS })
          session.abortReason = 'stalled'
          try {
            proc.kill('SIGTERM')
          } catch {
            /* 已经退了 */
          }
        }, STALL_TIMEOUT_MS)
      }
      const finish = (value: DownloadResult) => {
        if (settled) return
        settled = true
        clearTimeout(stall)
        session.proc = null
        resolve(value)
      }

      proc.stdout?.on('data', (data) => {
        resetStall()
        const text = data.toString()
        for (const line of text.split('\n')) {
          const l = line.trim()
          if (!l) continue
          logger.debug('UrlDownloader', 'yt-dlp stdout', l)
          const dl = /^\[download\]\s+([\d.]+)% of ~?\s*[^\s]*\s+at\s+(\S+)\s+ETA\s+(\S+)/.exec(l)
          if (dl) {
            lastPercent = Math.min(100, Number(dl[1]))
            speed = dl[2]
            eta = dl[3]
            emit()
            continue
          }
          if (/^\[download\] Destination:/.test(l)) {
            destinationsSeen += 1
            // 第一路本来就是 1；从第二路起才要告诉界面「这是第 2 个文件」
            if (destinationsSeen > 1) streamIndex = Math.min(destinationsSeen, streamCount)
            lastPercent = null
            speed = null
            eta = null
            producedFile = destOf(l)
            emit()
            continue
          }
          const merged = /^\[Merger\]\s+Merging formats into\s+"(.+)"$/.exec(l)
          if (merged) {
            stage = 'merging'
            lastPercent = null
            producedFile = merged[1]
            emit()
            continue
          }
          if (/\[(ExtractAudio|FFmpegExtractAudio|FixupMjpeg|VideoConvertor)\]/.test(l)) {
            stage = 'converting'
            lastPercent = null
            // [ExtractAudio] Destination: /tmp/xxx/标题.mp3 —— 转码后的名字才是产物
            const conv = /^\[(?:ExtractAudio|FFmpegExtractAudio|FixupMjpeg|VideoConvertor)\]\s+Destination:\s+(.+)$/.exec(
              l
            )
            if (conv) producedFile = conv[1]
            emit()
          }
        }
      })
      proc.stderr?.on('data', (data) => {
        resetStall()
        const line = data.toString().trim()
        stderr += line + '\n'
        logger.debug('UrlDownloader', 'yt-dlp stderr', line)
      })
      resetStall()

      proc.on('error', (err) => {
        logger.serviceError('UrlDownloader', 'downloadMedia', err)
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          finish({
            success: false,
            error:
              '内置的转写组件没能启动，请完全退出 Vv Transcribe 后重新打开；仍然不行请重新安装（无需自行安装 yt-dlp）',
          })
          return
        }
        if (code === 'EACCES' || code === 'EPERM') {
          finish({
            success: false,
            error:
              '包内 yt-dlp 没有执行权限。macOS 请到「系统设置 → 隐私与安全性」允许 Vv Transcribe 后重试',
            systemSettingsHint: true,
          })
          return
        }
        finish({ success: false, error: `无法启动 yt-dlp: ${err.message}` })
      })

      proc.on('exit', async (code, signal) => {
        if (session.abortReason === 'canceled') {
          finish({ success: false, canceled: true, error: '下载已取消' })
          return
        }
        if (session.abortReason === 'stalled') {
          finish({
            success: false,
            error: `下载长时间没有新进展（${Math.round(STALL_TIMEOUT_MS / 1000)} 秒），已中断。多半是站点限速或代理不稳，请重试；急的话先在浏览器里下载再用「本地文件」上传`,
          })
          return
        }
        if (code !== 0) {
          logger.error('UrlDownloader', 'yt-dlp download failed', {
            code,
            signal,
            stderr: stderr.slice(-400),
          })
          finish({
            success: false,
            error: explainYtDlpFailure(stderr, signal),
            systemSettingsHint: signal !== null,
          })
          return
        }
        try {
          // 首认 yt-dlp 报出来的产物路径；只在这行没出现（或路径对不上）时才退回扫目录
          let filePath = producedFile && existsSync(producedFile) ? producedFile : null
          if (!filePath) {
            const files = await readdir(session.tempDir)
            // 兜底仍按「不像中间产物/字幕/封面/cookies」筛：站点给的容器不止这几种，
            // 认固定后缀漏一种就是「下载完成但找不到媒体文件」
            const mediaFile = files.find(
              (f) =>
                f !== 'cookies.txt' &&
                !/\.(part|ytdl|json|txt|srt|vtt|ass|lrc|jpg|jpeg|png|webp|gif)$/i.test(f) &&
                !/\.f\d+\./.test(f)
            )
            if (!mediaFile) {
              finish({ success: false, error: '下载完成但未找到媒体文件' })
              return
            }
            filePath = join(session.tempDir, mediaFile)
          }
          const size = await stat(filePath).then((s) => s.size).catch(() => 0)
          session.lastFilePath = filePath
          logger.info('UrlDownloader', 'Download completed', {
            name: basename(filePath),
            kind: target.kind,
            sizeBytes: size,
          })
          finish({ success: true, filePath, fileSizeBytes: size })
        } catch (err) {
          finish({
            success: false,
            error: err instanceof Error ? err.message : '读取下载文件失败',
          })
        }
      })
    })
    return result
  } finally {
    mediaDownloads--
  }
}

/** 用户在下载中途点取消 */
export function cancelMediaDownload(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session?.proc) return
  logger.userAction('Media download canceled', { sessionId })
  session.abortReason = 'canceled'
  try {
    session.proc.kill('SIGTERM')
  } catch {
    /* 已经退了 */
  }
}

/** 丢掉会话连同它的临时目录（cookies 也在里面） */
export async function releaseMediaSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) return
  cancelMediaDownload(sessionId)
  sessions.delete(sessionId)
  await rm(session.tempDir, { recursive: true, force: true }).catch(() => {})
  logger.debug('UrlDownloader', 'Session released', { sessionId, tempDir: session.tempDir })
}

/**
 * 只删 cookies，媒体留着。转写一开工站点凭证就没用了，但那份音频播放器整场都要用，
 * 所以这两个动作必须分开（一起删的后果：播放器报「文件已被移动」，逐句回放全废）。
 */
export async function dropMediaSessionCookies(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session?.cookiesPath) return
  await rm(session.cookiesPath, { force: true }).catch(() => {})
  session.cookiesPath = null
  logger.debug('UrlDownloader', 'Session cookies dropped', { sessionId })
}

/**
 * 换素材开工时回收上一份：界面一次只放一条转写，上一份的临时媒体已经没人播了。
 * 正在跑 yt-dlp 的会话不碰（用户的下载不该被别的操作打断）。
 */
export function releaseMediaSessionsExcept(keepSessionId: string | null): number {
  let released = 0
  for (const session of [...sessions.values()]) {
    if (session.id === keepSessionId || session.proc) continue
    void releaseMediaSession(session.id)
    released++
  }
  if (released) logger.info('UrlDownloader', 'Previous media sessions released', { released, keepSessionId })
  return released
}

/** 退出时把还留在会话表里的临时媒体一并删掉（强杀没走到这里，由下次启动的清扫兜底） */
export async function releaseAllMediaSessions(): Promise<void> {
  await Promise.all([...sessions.values()].map((s) => releaseMediaSession(s.id)))
}

/** 另存为用的干净文件名：去掉路径分隔符与控制字符，标题再长也截到 80 */
function sanitizeFileName(title: string, fallback: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return cleaned || fallback
}

/**
 * 视频下完后再问存哪儿：先下满临时目录，才不会出现「用户目录里躺个半成品」。
 * 复制成功就把会话删掉 —— 视频这条链路到此结束，临时目录留着只有坏处。
 * （音频那条不能在这里删：后面还要拿它去转写。）
 */
export async function saveMediaFileAs(
  sessionId: string
): Promise<{ success: boolean; savedPath?: string; canceled?: boolean; error?: string }> {
  const session = sessions.get(sessionId)
  if (!session?.lastFilePath) return { success: false, error: '还没有下载好的文件可以保存' }

  const ext = session.lastFilePath.slice(session.lastFilePath.lastIndexOf('.')).toLowerCase() || '.mp4'
  const picked = await dialog.showSaveDialog({
    title: '保存视频',
    defaultPath: `${sanitizeFileName(session.info.title, 'video')}${ext}`,
    filters: [{ name: '视频文件', extensions: [ext.replace('.', '') || 'mp4'] }],
  })
  if (picked.canceled || !picked.filePath) {
    // 取消也还会话：渲染层此时已经把 media 卡片清空、句柄丢了，
    // 不还就是纯泄漏（界面那句「临时文件已清理」也就成了谎话）
    await releaseMediaSession(sessionId)
    return { success: false, canceled: true }
  }

  try {
    // 临时目录在 /tmp，目标盘可能是另一块卷，rename 会 EXDEV；直接复制再清会话
    await copyFile(session.lastFilePath, picked.filePath)
  } catch (err) {
    logger.serviceError('UrlDownloader', 'saveMediaFileAs', err)
    return { success: false, error: err instanceof Error ? err.message : '保存失败' }
  }
  await releaseMediaSession(sessionId)
  const savedPath = picked.filePath
  logger.userAction('Media saved', { path: savedPath })
  return { success: true, savedPath }
}

/**
 * 清掉历史遗留的转写临时目录：进程被强杀、崩溃、或用户直接关掉应用时，
 * 这些目录没人删（会话只活在内存里，重启就没了）。启动时扫一遍，只删一天前的，
 * 免得把用户正在第二个实例里用的文件当垃圾清了。
 */
export async function sweepStaleMediaTempDirs(): Promise<number> {
  const root = tmpdir()
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  let removed = 0
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return 0
  }
  for (const name of entries.filter((n) => n.startsWith('transcribe-'))) {
    const dir = join(root, name)
    try {
      const info = await stat(dir)
      if (!info.isDirectory() || info.mtimeMs > cutoff) continue
      if ([...sessions.values()].some((s) => s.tempDir === dir)) continue
      await rm(dir, { recursive: true, force: true })
      removed++
    } catch {
      /* 没权限或已经没了，跳过 */
    }
  }
  if (removed) logger.info('UrlDownloader', 'Stale temp dirs swept', { removed, root })
  return removed
}
