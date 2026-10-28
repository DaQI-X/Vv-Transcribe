#!/usr/bin/env node
/**
 * 本地配音组件的资产打包、清单生成与发布后对账（#234）
 *
 * 用法：
 *   node scripts/components-manifest.mjs                                   # 校验已提交的清单，并与 GitHub Release 上的资产对账
 *   node scripts/components-manifest.mjs --offline                          # 只做本地结构校验（不联网；改文案或 CI 无 token 时用）
 *   node scripts/components-manifest.mjs --build --staging=DIR --out=DIR --version=1.0.6
 *                                                                          # 从暂存目录产出资产 + 写 components-manifest.json
 *
 * 暂存目录的布局（CI 与手工都一样，脚本按这个布局发现资产，不做「猜哪个文件是引擎」）：
 *   <staging>/darwin-arm64/vv-tts-server
 *   <staging>/darwin-x64/vv-tts-server
 *   <staging>/win32-x64/vv-tts-server.exe
 *   <staging>/models/sherpa-onnx-vits-zh-ll/...        ← 目录内容就是模型本身，不再套一层
 *   <staging>/models/kokoro-multi-lang-v1_1/...
 *
 * 为什么归档要自己写而不调系统 tar：
 * - 清单里的 fileCount / extractedBytes 必须和应用解包后数出来的那两个数**完全一致**，
 *   而「一致」只有在我们用同一套口径算的时候才成立（解包侧只数普通文件，目录项不计，见 componentArchive.ts 的 entries）；
 * - macOS 上 bsdtar 会塞 AppleDouble（ ._model.onnx 之类），实测一份 17 个文件的模型打成 37 个，
 *   装完直接让引擎报缺文件；GNU tar 的 --mtime/--sort 在 bsdtar 上又不存在。自己写 ustar 三个平台一份字节。
 * - mtime 固定为 0：同一棵树重打两次必须得到同一个 sha256，否则 --build 重跑一次就把清单指纹改了，
 *   git diff 里全是噪音，也没法回答「这次清单变动到底是内容变了还是打包时间变了」。
 *
 * 信任边界与 yt-dlp 那条一致（#182）：清单里那串 sha256 是人工核对后提交的常量，下载地址由应用自己拼
 * （自家 Release 前缀 + 清单里的 tag 与资产名）。这个脚本的 --check 那一步是发布后的独立复核：
 * GitHub 会为每个资产自己算一个 digest，清单说的指纹和 GitHub 算出来的对不上，就说明资产被换过或清单填错了。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = join(ROOT, 'components-manifest.json')

/** 与 electron/main/services/componentService.ts 的那几道闸一字不差，改那边要改这边 */
const SCHEMA = 1
const COMPONENT_NAME = 'vv-components'
const TAG_RE = /^v?\d+\.\d+\.\d+(?:[-.][\w.]+)?$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-.][\w.]+)?$/
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SHA256_RE = /^[0-9a-f]{64}$/
const REPO = 'DaQI-X/Vv-Transcribe'
const RELEASE_BASE = `https://github.com/${REPO}/releases/download`

const ENGINE_ID = 'vv-tts-server'
/** 应用按 process.platform-process.arch 取那一条；win32-arm64 目前 CI 不产，清单里缺它是正常状态 */
const ENGINE_KEYS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64']
const BINARY_NAME = (key) => (key.startsWith('win32') ? 'vv-tts-server.exe' : 'vv-tts-server')

/**
 * 必需文件表，镜像 componentService.ts 的 MODEL_REQUIRED（源头是 python-tts/main.py 的 ENGINES）。
 * 三份各写一次是刻意的：发布侧少了 .fst 只会让「2026 年」悄悄读成逐字，那种降级在界面上看不出来，
 * 所以要在上传前就拦住，而不是等用户的机器上装完再发现。
 */
const MODEL_REQUIRED = {
  'tts-model-sherpa-onnx-vits-zh-ll': [
    'model.onnx',
    'tokens.txt',
    'lexicon.txt',
    'dict/',
    'date.fst',
    'number.fst',
    'phone.fst',
    'new_heteronym.fst',
  ],
  'tts-model-kokoro-multi-lang-v1_1': [
    'model.onnx',
    'tokens.txt',
    'voices.bin',
    'lexicon-zh.txt',
    'lexicon-us-en.txt',
    'lexicon-gb-en.txt',
    'dict/',
    'espeak-ng-data/',
    'date-zh.fst',
    'number-zh.fst',
    'phone-zh.fst',
  ],
}
const KNOWN_IDS = [ENGINE_ID, ...Object.keys(MODEL_REQUIRED)]

/** 首次创建清单时写进那两个说明字段的原文；之后 --build 只保留现有内容，不编新的 */
const INITIAL_NOTES = {
  _comment:
    '本地配音组件的按需下载清单。应用只信这个文件：下载地址由代码里写死的自家 Release 前缀 + 这里的 tag 与资产名拼出来，' +
    '落点由代码里的组件白名单决定，这个文件改不了写到哪。改这里必须同时改 .github/workflows 的发布流程，否则装不上。',
  _verify:
    '发布后用 GitHub Release 的资产 digest（GitHub 自己算的 SHA2-256）复核：node scripts/components-manifest.mjs。' +
    '资产由组件发布流程上传（workflow_dispatch 表单，或推一个 components/vX.Y.Z.run.<build run-id> tag，两种都必须指名那一次构建）；' +
    '清单要人工看过 diff 再合进 main——没合进 main 之前应用内读不到它。',
}

function fail(msg) {
  console.error(`\n[components-manifest] ERROR: ${msg}\n`)
  process.exit(1)
}

function warn(msg) {
  console.warn(`[components-manifest] ${msg}`)
}

function parseArgs() {
  const args = {
    build: false,
    offline: false,
    staging: '',
    out: '',
    version: '',
    tag: '',
    manifest: MANIFEST_PATH,
    // 「仓库里还没有清单」是可以接受的正常状态，但「指名要查的那个文件不在」必须是错误：
    // 不然哪天清单换了目录，CI 会绿着什么都不对
    manifestGiven: false,
  }
  for (const a of process.argv.slice(2)) {
    if (a === '--build') args.build = true
    else if (a === '--offline') args.offline = true
    else if (a.startsWith('--staging=')) args.staging = a.slice('--staging='.length)
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length)
    else if (a.startsWith('--version=')) args.version = a.slice('--version='.length)
    else if (a.startsWith('--tag=')) args.tag = a.slice('--tag='.length)
    else if (a.startsWith('--manifest=')) {
      args.manifest = a.slice('--manifest='.length)
      args.manifestGiven = true
    } else fail(`不认识的参数 ${a}（可用：--build --offline --staging= --out= --version= --tag= --manifest=）`)
  }
  return args
}

/** 整份文件的 SHA2-256。129MB 也一次过，不读进内存 */
async function sha256OfFile(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), async function sink(src) {
    for await (const chunk of src) hash.update(chunk)
  })
  return hash.digest('hex')
}

/**
 * 递归列一棵树，按名字排序，返回普通文件与目录两组。
 * 符号链接与非普通文件直接拒绝：模型目录里不该有这些东西，出现了要么是人放错了，要么是别人动过源，
 * 而跟着打包进归档正好是「让用户机器解包时多一条链接处理路径」——那条路在解包侧是被明令拒绝的。
 */
function walkTree(root) {
  const files = []
  const dirs = []
  const stack = [{ abs: root, rel: '' }]
  while (stack.length > 0) {
    const { abs, rel } = stack.pop()
    for (const item of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel === '' ? item.name : `${rel}/${item.name}`
      const childAbs = join(abs, item.name)
      if (item.isSymbolicLink()) fail(`源目录里有符号链接：${childRel}。归档不接受链接`)
      if (item.isDirectory()) {
        dirs.push(childRel)
        stack.push({ abs: childAbs, rel: childRel })
        continue
      }
      if (!item.isFile()) fail(`源目录里有非普通文件：${childRel}（${item.name}）`)
      files.push({ rel: childRel, abs: childAbs, size: statSync(childAbs).size })
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1))
  // 字典序天然让父目录排在子目录前面（"segment0" < "segment0/segment1"），解包侧少建一次父目录
  dirs.sort()
  return { files, dirs }
}

const BLOCK = 512

/** 定长八进制字段：len-1 位数字 + NUL，这是 ustar 的写法，解包侧 field()+parseInt(8) 认这个 */
function octal(value, len) {
  return value.toString(8).padStart(len - 1, '0') + '\0'
}

/** 一条 512 字节头部；校验和字段先填空格求和，再回填「6 位八进制 + NUL + 空格」 */
function header({ name, prefix = '', mode, size, typeflag }) {
  const block = Buffer.alloc(BLOCK)
  // 名字按字节切：用 write(str, ..., 'utf8') 截断会把一个多字节字符砍成半个，解包侧就拿到坏名字
  Buffer.from(name, 'utf8').copy(block, 0, 0, 100)
  block.write(octal(mode, 8), 100, 8)
  block.write(octal(0, 8), 108, 8)
  block.write(octal(0, 8), 116, 8)
  block.write(octal(size, 12), 124, 12)
  // mtime 恒为 0：可复现性比「包里有真实时间戳」有用（理由见文件头）
  block.write(octal(0, 12), 136, 12)
  block.write('        ', 148, 8)
  block.write(typeflag, 156, 1)
  block.write('ustar\0', 257, 6)
  block.write('00', 263, 2)
  block.write('root', 265, 4)
  block.write('root', 297, 4)
  block.write(octal(0, 8), 329, 8)
  block.write(octal(0, 8), 337, 8)
  if (prefix) Buffer.from(prefix, 'utf8').copy(block, 345, 0, 155)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += block[i]
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return block
}

/** GNU 长名：名字超过 100 字节时先写一条 'L'，正文是名字本身 + NUL，紧跟的那条头部用它 */
function longNameHeader(name) {
  const body = Buffer.from(name + '\0', 'utf8')
  const blocks = []
  blocks.push(header({ name: '././@LongLink', mode: 0o644, size: body.length, typeflag: 'L' }))
  blocks.push(body)
  const pad = Math.ceil(body.length / BLOCK) * BLOCK - body.length
  if (pad > 0) blocks.push(Buffer.alloc(pad))
  return blocks
}

/** 把名字切成 ustar 能放的形状：能直接放就放，放不下的用 prefix（GNU 也认）或长名 */
function nameParts(rawName) {
  // 目录项按惯例带尾斜杠，但斜杠不该参与「最后一段」的切分，切完再补回去。
  // 早先没处理这一条："…/segment5/" 的尾段是空串，打出的目录项名字为空，解包侧当场判「目录名不合法」
  const trailing = rawName.endsWith('/') ? '/' : ''
  const core = trailing ? rawName.slice(0, -1) : rawName
  if (Buffer.byteLength(rawName, 'utf8') <= 100) return { name: rawName, prefix: '', long: null }
  const slash = core.lastIndexOf('/')
  const tailName = core.slice(slash + 1) + trailing
  const prefix = core.slice(0, slash)
  // prefix 字段是 155 字节，不是 155 个字符——名字里有非 ASCII 时两个数不一样，按字节判
  if (slash > 0 && Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(tailName, 'utf8') <= 100) {
    return { name: tailName, prefix, long: null }
  }
  // GNU 的写法：头部名字字段放尾巴，完整名字由前面那条 'L' 给出。尾巴按字节切，可能砍开码点，
  // 所以解掉替换符——我们的解包器在这种情况下用的是 'L' 里的名字，这个字段只是给系统 tar 看的
  const tail = Buffer.from(rawName, 'utf8').subarray(-100).toString('utf8').replace(/\uFFFD/g, '')
  return { name: tail, prefix: '', long: rawName }
}

/**
 * 把一棵目录树打成 .tar.gz，返回清单要的那几个数。
 * 归档根＝目录内容本身：解包侧拿 required 逐条点名（model.onnx 在根上），多套一层目录就全对不上。
 */
async function packTarGz(sourceDir, outFile) {
  const { files, dirs } = walkTree(sourceDir)
  if (files.length === 0) fail(`${sourceDir} 是空的，没什么可打包`)
  const out = createWriteStream(outFile)
  const gz = createGzip()
  const writer = (async function* source() {
    for (const dir of dirs) {
      const parts = nameParts(`${dir}/`)
      if (parts.long) yield* longNameHeader(parts.long)
      yield header({ name: parts.name, prefix: parts.prefix, mode: 0o755, size: 0, typeflag: '5' })
    }
    for (const file of files) {
      const parts = nameParts(file.rel)
      if (parts.long) yield* longNameHeader(parts.long)
      yield header({ name: parts.name, prefix: parts.prefix, mode: 0o644, size: file.size, typeflag: '0' })
      yield* createReadStream(file.abs)
      const pad = Math.ceil(file.size / BLOCK) * BLOCK - file.size
      if (pad > 0) yield Buffer.alloc(pad)
    }
    // 结束标记：两个全零块，尾部再补到 10240 的倍数（POSIX 要求，系统 tar 数目录时靠它）
    yield Buffer.alloc(2 * BLOCK)
  })()
  await pipeline(writer, gz, out)

  const bytes = statSync(outFile).size
  return {
    sha256: await sha256OfFile(outFile),
    bytes,
    // 这两项的口径必须是解包侧算出来的那两个数：只数普通文件、体积是解压后各文件之和
    fileCount: files.length,
    extractedBytes: files.reduce((total, file) => total + file.size, 0),
    names: files.map((file) => file.rel),
  }
}

async function packBinary(sourceFile, outFile) {
  const info = statSync(sourceFile)
  if (!info.isFile()) fail(`${sourceFile} 不是一个普通文件`)
  if (outFile !== sourceFile) copyFileSync(sourceFile, outFile)
  return { sha256: await sha256OfFile(outFile), bytes: info.size }
}

/** 归档解出来必须有齐这些名字；'dict/' 这种结尾带 / 的只要「下面有东西」，与解包侧同一口径 */
function assertRequired(names, required, label) {
  const missing = required.filter((entry) => {
    const bare = entry.replace(/\/+$/, '')
    return !names.some((name) => name === bare || name.startsWith(`${bare}/`))
  })
  if (missing.length > 0) {
    fail(
      `${label} 缺这些必需文件：${missing.join('、')}。` +
        '这样的包传上去，用户装完会在配音时报看不懂的降级或文件错误——先把源目录补全再打。'
    )
  }
}

function assetNameFor(id, key, version) {
  return key === 'any' ? `${id}-${version}.tar.gz` : `${ENGINE_ID}-${key}-${version}`
}

async function build(args) {
  if (!args.staging || !args.out) fail('--build 需要 --staging= 与 --out=')
  if (!VERSION_RE.test(args.version)) fail(`--build 需要 --version=1.0.6，收到 ${JSON.stringify(args.version)}`)
  const tag = args.tag || `v${args.version}`
  if (!TAG_RE.test(tag)) fail(`--tag=${args.tag} 不合规矩（应形如 v1.0.6）`)

  mkdirSync(args.out, { recursive: true })
  const entries = {}

  for (const key of ENGINE_KEYS) {
    const source = join(args.staging, key, BINARY_NAME(key))
    if (!existsSync(source)) {
      warn(`没有 ${key} 的引擎二进制（${source}）——这个平台在清单里会是空的，界面上那句「没有对应下载包」由此来`)
      continue
    }
    const name = assetNameFor(ENGINE_ID, key, args.version)
    const target = join(args.out, name)
    if (existsSync(target)) rmSync(target)
    const packed = await packBinary(source, target)
    entries[ENGINE_ID] = entries[ENGINE_ID] || { version: args.version, assets: {} }
    entries[ENGINE_ID].assets[key] = { name, sha256: packed.sha256, bytes: packed.bytes }
    console.log(`  packed ${name}  ${(packed.bytes / 1e6).toFixed(1)}MB  ${packed.sha256}`)
  }
  if (!entries[ENGINE_ID] || Object.keys(entries[ENGINE_ID].assets).length === 0) {
    fail(`${args.staging} 里一个引擎二进制都没找到。布局应为 <staging>/<platform>-<arch>/${BINARY_NAME('darwin-arm64')}`)
  }

  const modelsRoot = join(args.staging, 'models')
  for (const id of Object.keys(MODEL_REQUIRED)) {
    const source = join(modelsRoot, id.replace(/^tts-model-/, ''))
    if (!existsSync(source)) {
      warn(`没有 ${id} 的模型目录（${source}）——这一项不会进清单`)
      continue
    }
    const name = assetNameFor(id, 'any', args.version)
    const outFile = join(args.out, name)
    if (existsSync(outFile)) rmSync(outFile)
    const packed = await packTarGz(source, outFile)
    assertRequired(packed.names, MODEL_REQUIRED[id], name)
    entries[id] = {
      version: args.version,
      assets: {
        any: {
          name,
          sha256: packed.sha256,
          bytes: packed.bytes,
          extractedBytes: packed.extractedBytes,
          fileCount: packed.fileCount,
        },
      },
    }
    console.log(
      `  packed ${name}  ${(packed.bytes / 1e6).toFixed(1)}MB → ${(packed.extractedBytes / 1e6).toFixed(1)}MB / ${packed.fileCount} 个文件  ${packed.sha256}`
    )
  }

  const previous = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : null
  const notes = previous?._comment && previous?._verify ? { _comment: previous._comment, _verify: previous._verify } : INITIAL_NOTES

  const manifest = {
    ...notes,
    schema: SCHEMA,
    component: COMPONENT_NAME,
    tag,
    reviewedAt: new Date().toISOString().slice(0, 10),
    components: entries,
  }
  validate(manifest)
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`\n[components-manifest] 资产写到 ${args.out}，清单写到 ${MANIFEST_PATH}`)
  console.log(
    `\n下一步（别跳过）：\n` +
      `  1. 把 ${args.out} 里的资产上传到 ${REPO} 的 Release「${tag}」（发布流程见 .github/workflows）\n` +
      `  2. 上传完跑 node scripts/components-manifest.mjs —— 它拿 GitHub 自己算的 digest 复核每一串指纹\n` +
      `  3. 人工看一遍 components-manifest.json 的 diff（版本号、tag、有没有多出来的组件），再提交合进 main\n` +
      `  4. 清单没合进 main 之前，应用内读不到它，按需下载这条链路对外不算做完\n`
  )
}

/** 结构校验：规则从应用侧那一份抄过来，任何一条不合规矩就整份拒绝，别按半懂的结构去装东西 */
function validate(manifest, label = '清单') {
  const problems = []
  const push = (msg) => problems.push(msg)
  if (manifest.component !== COMPONENT_NAME) push(`${label} 的 component 不是 ${COMPONENT_NAME}`)
  if (manifest.schema !== SCHEMA) push(`${label} 的 schema 是 ${JSON.stringify(manifest.schema)}，应用只认 ${SCHEMA}`)
  if (typeof manifest.tag !== 'string' || !TAG_RE.test(manifest.tag)) push(`${label} 的 tag 不合规矩（应形如 v1.0.6）`)
  const components = manifest.components
  if (!components || typeof components !== 'object') {
    push(`${label} 缺 components`)
    fail(problems.join('；'))
  }
  for (const [id, item] of Object.entries(components)) {
    if (!KNOWN_IDS.includes(id)) push(`清单里有应用不认识的组件 id：${id}`)
    if (!item || typeof item !== 'object' || typeof item.version !== 'string' || !VERSION_RE.test(item.version)) {
      push(`${id} 的版本号不合规矩（应形如 1.0.6）`)
      continue
    }
    const assets = item.assets
    if (!assets || typeof assets !== 'object' || Object.keys(assets).length === 0) {
      push(`${id} 一条资产都没有`)
      continue
    }
    for (const [key, asset] of Object.entries(assets)) {
      if (id !== ENGINE_ID && key !== 'any') push(`${id} 的资产键应是 any（模型三平台共用一份），这里是 ${key}`)
      if (id === ENGINE_ID && !ENGINE_KEYS.includes(key)) push(`${id} 的资产键 ${key} 不是已知的平台-架构`)
      if (!asset || typeof asset !== 'object') {
        push(`${id}/${key} 不是对象`)
        continue
      }
      if (typeof asset.name !== 'string' || !ASSET_RE.test(asset.name)) push(`${id}/${key} 的资产名不合法`)
      if (asset.name !== assetNameFor(id, key, item.version)) {
        warn(`注意：${id}/${key} 的资产名 ${asset.name} 不是本脚本的命名习惯（${assetNameFor(id, key, item.version)}）`)
      }
      if (typeof asset.sha256 !== 'string' || !SHA256_RE.test(asset.sha256)) {
        push(`${id}/${key} 的 sha256 不是 64 位小写十六进制`)
      }
      if (typeof asset.bytes !== 'number' || !Number.isInteger(asset.bytes) || asset.bytes <= 0) {
        push(`${id}/${key} 的 bytes 不是正整数`)
      }
      if (id !== ENGINE_ID) {
        for (const field of ['extractedBytes', 'fileCount']) {
          if (typeof asset[field] !== 'number' || !Number.isInteger(asset[field]) || asset[field] <= 0) {
            push(`${id}/${key} 的 ${field} 不是正整数——归档没有它就判不出包对不对`)
          }
        }
      }
      // 应用把资产名直接拼进 https://github.com/.../releases/download/<tag>/<name>。
      // GitHub 给出的浏览器直链会对名字做百分号编码，两边不编码同一个字符就永远 404，所以名字必须本来就不需要编码
      if (encodeURIComponent(asset.name) !== asset.name) {
        push(`${id}/${key} 的资产名需要 URL 编码（${asset.name}），永久直链会拼不出同一个地址`)
      }
    }
  }
  const absent = KNOWN_IDS.filter((id) => !components[id])
  if (absent.length > 0) {
    warn(`清单里没有这些组件（应用会把它们显示成「这个版本没有发布对应的下载包」）：${absent.join('、')}`)
  }
  if (problems.length > 0) fail(`${problems.length} 条结构问题：\n  ${problems.join('\n  ')}`)
  return manifest
}

/**
 * 取 GitHub 的 Release API。带 jobs token 的理由与 yt-dlp 那步一样：runner 出口 IP 是共享的，
 * 匿名 60 次/小时会被别的仓库用完；429/5xx 重试两次，失败把响应体截一段打出来。
 */
async function getJson(url, attempt = 1) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'vv-transcribe-components-check',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  }).catch((err) => {
    fail(`请求 ${url} 时连接失败：${err instanceof Error ? err.message : String(err)}`)
  })
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 240)
    if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
      console.warn(`[components-manifest] ${res.status} ${url} —— 第 ${attempt} 次重试`)
      await new Promise((r) => setTimeout(r, attempt * 3000))
      return getJson(url, attempt + 1)
    }
    fail(`请求失败 ${res.status} ${res.statusText}: ${url}\n  响应体: ${body || '(空)'}`)
  }
  return res.json()
}

async function check(offline, manifestPath, manifestGiven) {
  if (!existsSync(manifestPath)) {
    if (manifestGiven) fail(`指定的清单文件不存在：${manifestPath}`)
    console.log(
      '[components-manifest] 还没有 components-manifest.json：本地配音组件尚未发布，按需下载这条链路对外不算可用。'
    )
    return
  }
  const manifest = validate(JSON.parse(readFileSync(manifestPath, 'utf8')), '已提交的清单')
  const total = Object.values(manifest.components).reduce(
    (count, item) => count + Object.keys(item.assets).length,
    0
  )
  console.log(
    `[components-manifest] ${basename(manifestPath)} → tag ${manifest.tag}（核对日期 ${manifest.reviewedAt}），${Object.keys(manifest.components).length} 个组件 / ${total} 条资产`
  )
  for (const [id, item] of Object.entries(manifest.components)) {
    for (const [key, asset] of Object.entries(item.assets)) {
      const extra =
        asset.fileCount !== undefined && asset.fileCount !== null
          ? ` → ${(asset.extractedBytes / 1e6).toFixed(1)}MB / ${asset.fileCount} 个文件`
          : ''
      console.log(
        `  ${id.padEnd(36)} ${key.padEnd(13)} ${asset.name.padEnd(46)} ${(asset.bytes / 1e6).toFixed(1).padStart(7)}MB${extra}`
      )
    }
  }

  if (offline) {
    warn('--offline：跳过与 GitHub Release 资产 digest 的对账')
    return
  }

  const release = await getJson(`https://api.github.com/repos/${REPO}/releases/tags/${manifest.tag}`)
  const byName = new Map((release.assets || []).map((a) => [a.name, a]))
  if (release.draft === true) fail(`Release ${manifest.tag} 还是草稿，应用按永久直链下载会 404——先发布这个 Release`)
  let bad = 0
  for (const [id, item] of Object.entries(manifest.components)) {
    for (const [key, asset] of Object.entries(item.assets)) {
      const where = `${id}/${key}`
      const live = byName.get(asset.name)
      if (!live) {
        console.error(`  ✗ ${where}: Release ${manifest.tag} 里没有资产 ${asset.name}`)
        bad++
        continue
      }
      if (live.state !== 'uploaded') {
        console.error(`  ✗ ${where}: 资产状态是 ${live.state}（没传完），下载会 404 或拿到半份`)
        bad++
        continue
      }
      if (live.size !== asset.bytes) {
        console.error(`  ✗ ${where}: 清单 bytes ${asset.bytes} ≠ GitHub 记的 size ${live.size}`)
        bad++
        continue
      }
      // digest 是 GitHub 上传时自己算的，不依赖我们这台机器，所以它才算「独立复核」
      const digest = typeof live.digest === 'string' ? live.digest.replace(/^sha256:/, '') : null
      if (digest === null) {
        warn(`${where}: 这个 Release API 没给 digest（GitHub 只在资产传完后填），本次跳过这一条`)
        continue
      }
      if (digest !== asset.sha256) {
        console.error(`  ✗ ${where}: 清单 ${asset.sha256} ≠ GitHub digest ${digest} —— 资产被换过，或清单填错了`)
        bad++
        continue
      }
      console.log(`  ✓ ${where} 与 GitHub 的 digest 一致，${(live.size / 1e6).toFixed(1)}MB，已下载 ${live.download_count ?? 0} 次`)
    }
  }
  if (bad > 0) fail(`${bad} 条对不上。这份清单是应用内按需下载的唯一信任来源，不一致就是拒绝构建的理由`)
  console.log(`[components-manifest] ${manifest.tag} 的资产与清单全部一致（下载地址前缀 ${RELEASE_BASE}）`)
}

const args = parseArgs()
if (args.build) await build(args)
else await check(args.offline, args.manifest, args.manifestGiven)
