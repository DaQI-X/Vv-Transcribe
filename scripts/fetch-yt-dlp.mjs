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
 * 校验以 PINNED_SHA256 为准，上游 SHA2-256SUMS 只作二次交叉核对，两者不一致直接失败。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform, arch as hostArch, env } from 'node:process'

/** 固定版本：升级 = 改这里 + 重新填下面的表；用户侧的新版由应用内更新（#134）负责 */
const YTDLP_VERSION = '2026.10.21'

/**
 * 钉死的产物指纹，key = `${版本}/${上游资产名}`。
 *
 * 为什么不能只信 SHA2-256SUMS：那个文件和二进制出自同一个 release、同一个域名（换 YTDLP_MIRROR
 * 时更是两个都来自镜像），发布页被换掉的话它能自证清白。钉在这里之后，要往安装包里塞东西
 * 必须同时改这个仓库的常量，两道关不在同一个攻击者手里。
 *
 * 升级流程：改 YTDLP_VERSION → 清空本表对应版本 → 跑一次下载，脚本会打印 actual → 把打印值填回来
 * （填之前先跟 release 页面、上游 changelog 对一眼，确认这串确实是官方产物）。
 */
const PINNED_SHA256 = {
  '2026.10.21/yt-dlp_macos': '7a6fe71d7d680f1fb0ac18d4949873d77db2859e90017c0f44bd94b23be4ee40',
  '2026.10.21/yt-dlp.exe': '33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555',
  '2026.10.21/yt-dlp_arm64.exe': '1380a9f105302764e6a5d383c2f07238ae242f0f4fbf3414aea00e56619a79b3',
  '2026.10.21/yt-dlp_linux': 'd8bd33fca9d5b23bd5b9952b3fca36db5c46331933fda9f598a3da14ce2c243f',
  '2026.10.21/yt-dlp_linux_aarch64': 'e137c2171b0b8ef648e6136e86aa70c65923e93e434f01c93901d64744b190aa',
}

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

/**
 * 上游资产名 + 落地目录 + 落地文件名。
 * macOS 的 yt-dlp_macos 是 Universal（10.15+），所以目录按 universal 命名，两种架构共用一份产物；
 * 落地文件名统一成 yt-dlp[.exe]，运行时就不用再关心上游叫什么。
 */
function resolveTarget({ platform: osName, arch: cpuArch }) {
  if (osName === 'darwin') {
    return { asset: 'yt-dlp_macos', dir: 'darwin-universal', bin: 'yt-dlp' }
  }
  if (osName === 'win32') {
    const asset = cpuArch === 'arm64' ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe'
    return { asset, dir: `win32-${cpuArch}`, bin: 'yt-dlp.exe' }
  }
  if (osName === 'linux') {
    return { asset: cpuArch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux', dir: `linux-${cpuArch}`, bin: 'yt-dlp' }
  }
  fail(`不支持的平台 ${osName}`)
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) })
  if (!res.ok) fail(`下载失败 ${res.status} ${res.statusText}: ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

/** SHA2-256SUMS 是「<hash>␣␣<文件名>」的 GNU 格式 */
function parseSum(sumsText, asset) {
  const line = sumsText.split('\n').find((l) => l.trim().endsWith(` ${asset}`) || l.trim().endsWith(`\t${asset}`))
  if (!line) fail(`SHA2-256SUMS 里没有 ${asset} 这一行，版本 ${YTDLP_VERSION} 是否写错？`)
  return line.trim().split(/\s+/)[0]
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

const target = resolveTarget(parseArgs())
const outDir = join(ROOT, 'vendor', 'yt-dlp', target.dir)
const outFile = join(outDir, target.bin)
const sumUrl = `${BASE_URL}/${YTDLP_VERSION}/SHA2-256SUMS`

console.log(`[fetch-yt-dlp] ${YTDLP_VERSION} → ${target.asset} → ${outFile.replace(ROOT + '/', '')}`)

const pinnedKey = `${YTDLP_VERSION}/${target.asset}`
const pinned = PINNED_SHA256[pinnedKey]
if (!pinned) {
  fail(
    `${pinnedKey} 没有钉死 sha256。升级流程：先跑一次下载拿到脚本打印的 actual，` +
      '与官方 release 页面对一眼后填进 PINNED_SHA256 —— 本脚本不接受「现取现用」的上游校验值',
  )
}

const sums = await download(sumUrl)
const upstream = parseSum(sums.toString('utf8'), target.asset)
if (upstream !== pinned) {
  fail(
    `上游 SHA2-256SUMS 与仓库钉死的值不一致（钉 ${pinned} / 上游 ${upstream}）：` +
      `${YTDLP_VERSION} 的发布产物被换过、镜像不完整，或 YTDLP_VERSION 写错了，拒绝继续`,
  )
}
const expected = pinned
console.log(`[fetch-yt-dlp] expected sha256 ${expected}（仓库钉死，且已与上游 sums 一致）`)

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
const data = await download(`${BASE_URL}/${YTDLP_VERSION}/${target.asset}`)
const actual = sha256(data)
if (actual !== expected) {
  rmSync(partFile, { force: true })
  fail(`校验不通过：期望 ${expected}，实际 ${actual}（下载被截断或被篡改，请重试或换 YTDLP_MIRROR）`)
}

mkdirSync(outDir, { recursive: true })
writeFileSync(partFile, data)
// darwin 的 Gatekeeper 会拦「未签名的隔离文件」，构建期落地的文件没有 com.apple.quarantine，
// 但仍需要可执行位；electron-builder 的 extraResources 不会补这一位。
chmodSync(partFile, 0o755)
renameSync(partFile, outFile)
console.log(`[fetch-yt-dlp] OK ${(data.length / 1e6).toFixed(1)} MB → ${outFile}`)
