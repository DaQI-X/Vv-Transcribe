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
import { formatBytes } from '../../../src/utils/formatBytes'
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

/**
 * hf-mirror 上那份逐字节副本的前缀（.github/workflows/mirror-release.yml 把 Release 资产原样
 * 同步进 Seven7Q/vv-transcribe-releases 并按发布号打 tag，所以两边只差前缀）。
 * `?download=true` 不是装饰：它决定 Xet 后端给的 Content-Disposition 是 attachment 还是 inline，
 * 而 inline 那条在浏览器侧会被当成页面渲染（#406 官网那条直链栽的就是这个）。
 * 另一个坑是 Referer：带上外部站的 Referer 时 hf-mirror 只回一个 6.5KB 的「警告：未授权访问」HTML 页，
 * 实测 net.fetch 不发 Referer，所以这条候选拿到的是原文件——24,445,808 字节、12 秒、SHA2-256 与清单一致。
 */
const MIRROR_BASE = 'https://hf-mirror.com/datasets/Seven7Q/vv-transcribe-releases/resolve'

/**
 * 资产取件的候选源，按顺序试（#407）。
 * 自家 Release 排第一：它是唯一发版源，镜像只是副本，能取到原件就不去动第三方。
 * 但副本必须有：国内直连 github.com 实测要么 0 字节连不上、要么 15–17KB/s 地漏，
 * 而引擎二进制 24MB 按那个速度要 27 分钟——那不是「慢一点」，是必挂（现有文案
 * 「可开启网络加速后重试」就是这条链路的自白）。
 * 换 host 不动信任模型：落地前比的始终是清单钉死的那份 SHA2-256，与来源无关。
 */
const ASSET_SOURCES: { prefix: string; suffix: string }[] = [
  { prefix: RELEASE_BASE, suffix: '' },
  { prefix: MIRROR_BASE, suffix: '?download=true' },
]

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
  /**
   * 当前在做的这一步（模型那条要逐文件取十几个，一根跨全批的进度条会连着几分钟不动）。
   * 只在有多个文件时给，单件下载不添这句噪音。
   */
  step?: string
}

export interface ComponentResult {
  ok: boolean
  error: string | null
  state?: ComponentState
  /** 失败特征像「系统拦住了写入/执行」，界面据此给「打开隐私设置」按钮 */
  systemSettingsHint?: boolean
  /**
   * 用户自己按了「取消下载」。与转写那一侧同名（见 transcribeJob 的 canceled）：
   * 界面要靠它把这条回成中性提示，不然点取消的人收到的是红色失败。
   */
  canceled?: boolean
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
  /**
   * 整条任务被中止的原因。abort() 本身不带信息，不记这一笔就分不清「用户取消」和
   * 「某一棒自己断流」——前者要立刻停手，后者要换下一个源继续。
   * 断流/超时是单个候选源的事，记在 attemptDownload 里，不在这层。
   */
  reason: '' | 'cancelled'
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
 *
 * 覆盖生效时只认那一个源、不再追加生产候选源：自测口子要的是「跑的就是我喂的这份」，
 * 中间混进一次 hf-mirror 成功会让那条链路测了等于没测。
 */
function assetSources(): { prefix: string; suffix: string }[] {
  const override = process.env.VV_COMPONENTS_RELEASE_BASE
  if (override && process.env.VV_COMPONENTS_MANIFEST_URL) return [{ prefix: override, suffix: '' }]
  return ASSET_SOURCES
}

/**
 * 同一份资产的取件地址，按候选顺序排。tag 与资产名在清单解析那一步就过过正则
 * （TAG_RE / ASSET_RE），所以这里拼串不引入新的注入面。
 * 导出只为让单测钉住「顺序」与「镜像那条必须带 ?download=true」——这两条错了都不会崩，
 * 只会让用户拿到一个 HTML 页或永远先等满 GitHub 的超时。
 */
export function assetUrls(entry: Pick<AssetEntry, 'tag' | 'asset'>): string[] {
  return assetSources().map((source) => `${source.prefix}/${entry.tag}/${entry.asset}${source.suffix}`)
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
// 一律不进 HTTP 缓存：几百 MB 的组件包写进磁盘缓存会把后端撑坏，之后同一个 profile 里的
// net.fetch 会卡在缓存事务上——headers 都不回来、0 字节直到超时，重启应用也没用（2026-11-24 本机实测：
// 同一进程同一分钟，默认缓存 20 秒 0 字节，cache:'no-store' 1.2 秒拿到）。下载本来就要逐字节对 SHA2-256，
// 缓存给不了任何价值。
const netFetch = (url: string, init: Parameters<typeof net.fetch>[1]) =>
  net.fetch(url, { ...init, cache: 'no-store' })

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
 * 每个候选源给多少机会。前面的源（生产上就是 GitHub）用快刀，判据是**速率**而不是「有没有断」：
 * 国内直连 github.com 的失败形态不是报错，而是 0 字节连不上或以 15–17KB/s 级漏——只按「多久没新
 * 字节」判，那条 trickle 会一直算「还活着」，24MB 的引擎二进制要 27 分钟才撞到硬上限，用户等到的
 * 是「下载超时」。所以加一条「3 秒内没进来 1MB 就换源」：同一台机器关掉代理实测，github.com 三秒
 * 只漏进 64KB（照这个速度取不完），hf-mirror 同一条 24MB 十二秒跑完（≈2MB/s）——快刀切的是前者，
 * 而真误伤了也只是换到 hf-mirror，不比原件慢。最后一个源不给快刀，理由见下面两份预算。
 *
 * 这里刻意不按「用户在国内还是国外」选源：判国家码要么问第三方 IP 服务（多一个能撒谎、能挂、
 * 还把用户出口 IP 交出去的角色），要么问自家域名下的 CF trace——可挂了代理/VPN 的用户 loc 会变成
 * 海外，而那批人恰恰最需要镜像，等于把判据建在「有没有开加速」上。按速率选源不用知道用户在哪，
 * 也不新增任何网络往返：第一棒自己会回答这个问题。
 */
/**
 * 第一棒（自家 Release）的预算：8 秒断流 + 「3 秒没进够 1MB」两条快刀。
 * 最后一棒只留 8 秒断流、不设快刀：前面都不行时得有人把最后一棒跑完，而镜像那棒的第一个字节本身
 * 就要等三秒多才到（TLS + 302 + Xet 握手），给它同一把快刀等于自己把自己切死。
 * 导出是为了让单测读的是真阈值，而不是测试里抄一份数字再自我证明。
 */
export const EARLY_BUDGET: Budget = { idleMs: 8_000, floorBytes: 1_000_000, floorMs: 3_000, hardMs: 3 * 60_000 }
export const LAST_BUDGET: Budget = { idleMs: IDLE_TIMEOUT_MS, floorBytes: 0, floorMs: 0, hardMs: HARD_TIMEOUT_MS }
/** 看门狗的检查粒度；也是「取消之外」的故障最坏会被多容忍 1 秒的原因 */
export const WATCHDOG_MS = 1_000

export interface Budget {
  /** 连续多少秒没有新字节算断流 */
  idleMs: number
  /** 快刀阈值：floorMs 内没收到 floorBytes 就换源；0 表示不设这条 */
  floorBytes: number
  floorMs: number
  /** 这一棒的硬上限 */
  hardMs: number
}

/**
 * 这一棒该判死了吗？返回判死原因，空串表示继续等。
 * 抽成纯函数是因为它整个就是「拿三个时间戳比大小」，靠假时钟在集成测试里演它，
 * 测到的往往是假时钟而不是这条判据——而 3 秒换源快不快、会不会误伤，全押在它身上。
 */
export function stallReason(
  now: number,
  startedAt: number,
  lastTouch: number,
  received: number,
  budget: Budget
): string {
  if (now - lastTouch > budget.idleMs) {
    return `连续 ${Math.round(budget.idleMs / 1000)} 秒没有新字节进来`
  }
  if (budget.floorBytes > 0 && now - startedAt > budget.floorMs && received < budget.floorBytes) {
    return `${Math.round(budget.floorMs / 1000)} 秒只进来 ${formatBytes(received)}，照这个速度取不完`
  }
  return ''
}

/** 从地址里取 host，只用于把「哪个源没取到」说清楚；导出是为了 ytDlpUpdate 那条链路用同一个标签 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * 从一个候选源取一份文件，边下边算 SHA2-256，返回字节数与指纹（比对交给调用方：
 * 一份源取到坏文件不该直接判死，原件可能还好着）。
 * `onBytes` 每收到一块就被调一次，进度条怎么拼是调用方的事。
 */
async function attemptDownload(
  url: string,
  partFile: string,
  entry: AssetEntry,
  inFlight: Task,
  budget: Budget,
  onBytes: (received: number) => void
): Promise<{ received: number; digest: string }> {
  await mkdir(dirname(partFile), { recursive: true })
  // 没有断点续传：换源就是从 0 再来一遍，所以先清掉上一棒的半件（跨卷 rename 是 EXDEV，
  // 临时件必须留在组件目录之内，这点与 #230 当初的理由一致）
  await rm(partFile, { force: true })

  const attempt = new AbortController()
  // 取消按的是整条任务的开关，而此刻在飞的只有这一棒，所以要把它串到本棒的 signal 上：
  // 否则用户在切源之后点「取消」，要等这一棒自己跑完才停得下来
  const onGlobalAbort = () => attempt.abort()
  inFlight.controller.signal.addEventListener('abort', onGlobalAbort, { once: true })

  const startedAt = Date.now()
  let lastTouch = Date.now()
  let lastReport = 0
  let received = 0
  let stalled = ''
  const hash = createHash('sha256')
  const watchdog = setInterval(() => {
    const reason = stallReason(Date.now(), startedAt, lastTouch, received, budget)
    if (reason) {
      stalled = reason
      attempt.abort()
    }
  }, WATCHDOG_MS)
  const hardTimer = setTimeout(() => {
    stalled = `约 ${formatBytes(entry.bytes)} 在 ${Math.round(budget.hardMs / 60_000)} 分钟内没下完`
    attempt.abort()
  }, budget.hardMs)

  try {
    const res = await netFetch(url, {
      redirect: 'follow',
      signal: attempt.signal,
      headers: { 'User-Agent': 'vv-transcribe' },
    })
    if (!res.ok) {
      // 只有 404 算「这个源亲口说没有」（MissingAssetError）：调用方要靠它区分「重跑没意义」
      // 和「这一棒没跑动」，5xx 是服务器那一刻的状态，不能拿它掐掉兜回那一棒。
      // 这句话两条来源都要能用，所以不写「发布」：清单那条 entry.tag 是 vX.Y.Z 这种发布号，上游那条是提交号前 7 位
      if (res.status === 404) {
        throw new MissingAssetError(`下载失败 ${res.status}（${entry.asset} 在 ${entry.tag} 这一版里取不到？）`)
      }
      throw new Error(`下载失败 ${res.status}（${hostOf(url)} 这一棒没取到文件）`)
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
          onBytes(received)
        }
      }
    } finally {
      await handle.close()
    }
    onBytes(received)
  } catch (err) {
    if (inFlight.reason === 'cancelled') throw new Error('已取消下载')
    if (err instanceof MissingAssetError) throw err
    if (stalled) {
      throw new Error(`${stalled}（已收到 ${formatBytes(received)} / 约 ${formatBytes(entry.bytes)}）`)
    }
    // net.fetch 失败抛的是 net::ERR_* 这类错误码，原样冒到界面上没人看得懂，包一句。
    // 这里不套 NETWORK_HINT：那句讲的是「连不上组件清单（直连 GitHub）」，而这一棒打的是自家 Release
    // 或模型上游那两个 host（host 名由调用方那层 label 点出来），搬 GitHub 那句会让用户去查一条
    // 根本没参与的链路。「挂加速」这句也只在整个队列输完时补一次，别每棒各带一遍。
    const message = err instanceof Error ? err.message : String(err)
    if (NETWORK_ERROR_RE.test(message)) throw new Error(`请求没通到对端（${message}）`)
    throw err
  } finally {
    clearInterval(watchdog)
    clearTimeout(hardTimer)
    inFlight.controller.signal.removeEventListener('abort', onGlobalAbort)
  }

  return { received, digest: hash.digest('hex') }
}

/**
 * 把一份资产取到 `.part` 并验过指纹，返回收到的字节数；任何一道闸门没过就抛，由调用方删掉临时件。
 * 候选源按 assetUrls() 的顺序试（#407）：自家 Release 取不动时换 hf-mirror 上那份逐字节副本，
 * 换 host 不换 SHA2-256 那道闸门——清单没点过的文件在哪个源上都装不进去。
 * 全试完仍没成时，第一腿还能补跑一次耐心预算，理由写在下面那段注释里。
 * `progress` 只给逐文件取上游那条路用：一条进度条要跨 17 个文件连起来走，
 * 每个文件都拿自己的字节数当分母，界面上就是一根从 0 反复弹回去的假条。
 * 导出只为让单测能喂假网络：换源、以及「换了 host 但指纹不符照样不认」这两条
 * 是本次改动的全部风险所在，走公开 API 测要把整条安装链都搭起来。
 */
export async function downloadToPart(
  urls: string[],
  partFile: string,
  entry: AssetEntry,
  inFlight: Task,
  spec: ComponentSpec,
  progress?: { base: number; total: number },
  step?: string
): Promise<number> {
  const doneOf = (received: number) => (progress ? progress.base + received : received)
  const totalOf = () => (progress ? progress.total : entry.bytes)
  const report = (received: number) =>
    emit(inFlight, {
      id: spec.id,
      phase: 'download',
      done: doneOf(received),
      total: totalOf(),
      ...(step ? { step } : {}),
    })

  const problems: string[] = []
  /** 哪个源亲口说过「这一版没有这份件」——对它的重跑只会再拿到同一个 404，不该做 */
  const absent = new Set<string>()
  /** 哪个源给过一份字节完整的文件（哪怕指纹不对）——重跑它等于再赌一次同一条链路的坏数据 */
  const delivered = new Set<string>()

  /**
   * 跑一棒：成功返回 true，任何一道闸门没过就把原因记进 problems 并返回 false。
   * `note` 只影响给用户看的那句问题里的措辞（兜回第一腿那一棒要说清它是第二遍）。
   */
  const take = async (url: string, budget: Budget, note: string): Promise<boolean> => {
    if (inFlight.reason === 'cancelled') throw new Error('已取消下载')
    const label = `${hostOf(url)}${note}`
    let taken: { received: number; digest: string }
    try {
      taken = await attemptDownload(url, partFile, entry, inFlight, budget, report)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === '已取消下载') throw err
      if (err instanceof MissingAssetError) absent.add(url)
      problems.push(`${label}：${message}`)
      logger.warn(TAG, 'asset attempt failed', { id: spec.id, url, error: message })
      return false
    }
    if (taken.received !== entry.bytes) {
      problems.push(`${label}：下载不完整（收到 ${taken.received} / 应有 ${entry.bytes} 字节）`)
      logger.warn(TAG, 'incomplete download', {
        id: spec.id,
        url,
        received: taken.received,
        expected: entry.bytes,
      })
      return false
    }
    // 走到这里，这个源已经把整份文件交出来了：下面拒的是内容，不是链路
    delivered.add(url)
    if (taken.digest !== entry.sha256) {
      // 记 host：镜像上的副本与原件指纹不一致时，这句话是唯一的现场证据
      logger.error(TAG, 'fingerprint mismatch', {
        id: spec.id,
        url,
        expected: entry.sha256,
        actual: taken.digest,
      })
      problems.push(
        `${label}：指纹和钉死的那份对不上（${taken.digest.slice(0, 12)}… ≠ ${entry.sha256.slice(0, 12)}…）`
      )
      return false
    }
    return true
  }

  // 候选队列：最后一个用耐心预算（换无可换只能等），其余按快刀阈值随时准备换源
  for (const [index, url] of urls.entries()) {
    const budget = index === urls.length - 1 ? LAST_BUDGET : EARLY_BUDGET
    if (await take(url, budget, '')) {
      if (index > 0) {
        logger.info(TAG, 'asset recovered from another source', { id: spec.id, url, attempts: index + 1 })
      }
      return entry.bytes
    }
  }

  /**
   * 兜回第一个源、用不设快刀的预算跑到底。
   * 加候选源只能让下载变好，不能把「本来慢慢能下完」变成「彻底失败」，而这一棒正是那条底线：
   * 2026-11-21 实测国内直连 GitHub 约 21KB/s、镜像约 2MB/s，而清单钉的那个 tag 镜像未必同步过
   * （发版链路的镜像同步缺凭证时是「打警告后绿退」，不是失败）。快刀在 3 秒掐断第一腿、
   * 第二腿 404，按 45 分钟的硬上限本来 19 分钟能下完的那份文件就变成一句报错。
   * 兜回那一棒只补「链路没跑通」这一种：第一个源既没亲口说没有（absent），也没把整份文件交出来
   * 过（delivered——那种情况重跑等于再赌一次同一条链路的坏数据，白烧到 45 分钟上限）。
   */
  if (urls.length > 1 && !absent.has(urls[0]) && !delivered.has(urls[0])) {
    const retryNote = '（换回第一个源跑到底）'
    if (await take(urls[0], LAST_BUDGET, retryNote)) {
      logger.info(TAG, 'asset recovered by retrying the first source', {
        id: spec.id,
        url: urls[0],
        attempts: urls.length + 1,
      })
      return entry.bytes
    }
  }

  /**
   * 「挂加速」只对链路有意义。指纹对不上是源上那份内容不对——网络再快拿回来的还是它，
   * 这句劝下去等于把用户往错方向支（判据同上面 404 不套 NETWORK_HINT 那条）。
   */
  const tail = problems.every((problem) => problem.includes('指纹'))
    ? '（换网络不会让它对上）'
    : '。可开启网络加速后重试'
  if (problems.length === 1) throw new Error(`${problems[0]}${tail}`)
  throw new Error(`几个下载源都没取到 ${entry.asset}：${problems.join('；')}${tail}`)
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
  // 走清单那条有两个候选源，日志把两条都记下来：事后从 app.log 里要能看出「哪条是出路」
  const candidates = spec.upstream ? [] : assetUrls(entry)
  const from = spec.upstream
    ? `${spec.upstream.repo}@${spec.upstream.commit.slice(0, 7)}`
    : candidates.join(' → ')
  logger.info(TAG, 'install start', { id, from, sha256: entry.sha256, bytes: entry.bytes })

  try {
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    // 落点的父目录要在动手前建好：promote 用的是 rename，父目录不存在时它报 ENOENT，
    // 而这一刻整份归档已经下载并解压完成了——空有 135MB 成品却装不上（干净机器上 tts-models/ 本来就不存在）
    await mkdir(dirname(target), { recursive: true })

    if (spec.kind === 'binary') {
      const partFile = join(staging, entry.asset)
      await downloadToPart(candidates, partFile, entry, inFlight, spec)
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
      for (const [fileIndex, file] of source.files.entries()) {
        // 指纹表是代码不是网络输入，但它会在未来某次编辑里写错：拼路径前先卡住「绝对路径 / 往上跳」，
        // 否则一个笔误就能把下载写到组件目录之外去
        if (file.path.startsWith('/') || file.path.includes('..')) {
          throw new Error(`指纹表里的路径不合规矩：${file.path}`)
        }
        await downloadToPart(
          // 模型那条只有一个源（上游 hf-mirror，见 ttsModelUpstream），换不成候选表
          [upstreamFileUrl(source, file)],
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
          { base: downloaded, total: entry.bytes },
          // 这一棒单独说第几个：跨全批那根条按 135MB 走，头几个文件再快也只挪动零点几个百分点，
          // 用户看到的是一根几分钟不动的条，而它其实在正常出货
          source.files.length > 1 ? `第 ${fileIndex + 1}/${source.files.length} 个文件` : undefined
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

    const archive = join(staging, entry.asset)
    await downloadToPart(candidates, archive, entry, inFlight, spec)

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
    if (inFlight.reason === 'cancelled') {
      // 取消不是故障。这条以前和真失败共用下面的 ERROR，界面拿到 ok:false 就弹红 toast，
      // 于是用户自己按的那颗「取消下载」换回来一句看起来像下载坏了的提示
      logger.info(TAG, 'install canceled', { id, message })
      return { ok: false, canceled: true, error: '已取消下载' }
    }
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
