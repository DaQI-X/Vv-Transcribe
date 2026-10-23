/**
 * 应用更新检查 IPC 处理器
 * 查询 GitHub Release 最新版本并与当前应用版本比较。
 * 不做自动下载/安装（应用未签名，electron-updater 不可用），仅引导用户到 GitHub Release 页下载安装包。
 */
import { app, ipcMain, shell } from 'electron'

const RELEASE_API = 'https://api.github.com/repos/DaQI-X/Vv-Transcribe/releases/latest'
const RELEASE_PAGE = 'https://github.com/DaQI-X/Vv-Transcribe/releases/latest'

// 仅允许打开白名单域名，防止渲染进程传入任意 URL 造成开放跳转
const ALLOWED_HOSTS = ['github.com', 'www.github.com', 'vvscribe.com', 'www.vvscribe.com']

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  downloadUrl: string
}

function parseVersion(raw: string): number[] {
  return raw.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
}

function isNewer(latest: number[], current: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    const l = latest[i] ?? 0
    const c = current[i] ?? 0
    if (l !== c) return l > c
  }
  return false
}

export function registerUpdateHandlers() {
  ipcMain.handle('app:getVersion', () => app.getVersion())

  ipcMain.handle('app:checkUpdate', async (): Promise<UpdateInfo> => {
    const currentVersion = app.getVersion()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch(RELEASE_API, {
        signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'vv-transcribe' },
      })
      if (!response.ok) {
        throw new Error(`GitHub API 返回 ${response.status}`)
      }
      const data = (await response.json()) as { tag_name?: string; html_url?: string }
      const latestVersion = (data.tag_name || '').replace(/^v/, '')
      if (!latestVersion) {
        throw new Error('无法解析最新版本号')
      }
      return {
        currentVersion,
        latestVersion,
        hasUpdate: isNewer(parseVersion(latestVersion), parseVersion(currentVersion)),
        downloadUrl: data.html_url || RELEASE_PAGE,
      }
    } finally {
      clearTimeout(timer)
    }
  })

  ipcMain.handle('app:openExternal', async (_event, url: string) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { success: false, error: '无效的链接' }
    }
    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.includes(parsed.hostname)) {
      return { success: false, error: '不允许打开该链接' }
    }
    await shell.openExternal(parsed.toString())
    return { success: true }
  })

  /**
   * 直达系统「隐私与安全性」面板，用于包内二进制被拦下执行（macOS「App 管理」/Gatekeeper）时一键跳转。
   * URL 写死、不接任何入参，故不存在被渲染进程注入任意 scheme 的风险。
   * 「App 管理」子页 Apple 没有稳定的深链 scheme，开总面板让用户点进去最可靠；非 macOS 交回界面按文案处理。
   */
  ipcMain.handle('app:openSystemSettings', async () => {
    if (process.platform !== 'darwin') {
      return { success: false, error: '请手动打开系统设置里的隐私与安全选项' }
    }
    try {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security')
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : '无法打开系统设置' }
    }
  })
}
