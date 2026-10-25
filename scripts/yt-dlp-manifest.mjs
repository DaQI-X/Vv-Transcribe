#!/usr/bin/env node
/**
 * yt-dlp 清单（yt-dlp-manifest.json）的对账与生成工具
 *
 * 用法：
 *   pnpm check:yt-dlp-manifest                     # 校验已提交的清单，并与上游 SHA2-256SUMS 逐条对账
 *   node scripts/yt-dlp-manifest.mjs --offline     # 只做本地格式校验（不联网，改文案时快速自测）
 *   node scripts/yt-dlp-manifest.mjs --write --version=2026.11.01   # 升级 yt-dlp 时重新生成清单
 *
 * 为什么这里不接 YTDLP_MIRROR：这个工具的职责是「确认这串指纹确实是官方产物」，
 * 而镜像同时提供资产和 sums 时它自己就能自证清白。下载走镜像（scripts/fetch-yt-dlp.mjs），核对只走官方域名。
 *
 * 清单里那串 sha256 的意义：它是本仓库里人工核对后提交的常量。运行期应用只信清单里的值，
 * 下载地址由应用自己拼（官方域名 + 清单里的版本与资产名），所以换掉上游 release 页面不足以让应用收下别的文件；
 * 但要往安装包里塞东西仍然必须同时改这个仓库的文件——与 #182 记下的是同一个「同源自证」边界。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  MANIFEST_PATH,
  RELEASE_BASE,
  VERSION_RE,
  compareVersions,
  parseSumFile,
  readManifest,
  validateManifest,
} from './lib/yt-dlp-manifest.mjs'

/** 与 scripts/fetch-yt-dlp.mjs 的落盘布局一致；bin 名由 key 决定，清单里不存这个字段 */
const PLATFORM_KEYS = ['darwin-universal', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64']

function fail(msg) {
  console.error(`\n[yt-dlp-manifest] ERROR: ${msg}\n`)
  process.exit(1)
}

function parseArgs() {
  const args = { write: false, version: '', offline: false }
  for (const a of process.argv.slice(2)) {
    if (a === '--write') args.write = true
    else if (a === '--offline') args.offline = true
    else if (a.startsWith('--version=')) args.version = a.slice('--version='.length)
    else fail(`不认识的参数 ${a}（可用：--write --version= --offline）`)
  }
  return args
}

async function get(url, headers) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
    headers: { 'User-Agent': 'vv-transcribe-manifest-check', ...headers },
  })
  if (!res.ok) fail(`请求失败 ${res.status} ${res.statusText}: ${url}`)
  return res
}

/**
 * 上游 sums + Release API 拿到「这一版官方提供了什么」。
 * 体积取 API 的 size（本地实测 yt-dlp_macos 的 size 与落盘字节数一致），更新时间用来发现「同一个 tag 被编辑过」。
 */
async function collectUpstream(version) {
  const sumsRes = await get(`${RELEASE_BASE}/${version}/SHA2-256SUMS`)
  const sums = parseSumFile(await sumsRes.text())
  if (sums.size === 0) fail(`SHA2-256SUMS 里一条都没解析出来，${version} 的发布页是不是变了？`)

  const release = await (
    await get(`https://api.github.com/repos/yt-dlp/yt-dlp/releases/tags/${version}`, {
      Accept: 'application/vnd.github+json',
    })
  ).json()
  const sizeByName = new Map((release.assets || []).map((a) => [a.name, a.size]))
  if (release.published_at && release.updated_at && release.updated_at !== release.published_at) {
    console.warn(
      `[yt-dlp-manifest] 注意：${version} 这个 release 被编辑过（发布 ${release.published_at} / 更新 ${release.updated_at}）。\n` +
        '                    官方日常不会改已发布的 release，填指纹前请先弄清改了什么。'
    )
  }
  return { sums, sizeByName }
}

function pinTable(assets) {
  return PLATFORM_KEYS.filter((k) => assets[k]).map(
    (k) =>
      `${k.padEnd(16)} ${String(assets[k].upstream).padEnd(21)} ${assets[k].sha256} ${String(assets[k].bytes).padStart(10)}`
  )
}

async function check(offline) {
  const manifest = readManifest()
  console.log(
    `[yt-dlp-manifest] ${MANIFEST_PATH.replace(process.cwd() + '/', '')} → version ${manifest.version}（核对日期 ${manifest.reviewedAt}）`
  )
  for (const line of pinTable(manifest.assets)) console.log(`  ${line}`)

  const missing = PLATFORM_KEYS.filter((k) => !manifest.assets[k])
  if (missing.length) {
    console.warn(
      `[yt-dlp-manifest] 清单缺这些平台的资产：${missing.join(', ')}（那些平台的应用内更新会报「没有可用的更新包」）`
    )
  }

  if (offline) {
    console.log('[yt-dlp-manifest] --offline：跳过与上游 SHA2-256SUMS 的对账')
    return
  }

  const { sums, sizeByName } = await collectUpstream(manifest.version)
  let bad = 0
  for (const [key, a] of Object.entries(manifest.assets)) {
    const upstream = sums.get(a.upstream)
    if (!upstream) {
      console.error(`  ✗ ${key}: 上游 SHA2-256SUMS 里没有 ${a.upstream} 这一行`)
      bad++
      continue
    }
    if (upstream !== a.sha256) {
      console.error(
        `  ✗ ${key}: 清单 ${a.sha256} ≠ 上游 ${upstream} —— ${manifest.version} 的发布产物被换过，或清单填错了`
      )
      bad++
      continue
    }
    const officialBytes = sizeByName.get(a.upstream)
    if (officialBytes !== undefined && officialBytes !== a.bytes) {
      console.error(
        `  ✗ ${key}: 清单 bytes ${a.bytes} ≠ Release API 的 ${a.upstream} size ${officialBytes}`
      )
      bad++
      continue
    }
    console.log(`  ✓ ${key} (${a.upstream}) 与上游一致，${(a.bytes / 1e6).toFixed(1)} MB`)
  }
  if (bad) fail(`${bad} 条对不上。这个清单是应用内更新的唯一信任来源，不一致就是拒绝构建的理由`)
  console.log('[yt-dlp-manifest] 全部资产与上游 SHA2-256SUMS / Release API 一致')
}

async function write(version) {
  if (!VERSION_RE.test(version))
    fail(`--write 需要 --version=YYYY.MM.DD[.N]，收到 ${JSON.stringify(version)}`)
  const { sums, sizeByName } = await collectUpstream(version)

  const previous = existsSync(MANIFEST_PATH)
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : null
  if (!previous?._comment || !previous?._verify) {
    fail('现有清单缺 _comment/_verify 说明字段。这两个字段是给下一个改它的人看的，脚本不该编内容。')
  }
  if (previous.version === version) {
    const drifted = Object.entries(previous.assets || {}).filter(
      ([, a]) => sums.get(a.upstream) && sums.get(a.upstream) !== a.sha256
    )
    if (drifted.length) {
      fail(
        `${version} 已经钉过，但上游现在给的是另一串指纹：\n` +
          drifted
            .map(([k, a]) => `    ${k}: 仓库 ${a.sha256} → 上游 ${sums.get(a.upstream)}`)
            .join('\n') +
          '\n  这意味着同一个 release 被重新发布过。先弄清原因，确认无误后手工删掉清单里这些条目再跑本命令。'
      )
    }
  } else if (compareVersions(version, previous.version) < 0) {
    console.warn(
      `[yt-dlp-manifest] 注意：清单当前是 ${previous.version}，你要写入更旧的 ${version}（回退）。` +
        '改了这份文件，之后的安装包和用户机上的「已是最新」判断都跟着变旧。'
    )
  }

  const assets = {}
  for (const key of PLATFORM_KEYS) {
    const upstream = {
      'darwin-universal': 'yt-dlp_macos',
      'win32-x64': 'yt-dlp.exe',
      'win32-arm64': 'yt-dlp_arm64.exe',
      'linux-x64': 'yt-dlp_linux',
      'linux-arm64': 'yt-dlp_linux_aarch64',
    }[key]
    const sha256 = sums.get(upstream)
    const bytes = sizeByName.get(upstream)
    if (!sha256) fail(`上游 SHA2-256SUMS 里没有 ${upstream}（${version} 改名了？清单不能凭空补）`)
    if (!Number.isInteger(bytes))
      fail(`Release API 没给出 ${upstream} 的 size，清单的 bytes 只能留空——先弄清为什么`)
    assets[key] = { upstream, sha256, bytes }
  }

  const manifest = {
    _comment: previous._comment,
    _verify: previous._verify,
    component: 'yt-dlp',
    version,
    reviewedAt: new Date().toISOString().slice(0, 10),
    assets,
  }
  validateManifest(manifest, '即将写入的内容')

  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`[yt-dlp-manifest] 已写入 ${MANIFEST_PATH}`)
  for (const line of pinTable(assets)) console.log(`  ${line}`)
  console.log(
    `\n下一步（别跳过）：\n` +
      `  1. 打开 https://github.com/yt-dlp/yt-dlp/releases/tag/${version}，把上面每串 sha256 与页面上的 sums 对一眼\n` +
      `  2. 读一遍 changelog，确认这一版没有把链接解析需要的行为改掉\n` +
      `  3. pnpm check:yt-dlp-manifest && pnpm fetch:yt-dlp 再跑一次构建期校验\n` +
      `  4. 提交这个文件；应用侧的新版由「关于与更新 → 链接解析组件」拉到\n`
  )
}

const args = parseArgs()
if (args.write) await write(args.version)
else await check(args.offline)
