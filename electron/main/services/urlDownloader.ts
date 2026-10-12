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
import { logger } from './logger'
import { fetchCookiesFromUrl, cleanupBrowserTemp } from './browserCookieFetcher'

export interface DownloadResult {
  success: boolean
  filePath?: string
  tempDir?: string
  title?: string
  error?: string
}

/** 查找 yt-dlp 可执行文件路径 */
function getYtDlpPath(): string {
  const candidates = [
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
  ]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return 'yt-dlp'
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

  const ytDlpPath = getYtDlpPath()
  const outputPath = join(tempDir, '%(title)s.%(ext)s')

  const origin = new URL(url).origin
  const isDomestic = /\.(bilibili|douyin|tiktok|xinpianchang|youku|iqiyi|qq|kuaishou|weibo)\.com|b23\.tv/i.test(url)

  const baseArgs = [
    '--no-playlist',
    '--impersonate', 'chrome',
    '--referer', origin,
    '--retries', '3',
    ...(isDomestic ? ['--proxy', ''] : []),
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
        logger.info('UrlDownloader', 'Download completed', { filePath, title })
        resolve({ success: true, filePath, tempDir, title })
      } catch (err) {
        resolve({ success: false, error: err instanceof Error ? err.message : '读取下载文件失败' })
      }
    })

    proc.on('error', (err) => {
      logger.serviceError('UrlDownloader', 'runYtDlp', err)
      resolve({ success: false, error: `无法启动 yt-dlp: ${err.message}` })
    })
  })
}
