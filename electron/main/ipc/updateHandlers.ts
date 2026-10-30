/**
 * 应用更新检查 IPC 处理器
 * 查询 GitHub Release 最新版本并与当前应用版本比较。
 * 不做自动下载/安装（应用未签名，electron-updater 不可用），仅引导用户到 GitHub Release 页下载安装包。
 *
 * 另一个通道组是 yt-dlp 组件的应用内更新（ytDlp:*）：那个是能真正装上的，
 * 因为它换的是 userData/bin 里的一份工具二进制，不是应用本体。信任模型见 services/ytDlpUpdate.ts。
 *
 * 注册统一走 guard.ts：这两组都有一条原先带 try/finally 却没有 catch 的路
 * （app:checkUpdate 的 fetch、checkYtDlpUpdate 里探测本机那一步），抛出去就是渲染层的一个 reject。
 * 收口之后它们改回值，所以两条通道的形状各多了一个 error 槽位——渲染层必须读它，
 * 否则「问不出新版本」会被显示成「当前已是最新版本」。
 */
import { app, shell } from 'electron'
import {
  applyYtDlpUpdate,
  checkYtDlpUpdate,
  getLocalYtDlpInfo,
  type YtDlpLocalInfo,
  type YtDlpProgress,
} from '../services/ytDlpUpdate'
import { failSuccessError, ipcHandle } from './guard'

const RELEASE_API = 'https://api.github.com/repos/DaQI-X/Vv-Transcribe/releases/latest'
const RELEASE_PAGE = 'https://github.com/DaQI-X/Vv-Transcribe/releases/latest'

// 仅允许打开白名单域名，防止渲染进程传入任意 URL 造成开放跳转
const ALLOWED_HOSTS = ['github.com', 'www.github.com', 'vvscribe.com', 'www.vvscribe.com']

/** 与官网 nuxt.config.ts 的 contactEmail 同一个地址 */
const CONTACT_EMAIL = 'hi@vvscribe.com'

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  downloadUrl: string
  /** 问不出新版本时的原话；null＝这次真的问到了。界面必须读它，否则失败会被显示成「已是最新版」 */
  error: string | null
}

/**
 * ytDlp:getLocal 的返回值。探测本身要 spawn 一次组件进程，那条路是有可能抛的，
 * 而这一栏在界面上「还没读到」和「读失败了」长得一样（都停在「读取中...」）。
 * 所以失败不能回 null，也不能回一份 source 齐全的快照（那就是编造来源）——回一句 error，
 * 让界面既能把版本栏停在真话上，也能把原因弹出来。
 */
export interface YtDlpLocalSnapshot {
  info: YtDlpLocalInfo | null
  error: string | null
}

function parseVersion(raw: string): number[] {
  return raw
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
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
  // app.getVersion() 读的是包内版本，是同步调用、实际不会抛；这里回 '' 只是 guard 要求的声明
  ipcHandle('app:getVersion', () => app.getVersion(), () => '')

  ipcHandle(
    'app:checkUpdate',
    async (): Promise<UpdateInfo> => {
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
          error: null,
        }
      } finally {
        clearTimeout(timer)
      }
    },
    // 「问不出新版本」绝不能长成「当前已是最新版本」：hasUpdate 必须是 false，同时把原因带上
    (message) => ({
      currentVersion: app.getVersion(),
      latestVersion: '',
      hasUpdate: false,
      downloadUrl: RELEASE_PAGE,
      error: message,
    })
  )

  /**
   * 链接解析组件（yt-dlp）：本机当前生效的那一份是什么版本、从哪一档来的。
   * 这里会 spawn 一次 --version（内置二进制第一次跑要解包，一两秒），所以只在打开「关于与更新」时调。
   */
  ipcHandle(
    'ytDlp:getLocal',
    async (): Promise<YtDlpLocalSnapshot> => ({ info: await getLocalYtDlpInfo(), error: null }),
    (message) => ({ info: null, error: message })
  )

  // YtDlpCheckResult 本来就有 error 槽位，失败值直接填它，界面那侧一行都不用改
  ipcHandle('ytDlp:check', () => checkYtDlpUpdate(), (message) => ({ ok: false, error: message }))

  /**
   * 真的把新版拉下来并装上。37MB 的下载在慢网里要跑几分钟，
   * 进度按字节走 asr:progress 的同一种写法推给界面，否则按钮看着像卡死。
   */
  ipcHandle(
    'ytDlp:apply',
    async (event) => {
      const onProgress = (p: YtDlpProgress) => {
        if (!event.sender.isDestroyed()) event.sender.send('ytDlp:progress', p)
      }
      return applyYtDlpUpdate(onProgress)
    },
    failSuccessError
  )

  ipcHandle(
    'app:openExternal',
    async (_event, url: string) => {
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
    },
    failSuccessError
  )

  /**
   * 直达系统「隐私与安全性」面板，用于包内二进制被拦下执行（macOS「App 管理」/Gatekeeper）时一键跳转。
   * URL 写死、不接任何入参，故不存在被渲染进程注入任意 scheme 的风险。
   * 「App 管理」子页 Apple 没有稳定的深链 scheme，开总面板让用户点进去最可靠；非 macOS 交回界面按文案处理。
   */
  ipcHandle(
    'app:openSystemSettings',
    async () => {
      if (process.platform !== 'darwin') {
        return { success: false, error: '请手动打开系统设置里的隐私与安全选项' }
      }
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security')
      return { success: true }
    },
    failSuccessError
  )

  /**
   * 反馈通道。关于页一直写着「把日志文件发给开发者」，却没给任何收件地址，指令是条死路。
   * 不走 app:openExternal：那里只放行 https + 白名单域名，mailto 会被判「不允许打开该链接」。
   * 与 app:openSystemSettings 同一种写法——URL 在主进程拼死、不接渲染进程入参，
   * 免得渲染层被注入成任意收件人。
   */
  ipcHandle(
    'app:contactDeveloper',
    async () => {
      const env = [
        `应用版本：v${app.getVersion()}`,
        `系统：${process.platform} ${process.arch} / ${process.getSystemVersion()}`,
        '日志：设置 → 关于与更新 → 打开日志文件夹，请把其中的 .log 文件作为附件一并发来',
      ].join('\n')

      const url =
        `mailto:${CONTACT_EMAIL}` +
        `?subject=${encodeURIComponent(`Vv Transcribe v${app.getVersion()} 问题反馈`)}` +
        `&body=${encodeURIComponent('请描述：在哪一步失败、上传的是什么素材、预期结果是什么。\n\n\n' + env)}`

      await shell.openExternal(url)
      return { success: true, email: CONTACT_EMAIL }
    },
    // email 也要带上：界面拿它做「复制收件人」，那是打不开邮件客户端时唯一的出路
    (message) => ({ success: false, email: CONTACT_EMAIL, error: message })
  )
}
