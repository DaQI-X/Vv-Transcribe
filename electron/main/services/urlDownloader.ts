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
    const resolved = require.resolve(`@ffmpeg-installer/${platform}-${arch}/${platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'}`)
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
    const dir = process.platform === 'darwin' ? 'darwin-universal' : `${process.platform}-${process.arch}`
    return join(import.meta.dirname, '../../vendor/yt-dlp', dir, binary)
  }
  return join(process.resourcesPath, 'yt-dlp', binary)
}

export type YtDlpSource = 'updated' | 'bundled' | 'system' | 'path'

/**
 * yt-dlp 可执行文件路径，按「用户更新过 > 安装包内置 > 本机安装 > PATH 兜底」取第一个存在的。
 * 内置档排在系统档前面：包里的版本至少保证「能跑起来」，而 Homebrew 装的那台机器可能根本没装、
 * 也可能被别的软件改过。用户手装的版本仍走最后一档，不算丢功能。
 */
export function resolveYtDlp(): { path: string; source: YtDlpSource } {
  const binary = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  const candidates: Array<{ path: string; source: YtDlpSource }> = [
    // 应用内更新的副本（#134）落在 userData/bin，升级不需要重装整包
    { path: join(app.getPath('userData'), 'bin', binary), source: 'updated' },
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

// 缓存探测结果：yt-dlp 在单次会话内不会变化
let impersonateSupported: boolean | null = null

/**
 * 探测 yt-dlp 是否支持 chrome 浏览器模拟（--impersonate）
 * 该能力依赖 Python 的 curl_cffi 包；系统自带的 yt-dlp（如 Homebrew）通常未安装，
 * 此时传入 --impersonate chrome 会直接报错 "Impersonate target chrome is not available"。
 * 探测方式：运行 --list-impersonate-targets 并检查输出是否包含 chrome。
 */
function probeImpersonateSupport(ytDlpPath: string): Promise<boolean> {
  if (impersonateSupported !== null) return Promise.resolve(impersonateSupported)

  return new Promise((resolve) => {
    let out = ''
    const proc = spawn(ytDlpPath, ['--list-impersonate-targets'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // 内置 yt-dlp 之后 Windows 上每次探测都会闪一个黑框，跟用户没关系
      windowsHide: true,
    })

    proc.stdout?.on('data', (d) => { out += d.toString() })
    proc.stderr?.on('data', (d) => { out += d.toString() })
    proc.on('error', () => {
      impersonateSupported = false
      logger.warn('UrlDownloader', 'yt-dlp impersonate probe failed to spawn', { ytDlpPath })
      resolve(false)
    })
    proc.on('exit', (code) => {
      const supported = code === 0 && /chrome/i.test(out)
      impersonateSupported = supported
      logger.info('UrlDownloader', 'Impersonate support probed', { supported, code })
      resolve(supported)
    })
  })
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

/** 从 URL 下载音视频文件 */
export async function downloadFromUrl(url: string): Promise<DownloadResult> {
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
  const isDomestic = /\.(bilibili|douyin|tiktok|xinpianchang|youku|iqiyi|qq|kuaishou|weibo)\.com|b23\.tv/i.test(url)

  const baseArgs = [
    '--no-playlist',
    ...(canImpersonate ? ['--impersonate', 'chrome'] : []),
    '--referer', origin,
    '--retries', '3',
    ...(isDomestic ? ['--proxy', ''] : []),
    ...(ffmpegPath ? ['--ffmpeg-location', ffmpegPath] : []),
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '-o', outputPath,
  ]

  // 第一轮：无头浏览器获取 cookies → yt-dlp with --cookies
  const cookieResult = await fetchCookiesFromUrl(url)
  if (cookieResult.success && cookieResult.cookiesPath) {
    const result1 = await runYtDlp(ytDlpPath, [...baseArgs, '--cookies', cookieResult.cookiesPath, url], tempDir)
    await cleanupBrowserTemp(cookieResult.tempDir)
    if (result1.success) return result1
    logger.warn('UrlDownloader', 'First attempt with browser cookies failed, retrying without', result1.error)
  } else {
    // 失败分支同样要清：浏览器临时目录里可能已经写过 cookies.txt
    await cleanupBrowserTemp(cookieResult.tempDir)
    logger.warn('UrlDownloader', 'Browser cookie fetch failed', cookieResult.error)
  }

  // 第二轮：不带 cookies
  const result2 = await runYtDlp(ytDlpPath, [...baseArgs, url], tempDir)
  return result2
}

function runYtDlp(ytDlpPath: string, args: string[], tempDir: string): Promise<DownloadResult> {
  logger.info('UrlDownloader', 'Spawning yt-dlp', { args: args.filter((a) => !a.startsWith('http')) })

  const cleanEnv = { ...process.env }
  delete cleanEnv.HTTP_PROXY
  delete cleanEnv.HTTPS_PROXY
  delete cleanEnv.http_proxy
  delete cleanEnv.https_proxy
  delete cleanEnv.ALL_PROXY
  delete cleanEnv.all_proxy
  delete cleanEnv.NO_PROXY
  delete cleanEnv.no_proxy

  return new Promise((resolve) => {
    const proc = spawn(ytDlpPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv,
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

    proc.on('exit', async (code) => {
      if (code !== 0) {
        logger.error('UrlDownloader', 'yt-dlp failed', { code, stderr: stderr.slice(-200) })
        resolve({ success: false, error: '链接解析失败，请重试' })
        return
      }

      try {
        const files = await readdir(tempDir)
        const mediaFile = files.find((f) => /\.(mp3|m4a|wav|ogg|mp4|webm)$/i.test(f))
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
      const hint = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? '未检测到 yt-dlp，链接转写需要先安装：macOS 执行 brew install yt-dlp，Windows 执行 winget install yt-dlp.yt-dlp，安装后重启应用'
        : `无法启动 yt-dlp: ${err.message}`
      resolve({ success: false, error: hint })
    })
  })
}
