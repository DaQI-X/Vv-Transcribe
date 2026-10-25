/**
 * yt-dlp 清单（yt-dlp-manifest.json）的读取与校验，给构建脚本和 pnpm check:yt-dlp-manifest 共用。
 *
 * 这个文件是「安装包里塞哪一版 yt-dlp」和「应用内更新允许拉到哪一版」的唯一来源，
 * 所以两处消费方必须用同一套解析规则，不能各写一份正则。
 *
 * 信任边界：清单是本仓库里人工核对后提交的常量，不是网络数据。运行期（electron 主进程）
 * 读的是同一份 JSON 但从 raw.githubusercontent 拉，那份代码在 electron/main/services/ytDlpUpdate.ts，
 * 那里必须把输入当外部输入对待，不能复用这里的宽松校验。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const MANIFEST_PATH = join(__dirname, '..', '..', 'yt-dlp-manifest.json')

/** 官方 release 资产的下载前缀；镜像只在构建期通过 YTDLP_MIRROR 换，清单里没有这个字段 */
export const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/download'

/** yt-dlp 用日历版本：2026.10.21，同一天重发会带第四段 2026.10.21.1 */
export const VERSION_RE = /^\d{4}\.\d{1,2}\.\d{1,2}(\.\d+)?$/
const SHA256_RE = /^[0-9a-f]{64}$/
/** 资产名直接拼进 URL，所以不允许出现 / .. 之类能把请求指到别处的东西 */
const UPSTREAM_RE = /^[A-Za-z0-9._-]+$/

/** 清单里的 key 就是落盘目录名，运行时按 `${platform}-${arch}` 取（macOS 官方包是 Universal，两架构共用一份） */
export function assetKey(platform, arch) {
  if (platform === 'darwin') return 'darwin-universal'
  return `${platform}-${arch}`
}

export function binNameFor(key) {
  return key.startsWith('win32') ? 'yt-dlp.exe' : 'yt-dlp'
}

export class ManifestError extends Error {}

/** 逐条给出「哪一项不合规矩」，CI 红的时候不用再猜 */
export function validateManifest(raw, where = MANIFEST_PATH) {
  if (raw === null || typeof raw !== 'object') throw new ManifestError(`${where}: 顶层不是对象`)
  if (raw.component !== 'yt-dlp')
    throw new ManifestError(
      `${where}: component 应为 "yt-dlp"，实际 ${JSON.stringify(raw.component)}`
    )
  if (typeof raw.version !== 'string' || !VERSION_RE.test(raw.version)) {
    throw new ManifestError(
      `${where}: version ${JSON.stringify(raw.version)} 不是 yt-dlp 的日历版本号（YYYY.MM.DD[.N]）`
    )
  }
  if (typeof raw.reviewedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.reviewedAt)) {
    throw new ManifestError(
      `${where}: reviewedAt 缺失或不是 YYYY-MM-DD —— 这个字段是「人工核对过 release 页面」的日期，不能省`
    )
  }
  const assets = raw.assets
  if (assets === null || typeof assets !== 'object')
    throw new ManifestError(`${where}: assets 不是对象`)

  const entries = Object.entries(assets)
  if (entries.length === 0) throw new ManifestError(`${where}: assets 是空的`)
  for (const [key, a] of entries) {
    // 只检查格式，不强制覆盖全部平台：CI 一次构建只用得着自己那一条
    if (!/^(darwin-universal|win32-(x64|arm64)|linux-(x64|arm64))$/.test(key)) {
      throw new ManifestError(
        `${where}: assets 里有无法识别的 key "${key}"（应为 darwin-universal / win32-x64 / win32-arm64 / linux-x64 / linux-arm64）`
      )
    }
    if (a === null || typeof a !== 'object')
      throw new ManifestError(`${where}: assets.${key} 不是对象`)
    if (typeof a.upstream !== 'string' || !UPSTREAM_RE.test(a.upstream)) {
      throw new ManifestError(
        `${where}: assets.${key}.upstream ${JSON.stringify(a.upstream)} 不合法（只允许字母数字与 . _ -，因为它直接拼进下载 URL）`
      )
    }
    if (typeof a.sha256 !== 'string' || !SHA256_RE.test(a.sha256)) {
      throw new ManifestError(
        `${where}: assets.${key}.sha256 ${JSON.stringify(a.sha256)} 不是 64 位小写十六进制`
      )
    }
    if (!Number.isInteger(a.bytes) || a.bytes <= 0) {
      throw new ManifestError(
        `${where}: assets.${key}.bytes 应是正整数（用于界面显示体积与下载完整性核对）`
      )
    }
  }
  return raw
}

export function readManifest(path = MANIFEST_PATH) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ManifestError(`${path} 读不出来或不是合法 JSON：${err.message}`)
  }
  return validateManifest(parsed, path)
}

/** 逐段按数字比：2026.10.9 < 2026.10.21，字符串比会反过来 */
export function compareVersions(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** SHA2-256SUMS 是「<hash>␣␣<文件名>」的 GNU 格式 */
export function parseSumFile(text) {
  const map = new Map()
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length === 2 && SHA256_RE.test(parts[0])) map.set(parts[1], parts[0])
  }
  return map
}
