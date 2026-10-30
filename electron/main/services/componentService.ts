/**
 * 按需组件的下载与占用管理（#230）
 *
 * 覆盖的是本地配音那三样东西：引擎二进制（按平台-架构各一份）与两份模型（三平台共用一份）。
 * 它们都不进安装包（1.0.6 的范围决定），所以第一次用必须能在应用内取到；「要下多少、下到哪、
 * 失败了怎么办」这三件事就是本模块的职责。界面入口在设置 → 关于与更新。
 *
 * 两条来源，一个下载器（#237 拍板「引擎发在自己 Release、模型不替第三方权重做二次分发」之后分成这样）：
 * - 引擎二进制是我们自己的产物 → 由清单（components-manifest.json）指版本与指纹，资产在我们仓库的 Release 上；
 * - 模型是第三方训练出来的 → 不进清单，钉在上游提交号上，逐文件从上游客仓取（表在 ttsModelUpstream.ts，
 *   为什么模型不转发到我们 Release 那份理由写在那份文件头上）。
 * 「清单坏了」和「上游飘了」是两种故障，闸门不同，别指望一条链路替另一条把关。
 *
 * 走清单那一条的信任模型照 ytDlpUpdate（自家清单），四条收紧点写在这儿而不是抄一遍：
 * 1. 清单里没有 URL。下载地址 = 代码内写死的 Release 前缀 + 清单里的 tag 与资产名，两者都过正则；
 * 2. 清单里没有路径。落点由下面的 SPECS 决定，清单只能改版本/资产名/指纹，改不了写到哪；
 * 3. 先比 SHA2-256 再落地：验不过就整份删掉临时件，组件目录里绝不留半个组件；
 * 4. 归档解出来还要点名：SPECS.required 里的条目必须都在，文件数与解压后体积必须与清单声明一致。
 *    少了这一步，「多包了一层外壳目录」或 macOS 元数据混进来的包（实测 17 个文件变 37 个）
 *    会装完再让引擎报缺文件，那时已经分不清是下载坏了还是引擎坏了。
 * 上游那一条比这四条更硬也更简单：路径与指纹都在代码里，网络回来的任何东西都没有过「写到哪」的权力；
 * 每个文件各自比一次 SHA2-256，全部点齐才把整个目录改名落地——没有「解出来的结构对不对」这个问题，
 * 因为根本不存在解包。
 *
 * 剩下的边界与 yt-dlp 那条一样：能写本仓库的人可以同时换掉清单和 Release 资产（同源自证，#182 记着）。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { net } from 'electron'
import { logger } from './logger'
import { atomicWriteJson, componentsDir } from './userDataStore'
import { ArchiveError, extractTarGz } from './componentArchive'
import {
  COMPONENT_ROW_TITLES,
  LOCAL_TTS_ENGINES,
  isLocalTtsEngineRunning,
  modelRootDir,
} from './localTtsEngine'
import { hasActiveTTSSynthesis } from './ttsService'
import {
  UPSTREAM_MODEL_SOURCES,
  upstreamFileUrl,
  upstreamTableDigest,
  upstreamTotalBytes,
  upstreamVersion,
  type UpstreamModelSource,
} from './ttsModelUpstream'

const TAG = 'Components'

/**
 * 清单的两个读法，顺序与 yt-dlp 那条一致，理由也一致：
 * raw.githubusercontent 无需鉴权、没有速率限制但国内直连很慢；api.github.com 的 contents 接口
 * 带 Accept: raw 直接回正文，本机实测 0.77 秒，未鉴权 60 次/小时对个人点几下够用。
 */
const MANIFEST_URLS = [
  'https://raw.githubusercontent.com/DaQI-X/Vv-Transcribe/main/components-manifest.json',
  'https://api.github.com/repos/DaQI-X/Vv-Transcribe/contents/components-manifest.json?ref=main',
]

/** 我们自己仓库的 Release 资产前缀，写死。清单改不了它 */
const RELEASE_BASE = 'https://github.com/DaQI-X/Vv-Transcribe/releases/download'

/** 清单格式版本：对不上就停，别按半懂的结构去装东西 */
const MANIFEST_SCHEMA = 1
/** Release 标签：形如 vX.Y.Z（带不带 v 都收）。资产名与 tag 都要拼进 URL，所以字符集收得很死 */
const TAG_RE = /^v?\d+\.\d+\.\d+(?:[-.][\w.]+)?$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-.][\w.]+)?$/
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SHA256_RE = /^[0-9a-f]{64}$/
/** 清单里的 component 必须是我们自己那份，防止把别家的同类文件指过来 */
const MANIFEST_COMPONENT = 'vv-components'

/** 连续多久收不到一个字节就判定这条连接死了。比「总时限」有用：慢但不死就该让他继续等 */
const IDLE_TIMEOUT_MS = 60_000
/** 硬上限。Kokoro 那份按 30KB/s 的极端速度算也要一个多小时，取 45 分钟并把取消做在界面上 */
const HARD_TIMEOUT_MS = 45 * 60_000
/** 进度节流：200ms 一次。37MB 分块回来有几百个回调，每个都推等于给 IPC 刷屏 */
const PROGRESS_INTERVAL_MS = 200

const NETWORK_HINT = '连不上组件清单（多为国内直连 GitHub 过慢或被拦所致），可开启网络加速后重试'

/**
 * 404 不该套进 NETWORK_HINT：那是「连不上」，而 404 是服务器把话答清楚了——这一版没有这份清单。
 * 挂加速再试还是 404，所以这一位还会让引擎那行收起下载按钮（见 manifestAbsent）。
 */
const MANIFEST_ABSENT_HINT = '这一版还没有发布组件清单（404），本版没有对应的下载包'

/** binary＝落点是一个文件；archive＝落点是一个目录（解包来的，或逐文件取来的，见下面 upstream） */
export type ComponentKind = 'binary' | 'archive'

/** 一个组件在代码侧的全部真相：从哪儿取、落到哪、必需文件、体积上限、什么时候算「正在用」 */
interface ComponentSpec {
  id: string
  title: string
  kind: ComponentKind
  /** 界面括号里那句「要下多少」的账。数字取 2026-10-28 本机实测，跨平台不同的那份不编数 */
  hint: string
  /** 取清单 assets 里哪一条。与 upstream 二选一，两个都没有＝这一版本不给应用内下载 */
  manifestKey?: () => string
  /** 从上游客仓逐文件取（模型）。给了它就不读清单：版本、指纹、体积全在这份代码里 */
  upstream?: UpstreamModelSource
  /** 落点。binary 是文件，archive 是目录 */
  target: () => string
  /** 目录型组件专用：装完必须都在的条目。名字以 / 结尾表示只要「下面有东西」 */
  required?: string[]
  /** 清单那条路专用：解包体积与文件数的代码侧上限，兜住清单把数字写错的情况。上游逐文件取用不到 */
  maxExtractBytes?: number
  maxFiles?: number
  /** 正在被占用就给出那句人话。Windows 上运行中的 exe 改名会直接失败，模型目录被 sidecar 开着删一半会让下一次配音报一串看不懂的文件错误 */
  busy?: () => string | null
}

/**
 * 占用的两种原因要分开说：「一批正在逐段合成」等一等就好，「引擎进程还活着」得有按钮可停。
 * 引擎配音完不会自己退（下一次配音才懒启动），所以只有前一种闸门的话，用户在同一会话里
 * 就永远动不了这几个文件——那不是谨慎，是死路。
 */
function busyReason(): string | null {
  if (hasActiveTTSSynthesis()) return '有一批配音正在逐段合成，等它跑完（或先取消这一批）再动组件'
  if (isLocalTtsEngineRunning()) return '本地配音引擎还在后台运行，先点「停止本地配音引擎」再动组件'
  return null
}

/** 引擎二进制文件名：Windows 的 PyInstaller 产物带 .exe，其余两平台不带 */
function engineBinaryName(): string {
  return process.platform === 'win32' ? 'vv-tts-server.exe' : 'vv-tts-server'
}

/** 引擎按平台-架构取；模型三平台共用一份，清单里就一条 any */
const PLATFORM_KEY = () => `${process.platform}-${process.arch}`

/**
 * 模型的必需文件表，必须与 python-tts/main.py 的 ENGINES 一字不差。
 * 那边写的是「少一个 .fst 不会报错，只会让『2026 年』这类读法悄悄退化成逐字念」——
 * 那种降级比失败更难发现，所以这里当场拦住，而不是留给引擎自己发现。
 */
const MODEL_REQUIRED: Record<(typeof LOCAL_TTS_ENGINES)[number], string[]> = {
  'sherpa-onnx-vits-zh-ll': [
    'model.onnx',
    'tokens.txt',
    'lexicon.txt',
    'dict/',
    'date.fst',
    'number.fst',
    'phone.fst',
    'new_heteronym.fst',
  ],
  'kokoro-multi-lang-v1_1': [
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

/**
 * 三个组件，两种来源：引擎那条要读清单才知道版本，两份模型条的版本与指纹是 ttsModelUpstream.ts 里
 * 钉死的那个提交（VITS 17 个文件 / 135,454,939 字节，Kokoro 375 个文件 / 426,573,262 字节，
 * 都是 2026-10-28~29 本机逐文件算出来的）——所以「未安装，下载约 135.5MB」这句在没点「检查清单」时
 * 也答得出来，不拿 0 或「不知道」冒充已知。
 * hint 里一律不重复体积：那一格由表算，写死了就会出现「129MB」与「135.5MB」并排（同一份东西、
 * 一个按 1024 进位一个按 1000 进位），用户只会当成两个不同的包。
 * maxExtractBytes / maxFiles 这两位目前没人设：它们属于「清单指一个归档」那条路（还留在 doInstall 里，
 * 供以后再有归档组件时用），逐文件取上游这条路按指纹对，不看这两个上限。
 */
const SPECS: ComponentSpec[] = [
  {
    id: 'vv-tts-server',
    title: COMPONENT_ROW_TITLES.engineBinary,
    kind: 'binary',
    hint: '引擎二进制，三平台各一份，体积按平台差异较大',
    manifestKey: PLATFORM_KEY,
    target: () => join(componentsDir(), 'vv-tts-server', PLATFORM_KEY(), engineBinaryName()),
    busy: busyReason,
  },
  {
    id: `tts-model-${LOCAL_TTS_ENGINES[0]}`,
    title: COMPONENT_ROW_TITLES.models[LOCAL_TTS_ENGINES[0]].row,
    kind: 'archive',
    hint: '中文配音模型，取自 HuggingFace 上游仓库里钉死的那个提交',
    upstream: UPSTREAM_MODEL_SOURCES[LOCAL_TTS_ENGINES[0]],
    target: () => join(modelRootDir(), LOCAL_TTS_ENGINES[0]),
    required: MODEL_REQUIRED[LOCAL_TTS_ENGINES[0]],
    busy: busyReason,
  },
  {
    id: `tts-model-${LOCAL_TTS_ENGINES[1]}`,
    title: COMPONENT_ROW_TITLES.models[LOCAL_TTS_ENGINES[1]].row,
    kind: 'archive',
    hint: '中英文配音模型，取自 HuggingFace 上游仓库里钉死的那个提交',
    // 与 VITS 同一套路：钉 commit + 逐文件 sha256，不碰清单。这份表 375 个文件、426,573,262 字节
    // （2026-10-29 本机逐个算的，其中 7 个 LFS 还实下过一遍），espeak-ng-data/ 那几百个文件全在里面。
    // 手工放的那份也认：落点与 sidecar 用的是同一个 modelRootDir()/<引擎 id>。
    upstream: UPSTREAM_MODEL_SOURCES[LOCAL_TTS_ENGINES[1]],
    target: () => join(modelRootDir(), LOCAL_TTS_ENGINES[1]),
    required: MODEL_REQUIRED[LOCAL_TTS_ENGINES[1]],
    busy: busyReason,
  },
]

const SPEC_BY_ID = new Map(SPECS.map((spec) => [spec.id, spec]))

/** 清单里本机/本组件该取的那一条 */
interface AssetEntry {
  version: string
  tag: string
  asset: string
  sha256: string
  bytes: number
  /** archive 专用：清单声明的解压后体积与文件数。对不上就判包不对 */
  extractedBytes: number | null
  fileCount: number | null
}

export interface ComponentState {
  id: string
  title: string
  kind: ComponentKind
  hint: string
  installed: boolean
  /** 磁盘实际占用（目录已展开求和），没装是 0 */
  bytes: number
  /** installed.json 记的版本。手工放进组件目录的那份没有记录，为 null */
  localVersion: string | null
  remoteVersion: string | null
  /** 清单声明的下载体积（压缩包本身）；还没查清单时为 null */
  remoteBytes: number | null
  /** install=没装，update=版本不同，repair=装了但没版本记录，none=与清单一致 */
  action: 'install' | 'update' | 'repair' | 'none'
  /** 清单有没有本机这一条（没检查过清单时为 null） */
  inManifest: boolean | null
}

export type ComponentPhase = 'download' | 'extract' | 'verify'

export interface ComponentProgress {
  id: string
  phase: ComponentPhase
  done: number
  /** 这一阶段的分母；未知时为 0，界面按「不显示百分比」处理，不给假百分比 */
  total: number
}

export interface ComponentResult {
  ok: boolean
  error: string | null
  state?: ComponentState
  /** 失败特征像「系统拦住了写入/执行」，界面据此给「打开隐私设置」按钮 */
  systemSettingsHint?: boolean
}

export interface ComponentCheckResult {
  ok: boolean
  error: string | null
  components: ComponentState[]
}

interface InstalledRecord {
  version: string
  sha256: string
  /** 落到磁盘上的那份的体积：binary 是文件本身，archive 是解压后总和 */
  bytes: number
  installedAt: string
}

interface Task {
  controller: AbortController
  /** 中止原因。abort() 本身不带信息，不分清「用户取消 / 断流 / 超时」就没法说人话 */
  reason: '' | 'cancelled' | 'idle' | 'timeout'
  watchers: Array<(p: ComponentProgress) => void>
}

const inflight = new Map<string, { task: Task; run: Promise<ComponentResult> }>()

/**
 * 清单读到了、但没有本机这一条（平台或架构不在发布范围里）。
 * 单独一类，是为了让界面能分清「清单里没有我这一台」和「还没查过清单」——
 * 前者该把下载按钮按下去并说明原因，后者该提示用户点「检查清单」。
 */
class MissingAssetError extends Error {}

/**
 * 本轮会话内最近一次读到的清单原文。存在它的理由只有一个：让不联网的 listComponents
 * 也能把「清单上是几版、还要多大」继续报给界面——下载或删完之后刷新一次，
 * 那两位不该被洗成「还没查过」。它不代替点「检查清单」：那份缓存不能反映远端刚发布的新版。
 */
let lastManifest: unknown | null = null

/**
 * 两个入口都答 404 时记下「这一版没有清单这份文件」。它和 lastManifest 仍是两位：
 * 后者说「查到了什么」，这一位说「查过、服务器答的是没有」。靠清单找包的只有引擎那一条，
 * 钉了 HF 指纹的两份模型不读清单，所以这一位牵连不到它们——VITS 在清单 404 的那一版照样下得动。
 */
let manifestAbsent = false

function installedFile(): string {
  return join(componentsDir(), 'installed.json')
}

/**
 * 「装的哪一版」的唯一记录。刻意不按 <id>/<version>/ 分代：引擎与模型的落点是
 * localTtsEngine 已经验过的那两个扁平路径，分代要连着改两条已验链路，收益不抵风险。
 * 于是磁盘在场与版本记录是两件事——在场按真实文件判，记录只用来回答「这是几版」。
 */
async function readInstalled(): Promise<Record<string, InstalledRecord>> {
  try {
    const text = await readTextIf(installedFile())
    if (text === null) return {}
    const parsed = JSON.parse(text) as { components?: Record<string, InstalledRecord> }
    return parsed.components && typeof parsed.components === 'object' ? parsed.components : {}
  } catch (err) {
    logger.warn(TAG, 'installed.json unreadable', { message: String(err) })
    return {}
  }
}

/** 写「装的哪一版」：走 userDataStore 的原子写，应用被杀时不会留下半份 JSON 把版本记录整个丢掉 */
async function writeInstalled(map: Record<string, InstalledRecord>): Promise<void> {
  await atomicWriteJson(installedFile(), { schema: MANIFEST_SCHEMA, components: map })
}

/** 读一份可能不存在的文本文件；读不到就是 null，不抛 */
async function readTextIf(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/** 目录实际占用。不跟随符号链接：我们解包时本来就不接受链接，出现链接说明这目录被人动过 */
async function diskBytes(target: string): Promise<number> {
  let info
  try {
    info = await stat(target)
  } catch {
    return 0
  }
  if (!info.isDirectory()) return info.size
  let total = 0
  const stack = [target]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let items
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of items) {
      const full = join(dir, item.name)
      if (item.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!item.isFile()) continue
      try {
        total += (await stat(full)).size
      } catch {
        // 正在被删的文件算不进去，不影响「这目录大概多大」
      }
    }
  }
  return total
}

function specOf(id: string): ComponentSpec {
  const spec = SPEC_BY_ID.get(id)
  if (!spec) throw new Error(`未知组件：${JSON.stringify(id)}`)
  return spec
}

/** 自测口子（同 VV_YTDLP_MANIFEST_URL 的思路）：指到本机静态服务就能在不推送的前提下跑完整链路 */
function manifestUrls(): string[] {
  const override = process.env.VV_COMPONENTS_MANIFEST_URL
  return override ? [override] : MANIFEST_URLS
}

/**
 * 资产前缀可以覆盖，但它只在清单也被覆盖时才有意义：落地前要比 SHA2-256，
 * 换前缀换不出「清单没点过的文件」，所以这个口子撑不开「把用户机器上的组件换成攻击者的文件」。
 * 两个都覆盖才能真正喂一份本地假归档，而这要求清单先为那份文件签一个真指纹。
 */
function releaseBase(): string {
  const override = process.env.VV_COMPONENTS_RELEASE_BASE
  return override && process.env.VV_COMPONENTS_MANIFEST_URL ? override : RELEASE_BASE
}

/**
 * 上游那条来源翻译成一个 AssetEntry。之所以翻译而不是另写一套：界面那栏、installed.json、
 * buildState 的「装的是哪一版」只认一种结构，多一条来源就多维护一份状态机，收益是零。
 * 这里 version 与 tag 都放提交号前 7 位：模型没有「我们发了几版」这件事，能说的只有「钉的是哪个提交」。
 * extractedBytes / fileCount 等于下载体积与文件数——没有归档这一层，取到的就是最终形态。
 */
function upstreamEntry(source: UpstreamModelSource): AssetEntry {
  const bytes = upstreamTotalBytes(source)
  const version = upstreamVersion(source)
  return {
    version,
    tag: version,
    asset: `${source.repo}@${version}`,
    sha256: upstreamTableDigest(source),
    bytes,
    extractedBytes: bytes,
    fileCount: source.files.length,
  }
}

/** 这个组件的「远端」由谁说了算：代码里钉的上游表 > 清单 > 两者都没有＝本版不可下载 */
function entryFrom(raw: unknown, spec: ComponentSpec): AssetEntry {
  if (spec.upstream) return upstreamEntry(spec.upstream)
  const manifestKey = spec.manifestKey
  if (!manifestKey) {
    throw new MissingAssetError(`${spec.title} 本版没有钉下载指纹，不能在应用内下载`)
  }
  return pickEntry(raw, spec, manifestKey())
}

/** 网络回来的 JSON 一律当外部输入对待：逐字段验，任何一条不合规矩就整份拒绝 */
function pickEntry(raw: unknown, spec: ComponentSpec, key: string): AssetEntry {
  if (raw === null || typeof raw !== 'object') throw new Error('组件清单不是一个对象')
  const manifest = raw as Record<string, unknown>
  if (manifest.component !== MANIFEST_COMPONENT) {
    throw new Error(`组件清单的 component 不是 ${MANIFEST_COMPONENT}`)
  }
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw new Error(
      `组件清单的格式版本为 ${JSON.stringify(manifest.schema)}，本应用只认 ${MANIFEST_SCHEMA}，请升级应用`
    )
  }
  if (typeof manifest.tag !== 'string' || !TAG_RE.test(manifest.tag)) {
    throw new Error('组件清单里的发布标签不合规矩（应形如 vX.Y.Z）')
  }
  const components = manifest.components
  if (components === null || typeof components !== 'object') throw new Error('组件清单缺少 components')
  const component = (components as Record<string, unknown>)[spec.id]
  // 「这一版没发布这个组件」和「清单坏了」要分开：清单只发引擎、模型留到下版是正常状态，
  // 按普通错误处理会让每次检查都挂一条没人能修的红色文案，而按下按钮说明「这项暂时不可下载」才是对的
  if (component === null || component === undefined) {
    throw new MissingAssetError(`组件清单里没有 ${spec.id} 这一项，这个版本没有发布该组件`)
  }
  if (component === null || typeof component !== 'object') {
    throw new Error(`组件清单里 ${spec.id} 那一项不是一个对象`)
  }
  const item = component as Record<string, unknown>
  if (typeof item.version !== 'string' || !VERSION_RE.test(item.version)) {
    throw new Error(`组件清单里 ${spec.id} 的版本号不合规矩（应形如 X.Y.Z，三段数字）`)
  }
  const assets = item.assets
  if (assets === null || typeof assets !== 'object') throw new Error(`组件清单里 ${spec.id} 缺少 assets`)
  const asset = (assets as Record<string, unknown>)[key]
  if (asset === null || asset === undefined) {
    throw new MissingAssetError(`组件清单没有 ${spec.id} 的 ${key} 这一条，这个平台没有对应组件`)
  }
  if (asset === null || typeof asset !== 'object') throw new Error(`组件清单里 ${spec.id}/${key} 不是对象`)
  const { name, sha256, bytes, extractedBytes, fileCount } = asset as Record<string, unknown>
  if (typeof name !== 'string' || !ASSET_RE.test(name)) {
    throw new Error(`组件清单里 ${spec.id}/${key} 的资产名不合法`)
  }
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
    throw new Error(`组件清单里 ${spec.id}/${key} 的 sha256 不是 64 位小写十六进制`)
  }
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0) {
    throw new Error(`组件清单里 ${spec.id}/${key} 的体积不是正整数`)
  }
  // 这两项是「可选但给了就得是对的」：引擎二进制不需要声明解压后体积，模型必须声明
  const optionalPositive = (value: unknown, field: string): number | null => {
    if (value === undefined || value === null) return null
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`组件清单里 ${spec.id}/${key} 的 ${field} 不是正整数`)
    }
    return value
  }
  const extracted = optionalPositive(extractedBytes, 'extractedBytes')
  const count = optionalPositive(fileCount, 'fileCount')
  if (spec.kind === 'archive' && (extracted === null || count === null)) {
    throw new Error(
      `组件清单里 ${spec.id}/${key} 缺少 extractedBytes/fileCount——归档组件没有这两项就没法判断包对不对`
    )
  }
  return { version: item.version, tag: manifest.tag, asset: name, sha256, bytes, extractedBytes: extracted, fileCount: count }
}

/** 走 net.fetch 而不是全局 fetch：Chromium 网络栈会跟随系统代理/PAC，Node 全局 fetch 只认环境变量 */
const netFetch = (url: string, init: Parameters<typeof net.fetch>[1]) => net.fetch(url, init)

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await netFetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'vv-transcribe' },
    })
    if (!res.ok) throw new Error(`组件清单服务器返回 ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 「网络问题」才配那句加速建议；404 是服务器答清楚了「这份清单不在」，挂加速照样 404 */
const NETWORK_ERROR_RE =
  /net::ERR_|abort|Failed to fetch|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i

/**
 * 读整份清单。三个组件读的是同一个文件，所以「检查更新」只发一次 HTTP——raw 那个入口
 * 本机实测首字节要 20 秒，串行发三次等于把这一栏钉死一分多钟。
 * 两个入口都试：换域名只对「读不到」有意义，结构不合规矩是清单本身的问题，再读一遍还是同一份。
 */
async function fetchManifest(): Promise<unknown> {
  const failures: string[] = []
  for (const url of manifestUrls()) {
    try {
      const raw = await fetchJson(url)
      lastManifest = raw
      manifestAbsent = false
      return raw
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push(message)
      logger.warn(TAG, 'manifest fetch failed', { url, message })
      if (!/返回\s*(4\d{2}|5\d{2})/.test(message) && !NETWORK_ERROR_RE.test(message)) break
    }
  }
  const allNetwork = failures.every((message) => NETWORK_ERROR_RE.test(message))
  // 404 单独一支：重试不会让它变成 200，而界面需要一个能收起下载按钮的凭据（见 manifestAbsent）
  manifestAbsent = failures.length > 0 && failures.every((message) => /返回\s*404/.test(message))
  if (manifestAbsent) throw new Error(MANIFEST_ABSENT_HINT)
  const detail = failures.length === 1 ? failures[0] : `两个入口分别：${failures.join(' / ')}`
  if (failures.length === 1 && !allNetwork) throw new Error(detail)
  throw new Error(`${allNetwork ? NETWORK_HINT : '组件清单读取失败'}（${detail}）`)
}

/**
 * 取这个组件的「远端」。钉了上游的模型不发 HTTP——指纹就在代码里，
 * 让它去读一份跟自己无关的清单，等于把「GitHub 连不上」算成「我的模型下不了」。
 * 清单里本机这一条可能没有：按组件取，取不到就是这一个组件的事，不牵连另外两个。
 */
async function entryFor(spec: ComponentSpec): Promise<AssetEntry> {
  if (spec.upstream) return upstreamEntry(spec.upstream)
  return entryFrom(await fetchManifest(), spec)
}

/**
 * 从会话缓存里取本机这条，给不联网的那份状态用。
 * 五种结果要分清楚：代码里钉了上游 → 不依赖清单，直接报版本与体积；
 * 本版压根没有来源（false）→ 按钮按下并说清「本版没有钉下载指纹」；
 * 两个入口都答 404（false）→ 这一版没有清单这份文件，收起按钮，别再留一条点了必报 404 的路；
 * 没缓存（null）→ 界面提示去点「检查清单」；
 * 缓存里没这台机器的条目（false）→ 按钮按下并说明这个平台没有对应组件；
 * 其余结构不合规矩的清单（我们本来就在 checkComponents 里报过一次）在这里按 null 处理，
 * 不在每一次刷新里重复弹同一句。
 */
function cachedRemote(spec: ComponentSpec): { entry: AssetEntry | null; inManifest: boolean | null } {
  if (spec.upstream) return { entry: upstreamEntry(spec.upstream), inManifest: true }
  if (!spec.manifestKey) return { entry: null, inManifest: false }
  if (manifestAbsent) return { entry: null, inManifest: false }
  if (lastManifest === null) return { entry: null, inManifest: null }
  try {
    return { entry: entryFrom(lastManifest, spec), inManifest: true }
  } catch (err) {
    if (err instanceof MissingAssetError) return { entry: null, inManifest: false }
    return { entry: null, inManifest: null }
  }
}

/** 装完之后统一由这一个函数算状态，界面与安装结果里看到的口径不会分叉 */
async function buildState(
  spec: ComponentSpec,
  remote: AssetEntry | null,
  /** 清单读到了但本机这条没有 / 本版压根没有来源 / 清单两个入口都 404 → false；null＝还没读过清单 */
  inManifest?: boolean | null
): Promise<ComponentState> {
  const target = spec.target()
  const installed = existsSync(target)
  const record = installed ? (await readInstalled())[spec.id] : undefined
  const bytes = installed ? await diskBytes(target) : 0
  const localVersion = installed ? (record?.version ?? null) : null
  let action: ComponentState['action'] = 'install'
  if (installed) {
    if (remote === null) action = 'repair'
    else if (localVersion === null) action = 'repair'
    else action = localVersion === remote.version ? 'none' : 'update'
  }
  return {
    id: spec.id,
    title: spec.title,
    kind: spec.kind,
    hint: spec.hint,
    installed,
    bytes,
    localVersion,
    remoteVersion: remote?.version ?? null,
    remoteBytes: remote?.bytes ?? null,
    action,
    inManifest: inManifest ?? (remote === null ? null : true),
  }
}

/** 不联网的那一份：设置面板打开时用它，清单要用户点「检查」才读 */
export async function listComponents(): Promise<ComponentState[]> {
  const out: ComponentState[] = []
  for (const spec of SPECS) {
    const cached = cachedRemote(spec)
    out.push(await buildState(spec, cached.entry, cached.inManifest))
  }
  return out
}

/**
 * 引擎二进制这一条在本版清单里到底有没有（只读会话缓存，不联网）。
 * 独立开这一个口子，是因为「去按需组件下载引擎」这句话在好几处要说，而按需组件那一行
 * 有没有下载按钮恰好由同一位决定：404 的那一版按钮是收着的，把人领过去等于让他对着
 * 一行点不动的按钮自己发现。三份状态接口里只有本地配音那份是配音页/设置页必读的，
 * 所以这一位搭在那份上，不再让渲染层自己猜。
 * null＝这一轮还没读过清单，此时既不能说「下得到」，也不能说「下不到」。
 */
export function engineBinaryInManifest(): boolean | null {
  const spec = SPEC_BY_ID.get('vv-tts-server')
  return spec ? cachedRemote(spec).inManifest : null
}

/**
 * 逐个组件与清单对账，只发一次 HTTP。
 * 清单里缺某个组件的本机条目时，只有那一个显示「清单没有对应包」，另外两个照常报版本。
 */
export async function checkComponents(): Promise<ComponentCheckResult> {
  let raw: unknown
  try {
    raw = await fetchManifest()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(TAG, 'manifest check failed', message)
    return { ok: false, error: message, components: await listComponents() }
  }

  const components: ComponentState[] = []
  const problems: string[] = []
  for (const spec of SPECS) {
    try {
      components.push(await buildState(spec, entryFrom(raw, spec)))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 「清单里没有本机这一条」不算检查失败：另外两个组件的版本照常报，
      // 只是这一项标成不可下载，界面那句「这个平台没有对应组件」由它决定
      if (err instanceof MissingAssetError) {
        components.push(await buildState(spec, null, false))
        logger.warn(TAG, 'component asset missing for this platform', { id: spec.id, message })
        continue
      }
      if (!problems.includes(message)) problems.push(message)
      components.push(await buildState(spec, null))
      logger.warn(TAG, 'component not available', { id: spec.id, message })
    }
  }
  return { ok: problems.length === 0, error: problems.length === 0 ? null : problems.join('；'), components }
}

/** 下载进度回调扇出：多窗口同时盯着同一个组件时，两个都要收到 */
function emit(inFlight: Task, p: ComponentProgress): void {
  for (const watch of [...inFlight.watchers]) {
    try {
      watch(p)
    } catch {
      // 那个窗口已经关了
    }
  }
}

/**
 * 边下边算 SHA2-256。返回收到的字节数；指纹不符或字节数不对直接抛，由调用方删掉临时件。
 * `progress` 只给逐文件取上游那条路用：一条进度条要跨 17 个文件连起来走，
 * 每个文件都拿自己的字节数当分母，界面上就是一根从 0 反复弹回去的假条。
 */
async function downloadToPart(
  url: string,
  partFile: string,
  entry: AssetEntry,
  inFlight: Task,
  spec: ComponentSpec,
  progress?: { base: number; total: number }
): Promise<number> {
  const doneOf = (received: number) => (progress ? progress.base + received : received)
  const totalOf = () => (progress ? progress.total : entry.bytes)
  await mkdir(dirname(partFile), { recursive: true })
  await rm(partFile, { force: true })

  let lastReport = 0
  let lastTouch = Date.now()
  let received = 0
  const hash = createHash('sha256')
  const idleTimer = setInterval(() => {
    if (Date.now() - lastTouch > IDLE_TIMEOUT_MS) {
      inFlight.reason = 'idle'
      inFlight.controller.abort()
    }
  }, 5_000)
  const hardTimer = setTimeout(() => {
    inFlight.reason = 'timeout'
    inFlight.controller.abort()
  }, HARD_TIMEOUT_MS)

  try {
    const res = await netFetch(url, {
      redirect: 'follow',
      signal: inFlight.controller.signal,
      headers: { 'User-Agent': 'vv-transcribe' },
    })
    if (!res.ok) {
      // 这句话两条来源都要能用，所以不写「发布」：清单那条 entry.tag 是 vX.Y.Z 这种发布号，上游那条是提交号前 7 位
      throw new Error(`下载失败 ${res.status}（${entry.asset} 在 ${entry.tag} 这一版里取不到？）`)
    }
    if (!res.body) throw new Error('下载响应没有内容')

    const handle = await open(partFile, 'w')
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        hash.update(chunk)
        received += chunk.length
        lastTouch = Date.now()
        await handle.write(chunk)
        const now = Date.now()
        if (now - lastReport > PROGRESS_INTERVAL_MS) {
          lastReport = now
          emit(inFlight, { id: spec.id, phase: 'download', done: doneOf(received), total: totalOf() })
        }
      }
    } finally {
      await handle.close()
    }
    emit(inFlight, { id: spec.id, phase: 'download', done: doneOf(received), total: totalOf() })
  } catch (err) {
    if (inFlight.reason === 'cancelled') throw new Error('已取消下载')
    if (inFlight.reason === 'idle') {
      throw new Error(
        `下载断流：连续 ${IDLE_TIMEOUT_MS / 1000} 秒没有新字节进来（已收到 ${(received / 1e6).toFixed(1)}MB / 约 ${(entry.bytes / 1e6).toFixed(0)}MB）。可开启网络加速后重试`
      )
    }
    if (inFlight.reason === 'timeout') {
      throw new Error(
        `下载超时：约 ${(entry.bytes / 1e6).toFixed(0)}MB 在 ${HARD_TIMEOUT_MS / 60_000} 分钟内没下完（收到 ${(received / 1e6).toFixed(1)}MB）。可开启网络加速后重试`
      )
    }
    // net.fetch 失败抛的是 net::ERR_* 这类错误码，原样冒到界面上没人看得懂，包一句
    const message = err instanceof Error ? err.message : String(err)
    if (NETWORK_ERROR_RE.test(message)) throw new Error(`${NETWORK_HINT}（${message}）`)
    throw err
  } finally {
    clearInterval(idleTimer)
    clearTimeout(hardTimer)
  }

  if (received !== entry.bytes) {
    throw new Error(`下载不完整（${entry.asset}：收到 ${received} / 应有 ${entry.bytes} 字节）`)
  }
  const digest = hash.digest('hex')
  if (digest !== entry.sha256) {
    logger.error(TAG, 'fingerprint mismatch', { id: spec.id, expected: entry.sha256, actual: digest })
    throw new Error(
      `校验不通过：下载到的 ${entry.asset} 指纹和钉死的那份对不上（${digest.slice(0, 12)}… ≠ ${entry.sha256.slice(0, 12)}…），已放弃`
    )
  }
  return received
}

/**
 * 换到位：已有的挪去 .prev，新的改名进来，任何一步出问题都把 .prev 换回去。
 * 「先落 .part、验过指纹再动现有文件」是 ytDlpUpdate 已验过的做法，这里沿用同一形状。
 */
async function promote(newPath: string, target: string): Promise<void> {
  const prevFile = `${target}.prev`
  const hadPrevious = existsSync(target)
  if (hadPrevious) await rename(target, prevFile)
  try {
    await rename(newPath, target)
  } catch (err) {
    if (hadPrevious) await rename(prevFile, target).catch(() => {})
    throw err
  }
  if (hadPrevious) await rm(prevFile, { recursive: true, force: true }).catch(() => {})
}

async function doInstall(
  id: string,
  spec: ComponentSpec,
  inFlight: Task,
  onProgress?: (p: ComponentProgress) => void
): Promise<ComponentResult> {
  if (onProgress) inFlight.watchers.push(onProgress)

  const busy = spec.busy?.()
  if (busy) return { ok: false, error: busy }

  let entry: AssetEntry
  try {
    entry = await entryFor(spec)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const target = spec.target()
  // 临时件一律放组件目录之内：跨卷 rename 是 EXDEV，放同一棵树下改名必成
  const staging = join(componentsDir(), '.staging', `${spec.id}@${entry.version}`)
  const from = spec.upstream
    ? `${spec.upstream.repo}@${spec.upstream.commit.slice(0, 7)}`
    : `${releaseBase()}/${entry.tag}/${entry.asset}`
  logger.info(TAG, 'install start', { id, from, sha256: entry.sha256, bytes: entry.bytes })

  try {
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    // 落点的父目录要在动手前建好：promote 用的是 rename，父目录不存在时它报 ENOENT，
    // 而这一刻整份归档已经下载并解压完成了——空有 135MB 成品却装不上（干净机器上 tts-models/ 本来就不存在）
    await mkdir(dirname(target), { recursive: true })

    if (spec.kind === 'binary') {
      const url = `${releaseBase()}/${entry.tag}/${entry.asset}`
      const partFile = join(staging, entry.asset)
      await downloadToPart(url, partFile, entry, inFlight, spec)
      if (process.platform !== 'win32') await chmod(partFile, 0o755)
      await promote(partFile, target)
      await recordInstalled(spec, entry, (await stat(target)).size)
      logger.info(TAG, 'install done', { id, version: entry.version, target })
      return { ok: true, error: null, state: await buildState(spec, entry) }
    }

    if (spec.upstream) {
      const source = spec.upstream
      const filesDir = join(staging, 'files')
      let downloaded = 0
      for (const file of source.files) {
        // 指纹表是代码不是网络输入，但它会在未来某次编辑里写错：拼路径前先卡住「绝对路径 / 往上跳」，
        // 否则一个笔误就能把下载写到组件目录之外去
        if (file.path.startsWith('/') || file.path.includes('..')) {
          throw new Error(`指纹表里的路径不合规矩：${file.path}`)
        }
        await downloadToPart(
          upstreamFileUrl(source, file),
          join(filesDir, file.path),
          {
            version: entry.version,
            tag: entry.tag,
            asset: file.path,
            sha256: file.sha256,
            bytes: file.bytes,
            extractedBytes: null,
            fileCount: null,
          },
          inFlight,
          spec,
          { base: downloaded, total: entry.bytes }
        )
        // 只按表里的字节数累加：downloadToPart 已经逐字节验过收到量等于这个数，
        // 这里再读一次磁盘属于重复劳动，而进度条要的是「整批的分母别跳」
        downloaded += file.bytes
      }

      emit(inFlight, { id: spec.id, phase: 'verify', done: 0, total: 1 })
      const missing = (spec.required ?? []).filter((required) => {
        const bare = required.replace(/\/+$/, '')
        return !source.files.some((file) => file.path === bare || file.path.startsWith(`${bare}/`))
      })
      if (missing.length > 0) {
        throw new Error(
          `指纹表点不齐引擎要的文件：缺 ${missing.join('、')}。表与必需清单脱节了（那份必须与 python-tts/main.py 的 ENGINES 一致），已放弃`
        )
      }
      await promote(filesDir, target)
      const bytes = await diskBytes(target)
      await recordInstalled(spec, entry, bytes)
      logger.info(TAG, 'install done', { id, version: entry.version, target, bytes })
      return { ok: true, error: null, state: await buildState(spec, entry) }
    }

    const url = `${releaseBase()}/${entry.tag}/${entry.asset}`
    const archive = join(staging, entry.asset)
    await downloadToPart(url, archive, entry, inFlight, spec)

    const unpacked = join(staging, 'unpacked')
    emit(inFlight, { id: spec.id, phase: 'extract', done: 0, total: entry.extractedBytes ?? 0 })
    const result = await extractTarGz(archive, unpacked, {
      maxBytes: spec.maxExtractBytes,
      maxFiles: spec.maxFiles,
      expectedBytes: entry.extractedBytes ?? undefined,
      signal: inFlight.controller.signal,
      onProgress: (done, total) =>
        emit(inFlight, { id: spec.id, phase: 'extract', done, total }),
    })

    emit(inFlight, { id: spec.id, phase: 'verify', done: 0, total: 1 })
    const problems: string[] = []
    if (entry.fileCount !== null && result.entries.length !== entry.fileCount) {
      problems.push(
        `文件数为 ${result.entries.length}，清单声明 ${entry.fileCount}（包多包了东西，或少打了文件）`
      )
    }
    if (entry.extractedBytes !== null && result.bytes !== entry.extractedBytes) {
      problems.push(
        `解压后 ${(result.bytes / 1e6).toFixed(1)}MB，清单声明 ${(entry.extractedBytes / 1e6).toFixed(1)}MB`
      )
    }
    const missing: string[] = []
    for (const required of spec.required ?? []) {
      const bare = required.replace(/\/+$/, '')
      if (!result.entries.some((item) => item.path === bare || item.path.startsWith(`${bare}/`))) {
        missing.push(required)
      }
    }
    if (missing.length > 0) {
      problems.push(`缺这些必需文件：${missing.join('、')}（归档根必须是模型内容本身，不能多包一层目录）`)
    }
    if (problems.length > 0) {
      throw new Error(`这个包对不上清单：${problems.join('；')}。已放弃，未替换原有组件`)
    }
    logger.info(TAG, 'archive verified', {
      id,
      files: result.entries.length,
      bytes: result.bytes,
      sha256: entry.sha256.slice(0, 12),
    })

    await promote(unpacked, target)
    await recordInstalled(spec, entry, result.bytes)
    logger.info(TAG, 'install done', { id, version: entry.version, target })
    return { ok: true, error: null, state: await buildState(spec, entry) }
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    logger.error(TAG, 'install failed', { id, message })
    const hint = isBlockedBySystem(err)
    return {
      ok: false,
      systemSettingsHint: hint || undefined,
      error: hint ? '组件文件没能写入，请到「系统设置 → 隐私与安全性」允许 Vv Transcribe 后重试' : humanize(err, spec),
    }
  } finally {
    // 成功也要收尾：.staging 里躺着的是一份完整归档，等于把下载体积原地翻倍
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/** 安装记录落在清单指纹之后：记的是「磁盘上现在这份是清单里的哪一版」 */
async function recordInstalled(spec: ComponentSpec, entry: AssetEntry, bytes: number): Promise<void> {
  const map = await readInstalled()
  map[spec.id] = {
    version: entry.version,
    sha256: entry.sha256,
    bytes,
    installedAt: new Date().toISOString(),
  }
  await writeInstalled(map)
}

/** EACCES/EPERM 在两个系统上都可能是「系统拦住了这个文件的写入/执行」，值得单独给按钮 */
function isBlockedBySystem(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code
  return code === 'EACCES' || code === 'EPERM'
}

/** 剩下几种磁盘/结构错误给人话，其余原样带出（ArchiveError 的消息本来就是照着能弹 toast 写的） */
function humanize(err: unknown, spec: ComponentSpec): string {
  if (err instanceof ArchiveError) return err.message
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'ENOSPC') {
    return `磁盘剩余空间不够，装不下 ${spec.title}（${spec.hint}）。清理出空间后重试`
  }
  if (code === 'EROFS') return `组件目录所在磁盘是只读的，无法写入 ${spec.title}`
  return err instanceof Error ? err.message : String(err)
}

/**
 * 发起安装。同一组件同时只允许一份在跑（连点、或两个窗口都点「下载」会并起两条
 * 下载流抢同一个临时文件），后来者复用前一份并接上同一进度流。
 */
export function installComponent(
  id: string,
  onProgress?: (p: ComponentProgress) => void
): Promise<ComponentResult> {
  let spec: ComponentSpec
  try {
    spec = specOf(id)
  } catch (err) {
    return Promise.resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
  const current = inflight.get(id)
  if (current) {
    if (onProgress) current.task.watchers.push(onProgress)
    return current.run
  }
  const task: Task = { controller: new AbortController(), reason: '', watchers: [] }
  const run = doInstall(id, spec, task, onProgress).finally(() => {
    inflight.delete(id)
  })
  inflight.set(id, { task, run })
  return run
}

/** 取消在跑的安装。回是否真有其事，界面按这个决定要不要提示「没有找到正在下载的组件」 */
export function cancelInstall(id: string): boolean {
  const record = inflight.get(id)
  if (!record) return false
  record.task.reason = 'cancelled'
  record.task.controller.abort()
  return true
}

export function installingComponents(): string[] {
  return [...inflight.keys()]
}

/**
 * 删除组件（释放磁盘）。引擎在跑时拒绝，因为 Windows 上运行中的 exe 改名会失败，
 * 而模型目录被 sidecar 打开着删一半会让下一次配音报出一串看不懂的文件错误。
 */
export async function removeComponent(id: string): Promise<ComponentResult> {
  let spec: ComponentSpec
  try {
    spec = specOf(id)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (inflight.has(id)) return { ok: false, error: `${spec.title} 正在下载，先取消再删除` }
  const busy = spec.busy?.()
  if (busy) return { ok: false, error: busy }

  const target = spec.target()
  if (!existsSync(target)) {
    return { ok: false, error: `${spec.title} 本来就不在组件目录里，没有可删除的东西` }
  }
  try {
    await rm(target, { recursive: true, force: true })
    // 顺手扫掉残留：失败的安装可能留下 .prev / .part，用户按「删除」的意思是这一栏整个清空
    await rm(`${target}.prev`, { recursive: true, force: true }).catch(() => {})
    await rm(`${target}.part`, { force: true }).catch(() => {})
    const map = await readInstalled()
    if (map[id]) {
      delete map[id]
      await writeInstalled(map)
    }
    logger.info(TAG, 'component removed', { id, target })
    const cached = cachedRemote(spec)
    return { ok: true, error: null, state: await buildState(spec, cached.entry, cached.inManifest) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(TAG, 'remove failed', { id, message })
    return { ok: false, error: `删除失败：${message}` }
  }
}
