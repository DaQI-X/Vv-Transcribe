#!/usr/bin/env node
/**
 * yt-dlp 独立二进制下载脚本（打包前置步骤）
 *
 * 为什么打包进来：链接转写依赖 yt-dlp，而它过去只在本机 PATH 里找。
 * 从 Dock/Finder 启动的 macOS 应用拿不到 Homebrew 的 PATH，Windows 用户更是
 * 从没被要求装过它 —— 结果就是「链接转写」在安装包用户手里必然失败。
 *
 * 产物布局（与 electron-builder 的 extraResources、运行时路径解析三方一致）：
 *   vendor/yt-dlp/darwin-universal/yt-dlp      macOS 官方包是 Universal，arm64/x64 共用一份
 *   vendor/yt-dlp/win32-x64/yt-dlp.exe         Windows 按架构取包
 *   vendor/yt-dlp/linux-x64/yt-dlp
 *
 * 用法：
 *   node scripts/fetch-yt-dlp.mjs                      # 目标 = 当前主机
 *   node scripts/fetch-yt-dlp.mjs --arch=x64           # 覆盖架构（CI 的 win x64 / mac x64）
 *   YTDLP_MIRROR=https://<加速域名> pnpm fetch:yt-dlp  # GitHub 慢时换下载前缀
 *
 * 幂等：已存在且 SHA2-256 校验通过就直接跳过，本地重复打包不再吃这 37MB。
 *
 * 版本与指纹不在本脚本里，来自仓库根目录的 yt-dlp-manifest.json —— 构建期（这里）和运行期
 * （electron/main/services/ytDlpUpdate.ts 的应用内更新）读同一份清单，不会出现「安装包里钉的是 A，
 * 应用认为最新的是 B」这种两边各自漂移的坑。
 * 校验以清单里人工核对过的 SHA2-256 为准，上游 SHA2-256SUMS 只作二次交叉核对，两者不一致直接失败。
 * 升级流程见 pnpm check:yt-dlp-manifest 与 scripts/yt-dlp-manifest.mjs --write。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform, arch as hostArch, env } from 'node:process'
import { MANIFEST_PATH, assetKey, binNameFor, readManifest } from './lib/yt-dlp-manifest.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const BASE_URL = env.YTDLP_MIRROR || 'https://github.com/yt-dlp/yt-dlp/releases/download'

function fail(msg) {
  console.error(`\n[fetch-yt-dlp] ERROR: ${msg}\n`)
  process.exit(1)
}

function parseArgs() {
  const target = { platform, arch: hostArch }
  for (const a of process.argv.slice(2)) {
    const p = a.match(/^--platform=(.+)$/)
    const m = a.match(/^--arch=(.+)$/)
    if (p) target.platform = p[1]
    if (m) target.arch = m[1]
  }
  return target
}

const manifest = readManifest(MANIFEST_PATH)
const target = parseArgs()
const key = assetKey(target.platform, target.arch)
const entry = manifest.assets[key]
if (!entry) {
  fail(
    `${MANIFEST_PATH} 里没有 "${key}" 这一条资产（清单现有：${Object.keys(manifest.assets).join(', ')}）。` +
      '换平台构建要先在清单里补上该平台的官方资产名与指纹'
  )
}
// macOS 官方包是 Universal（10.15+），目录按 darwin-universal 命名，两种架构共用一份产物；
// 落地文件名统一成 yt-dlp[.exe]，运行时就不用再关心上游叫什么。
const asset = entry.upstream
const outFile = join(ROOT, 'vendor', 'yt-dlp', key, binNameFor(key))
const expected = entry.sha256

async function download(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) })
  if (!res.ok) fail(`下载失败 ${res.status} ${res.statusText}: ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

/** SHA2-256SUMS 是「<hash>␣␣<文件名>」的 GNU 格式 */
function parseSum(sumsText, assetName) {
  const line = sumsText
    .split('\n')
    .find((l) => l.trim().endsWith(` ${assetName}`) || l.trim().endsWith(`\t${assetName}`))
  if (!line)
    fail(`SHA2-256SUMS 里没有 ${assetName} 这一行，清单版本 ${manifest.version} 是否写错？`)
  return line.trim().split(/\s+/)[0]
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

console.log(`[fetch-yt-dlp] ${manifest.version} → ${asset} → ${outFile.replace(ROOT + '/', '')}`)

// 清单里的指纹是人工核对 release 页面后提交的；这里再与上游 sums 对一次，
// 为的是发现「清单填错」和「同一个 release 被重新发布过」这两种情况。换 YTDLP_MIRROR 时
// sums 与资产同源，这一层自证不了清白 —— 真正拦下篡改的是上面那份不来自下载响应的常量。
const sums = await download(`${BASE_URL}/${manifest.version}/SHA2-256SUMS`)
const upstream = parseSum(sums.toString('utf8'), asset)
if (upstream !== expected) {
  fail(
    `上游 SHA2-256SUMS 与清单钉死的值不一致（清单 ${expected} / 上游 ${upstream}）：` +
      `${manifest.version} 的发布产物被换过、镜像不完整，或清单里的版本写错了，拒绝继续`
  )
}
console.log(`[fetch-yt-dlp] expected sha256 ${expected}（清单钉死，且已与上游 sums 一致）`)

if (existsSync(outFile)) {
  const actual = sha256(readFileSync(outFile))
  if (actual === expected) {
    console.log('[fetch-yt-dlp] 已存在且校验通过，跳过下载')
    process.exit(0)
  }
  console.log(`[fetch-yt-dlp] 已存在但校验不符（${actual}），重新下载`)
  rmSync(outFile, { force: true })
}

const partFile = `${outFile}.part`
const data = await download(`${BASE_URL}/${manifest.version}/${asset}`)
if (data.length !== entry.bytes) {
  fail(
    `下载字节数 ${data.length} 与清单里的 ${entry.bytes} 不符（${asset} 被截断？请重试或换 YTDLP_MIRROR）`
  )
}
const actual = sha256(data)
if (actual !== expected) {
  rmSync(partFile, { force: true })
  fail(
    `校验不通过：期望 ${expected}，实际 ${actual}（下载被截断或被篡改，请重试或换 YTDLP_MIRROR）`
  )
}

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(partFile, data)
// darwin 的 Gatekeeper 会拦「未签名的隔离文件」，构建期落地的文件没有 com.apple.quarantine，
// 但仍需要可执行位；electron-builder 的 extraResources 不会补这一位。
chmodSync(partFile, 0o755)
renameSync(partFile, outFile)
console.log(`[fetch-yt-dlp] OK ${(data.length / 1e6).toFixed(1)} MB → ${outFile}`)
