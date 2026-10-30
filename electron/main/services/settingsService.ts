/**
 * 设置持久化服务
 * 管理应用的 ASR 和 AI 配置项，以 JSON 文件形式持久化到 userData 目录
 * 支持内存缓存，避免重复读取磁盘
 *
 * API Key 单独说：磁盘上那份 settings.json 里的三把 Key 走系统的 safeStorage（macOS Keychain /
 * Windows DPAPI）加密后写入，值形如 `v1:<base64>`。没有前缀的按历史明文处理——首次读到且本机
 * 能加密就就地换掉。safeStorage 不可用时退回明文并让界面说清楚（见 getSettingsView 的
 * keyEncryptionAvailable）。明文不进渲染进程：给界面的一律是脱敏视图，只有主进程拿得到解密结果。
 */
import { safeStorage } from 'electron'
import { rename } from 'node:fs/promises'
import { logger } from './logger'
import { normalizeLocalTtsEngine, type LocalTtsEngineId } from './localTtsEngine'
import {
  CORRUPT_SETTINGS_PREFIX,
  atomicWriteJson,
  corruptSettingsName,
  fileStamp,
  pruneOlderCopies,
  readJsonFile,
  settingsFile,
  userDataPath,
} from './userDataStore'
import {
  CURRENT_SETTINGS_VERSION,
  CURRENT_SETTINGS_VERSION_FIELD,
  migrateSettingsDocument,
  type SettingsDocument,
} from './settingsSchema'

export interface AppSettings {
  asrProvider: string
  asrApiKey: string
  asrApiBase: string
  asrModel: string
  /**
   * 本地引擎的 Whisper 档位（base / small）。
   * 与 asrModel 分开存：asrModel 只喂云端转写接口，本地档位名会被 Python 侧直接拼成
   * HuggingFace repo 名，两者混用会让用户填的云端模型名变成下载目标。
   */
  asrLocalModel: string
  /** Whisper 语言码（zh/en/ja/…），同时决定校对走中文规则还是通用 prompt */
  asrLanguage: string
  aiProvider: string
  aiApiKey: string
  aiApiBase: string
  aiModel: string
  /**
   * 配音（TTS）的一整套配置，与校对分开存。
   * 分开是因为端点不同：`/v1/audio/speech` 收的是配音模型 id（OpenAI 形如 tts-1），拿 chat
   * 模型去调必然 400；而且只做对话的服务商根本没有这个端点，配音常常要指到另一家网关去，
   * 所以接口地址与 Key 也能单独填——留空表示沿用上面那套（见 getTTSConfig）。
   */
  ttsApiBase: string
  ttsApiKey: string
  ttsModel: string
  ttsVoice: string
  /**
   * 配音用云端接口还是本机引擎：'cloud' | 'local'。
   * 默认云端，是老配置的既有行为——本地档没有 Key、没有模型名，把默认翻过来等于让所有
   * 已经配好云端的人凭空失去配音。
   */
  ttsEngine: string
  /**
   * 本地档的引擎 id（sherpa-onnx-vits-zh-ll / kokoro-multi-lang-v1_1）。
   * 与 ttsModel 分开存：ttsModel 只喂云端接口，这里的值会被直接拼成模型目录名，
   * 混用会让用户填的云端模型名变成下载目标（同 asrLocalModel 的理由）。
   */
  ttsLocalEngine: string
  /**
   * 本地档的音色是 sid 编号（字符串写法），和云端那档的音色名各存各的：
   * 换引擎不该把另一档的选择冲掉，否则用户切回来看到的是「音色没了」。
   */
  ttsLocalVoice: string
}

/** 密钥字段的字段名；脱敏视图与保存语义都按这几个键走 */
type SecretField = 'asrApiKey' | 'aiApiKey' | 'ttsApiKey'
const SECRET_FIELDS: SecretField[] = ['asrApiKey', 'aiApiKey', 'ttsApiKey']

/**
 * 密文在 JSON 里的写法。加前缀是为了「能不能解密」和「是不是新版格式」能分开判断：
 * 没前缀＝历史明文或本机加密不可用时的退回，有前缀解不开＝换过机器（密钥跟机器/用户绑定）。
 */
const ENC_PREFIX = 'v1:'

/** 每把密钥在界面上的状态：不返回明文，但要把「有没有、能不能用、是不是明文」说清楚 */
export type SecretStatus = 'none' | 'encrypted' | 'plaintext' | 'unreadable'

/** 渲染层看到的设置：非密钥字段原样 + 每把密钥的状态 + 本机能不能加密 */
export type SettingsView = Omit<AppSettings, SecretField> & {
  asrKeyStatus: SecretStatus
  aiKeyStatus: SecretStatus
  ttsKeyStatus: SecretStatus
  keyEncryptionAvailable: boolean
  /**
   * 这份配置是怎么来的：null＝正常读到了磁盘上的配置；非 null＝磁盘那份没读出来，
   * 界面必须把它当成「出问题了」而不是「用户还没填」。文案见 describeLoadProblem。
   */
  storageProblem: string | null
}

/**
 * 「保存」能接受的补丁形状。密钥单独摊出来写，是为了让 null（清除）真的能通过类型检查：
 * `Partial<AppSettings> & Partial<Record<SecretField, string | null>>` 这种交叉类型里，
 * 同名属性会被求交收成 `string | undefined`，null 直接判不兼容——于是调用方只能传 ''，
 * 而 '' 的语义是「不改」，传下去就是把用户的 Key 留着不删。界面那个「清除 Key」按钮
 * 走的是同一条 IPC，写错一次就是当着用户的面把配置改了却没删掉他以为删掉的东西。
 * handlers 与 preload 都引用这个类型，别再各写一遍。
 */
export type SettingsPatch = Partial<Omit<AppSettings, SecretField>> &
  Partial<Record<SecretField, string | null>>

const DEFAULT_SETTINGS: AppSettings = {
  asrProvider: 'local',
  asrApiKey: '',
  asrApiBase: '',
  asrModel: '',
  asrLocalModel: 'base',
  asrLanguage: 'zh',
  aiProvider: 'openai',
  aiApiKey: '',
  aiApiBase: '',
  aiModel: '',
  ttsApiBase: '',
  ttsApiKey: '',
  ttsModel: '',
  ttsVoice: '',
  ttsEngine: 'cloud',
  // 空串＝还没选过，取值时落回中文默认档（见 normalizeLocalTtsEngine）
  ttsLocalEngine: '',
  // 空串同上：VITS 与 Kokoro 的 sid0 都是各自那档里推荐的那个音色
  ttsLocalVoice: '',
}

/**
 * 一份缓存三样用途：raw 是磁盘上该原样写回的样子（密文不动它），
 * plain 是解密后的（只给主进程里的转写/校对用），status 是给界面的。
 * 每次解密都要过一遍系统密钥库，所以按进程缓存，不在每次取配置时重解。
 */
interface SettingsCache {
  raw: AppSettings
  plain: AppSettings
  status: Record<SecretField, SecretStatus>
  /** 磁盘上有没有需要就地加密的历史明文 */
  migrated: boolean
}

let cache: SettingsCache | null = null

/**
 * 读盘失败的三种，处理权限完全不同，所以分开建类型而不是加个 bool：
 * - corrupt：文件确实在那儿但 JSON 解不开（半截写入、手改坏）。已经把原件改名留档，
 *   磁盘上不存在「再坏一次」的风险，所以允许继续按默认值运行并写回新配置。
 * - unreadable：连内容都没拿到（权限、只读介质、settings.json 是个目录），或者格式链
 *   断在半路。这时候内存里的默认值是来自猜测，写盘就是把用户的东西盖掉——禁止写，直到读成功为止。
 * - fromNewerVersion：文件自报的版本比本应用认得的还新（用户装了更新版本又回退，或
 *   装错了旧包）。那份文件是好的，只是本应用读不懂它，所以既不搬也不改名——改名等于把
 *   人家正在用的配置挪走，而「读不懂」这件事本身已经足够拦住写盘。
 * 首次运行（文件本来就不存在）不在这里，那不叫失败。另外 corrupt 只在原件真的留档成功时成立：
 * 留档也没成的话原件还在原位，只能按 unreadable 处置。
 */
export type SettingsLoadProblem =
  | { kind: 'corrupt'; detail: string; archivedTo: string }
  | { kind: 'unreadable'; detail: string }
  | { kind: 'fromNewerVersion'; version: number }

/**
 * 本轮启动的读数结论，只用来告诉界面「这份配置不是正常读出来的」。
 * 写盘成功不抹它——原件被留档这件事，不会因为后来又写了个新文件就不成立了。
 */
let loadProblem: SettingsLoadProblem | null = null

/**
 * 唯一能阻止落盘的状态，和 loadProblem 分开是有原因的：corrupt 也要报给界面，
 * 但它的语义是「原件保住了、可以继续」；unreadable 才是「再写就是盖掉用户的东西」。
 * 一个变量既当提示又当闸门，下次改动就会误放开放误拦。
 */
let writeBlocked = false

/**
 * 禁止写盘时给界面的一句话（会原样出现在 toast 上，所以是给人看的措辞，不是错误码）。
 * 按「为什么拦」分了两条，因为要用户做的事不一样：这一条是「去看这台机器上的数据目录」，
 * 而版本读不懂那条只能靠更新应用——拦错了方向，用户检查半天磁盘什么毛病也没有。
 */
export const SETTINGS_WRITE_BLOCKED =
  '设置文件当前读不出来（权限或磁盘问题），为避免覆盖你已保存的配置，本次没有写入。请检查这台机器上的应用数据目录后重试'

/** 文件来自更新版本的应用时的闸门提示 */
export const SETTINGS_WRITE_BLOCKED_NEWER_VERSION =
  '这台机器上的设置文件来自更新版本的应用，本版本读不懂它的配置格式，为避免覆盖，本次没有写入。请使用该更新版本的应用来保存设置'

/**
 * 闸门落下时该说哪句：拦盘的原因只有 fromNewerVersion 这一种不是磁盘问题
 */
function writeBlockedMessage(): string {
  return loadProblem?.kind === 'fromNewerVersion'
    ? SETTINGS_WRITE_BLOCKED_NEWER_VERSION
    : SETTINGS_WRITE_BLOCKED
}

/**
 * 「这次不许落盘」这一类错误的共同形状。
 * IPC 处理器靠 instanceof 认出它并原样透出去，而不是比对具体文案：靠文案相等来放行，
 * 下次多加一条闸门提示就会漏进处理器那句「清出磁盘空间或修好目录权限」的建议里——
 * 用户对着一个本来就没坏的二进制版本文件检查磁盘，是我们自己把话说错的。
 */
export class SettingsWriteBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettingsWriteBlockedError'
  }
}

/** 留档与备份的份数上限：坏盘会每次启动都留一份，不能把数据目录变成垃圾场 */
const ARCHIVE_KEEP = 5

/**
 * 把解不开的 settings.json 改名留档，返回留档后的文件名（没留成返回 null）。
 * 改名而不是复制：原件从此不会再被这次或下次的写入碰到，两份内容也不会混在一起。
 */
async function archiveCorruptSettings(): Promise<string | null> {
  const name = corruptSettingsName(fileStamp(new Date()))
  try {
    await rename(settingsFile(), userDataPath(name))
  } catch {
    return null
  }
  // 清扫失败不影响这次留档本身，别为了删旧档把刚保住的原件又搭进去
  await pruneOlderCopies(CORRUPT_SETTINGS_PREFIX, ARCHIVE_KEEP)
  return name
}

/** 给界面的一句话：null＝这份配置是正常从磁盘读出来的 */
function describeLoadProblem(problem: SettingsLoadProblem | null): string | null {
  if (!problem) return null
  if (problem.kind === 'corrupt') {
    return `设置文件没能解析，已把原件保留为 ${problem.archivedTo}，本次从默认配置开始。要找回原来的配置请在「打开数据目录」里查看那份文件`
  }
  if (problem.kind === 'fromNewerVersion') {
    return `这台机器上的设置文件来自更新版本的应用（配置格式 v${problem.version}，本版本只认到 v${CURRENT_SETTINGS_VERSION}），本次按默认配置运行；为防覆盖，保存已停用。装上那个更新版本即可恢复，你已保存的配置没有被改动`
  }
  return `设置文件没能读取（${problem.detail}），本次按默认配置运行；为防覆盖，保存已暂时停用`
}

/**
 * 本机密钥库可用性。isEncryptionAvailable() 在 Linux 没有密钥环时可能直接抛，
 * 不包一层就会把整份设置读失败。
 */
function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function seal(plain: string): string {
  if (!plain) return ''
  if (!encryptionAvailable()) return plain
  try {
    return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
  } catch {
    // 加密抛错时存明文，好过把用户填的 Key 丢掉；界面会按 keyEncryptionAvailable 说明仍是明文
    return plain
  }
}

function unseal(stored: string): { value: string; status: SecretStatus } {
  if (!stored) return { value: '', status: 'none' }
  if (!stored.startsWith(ENC_PREFIX)) return { value: stored, status: 'plaintext' }
  try {
    return {
      value: safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')),
      status: 'encrypted',
    }
  } catch {
    return { value: '', status: 'unreadable' }
  }
}

/** 密文解不开时不能把「解不开」当成「没配」，否则用户会去重填一个本来就对的 Key */
function buildCache(raw: AppSettings): SettingsCache {
  const plain = { ...raw }
  const status = {} as Record<SecretField, SecretStatus>
  let migrated = false
  for (const field of SECRET_FIELDS) {
    const { value, status: st } = unseal(raw[field])
    plain[field] = value
    status[field] = st
    if (st === 'plaintext') migrated = true
  }
  return { raw, plain, status, migrated }
}

/**
 * 档位只有界面给出的这两档，值同时也是 Python 侧白名单里的 key。
 * 必须收口：档位名会被 faster-whisper 直接拼成 HuggingFace repo 名去下载，
 * 也用来决定要不要给引擎下发 HF_HUB_OFFLINE，手改过的 settings.json 不能把这两个用途带偏。
 */
const LOCAL_MODEL_TIERS = ['base', 'small'] as const
export type LocalModelTier = (typeof LOCAL_MODEL_TIERS)[number]

export function normalizeLocalModel(raw: unknown): LocalModelTier {
  return LOCAL_MODEL_TIERS.includes(raw as LocalModelTier) ? (raw as LocalModelTier) : 'base'
}

/**
 * 唯一的写盘出口。三条规矩，都是被具体故障逼出来的：
 * 1. 读失败（unreadable / 版本读不懂）时拒绝写——见 writeBlocked，这是「绝不静默丢 Key」的兜底闸门。
 *    注意闸门不在这里解除：POSIX 上 rename 只看目录权限，写成功不代表那份读不出来的文件
 *    变得能读了，把它当「已恢复」反而放过了我们最想拦的那次覆盖。
 * 2. 走 userDataStore 的原子写（先 .tmp 再 rename）与 .bak：裸 writeFile 在崩溃/断电时会留下
 *    半截 JSON，而那半截正是下次启动读不出来的原因。
 * 3. 落盘时一律盖上当前的格式版本，版本字段只有写盘这一处产生——谁都没法写出一份
 *    「没自报版本」的配置，下次读的人就不用再靠猜。
 */
async function writeRaw(raw: AppSettings): Promise<void> {
  if (writeBlocked) {
    throw new SettingsWriteBlockedError(writeBlockedMessage())
  }
  await atomicWriteJson(
    settingsFile(),
    { [CURRENT_SETTINGS_VERSION_FIELD]: CURRENT_SETTINGS_VERSION, ...raw },
    {
      backup: true,
      // 备份没成不阻断这次保存（原子写才是主菜），但也不能悄悄过去：
      // 日后要找上一版时，日志里这一行解释为什么没有 .bak。
      onBackupFailure: (detail) =>
        logger.warn('Settings', 'Backing up previous settings failed', detail),
    }
  )
  cache = buildCache(raw)
}

/** 读到历史明文且本机现在能加密 → 立刻就地加密回写；写成功才认「已迁移」 */
async function migratePlainKeys(raw: AppSettings): Promise<void> {
  if (!encryptionAvailable()) return
  const sealed = { ...raw }
  for (const field of SECRET_FIELDS) {
    if (sealed[field] && !sealed[field].startsWith(ENC_PREFIX)) sealed[field] = seal(sealed[field])
  }
  await writeRaw(sealed)
}

/**
 * 把迁移过的文档落成 AppSettings：逐项按 DEFAULT_SETTINGS 收，而不是整份展开——
 * 界面上多带的状态位、手改出来的非字符串值、以及旧版本残留的键，都不该原样留在配置里。
 */
function normalizeDocument(doc: SettingsDocument): AppSettings {
  const raw: AppSettings = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
    const value = doc[key]
    if (typeof value === 'string') raw[key] = value
  }
  return raw
}

/**
 * 读盘并按「这份配置到底从哪来」分类，是整个设置模块唯一的读数入口。
 * 这几种结局的处置完全不同，所以不是一句 catch 给默认值：
 * - 文件不存在：首次运行，默认值就是正确答案，不报故障、不拦写盘、也不造出一份文件。
 * - 解不开：原件改名留档，再从默认值继续。写盘允许——那份坏文件已经不在原位了，
 *   不存在「再坏一次」；留档没成功时降级成下一条，原件还在原位。
 * - 内容都没拿到：内存里这份纯属猜测，本轮启动禁止写盘。
 * - 版本比本应用新 / 迁移链断了：同样是禁止写盘，但不改名、不搬动——那份文件可能是
 *   用户在更新版本里正在用的配置，我们只是读不懂它，不是它坏了。
 */
async function readCache(): Promise<SettingsCache> {
  if (cache) return cache
  loadProblem = null
  writeBlocked = false
  let raw: AppSettings = { ...DEFAULT_SETTINGS }
  let needsVersionStamp = false

  const read = await readJsonFile<SettingsDocument>(settingsFile())
  if (read.status === 'ok') {
    const migrated = migrateSettingsDocument(read.value)
    if (migrated.status === 'fromNewerVersion') {
      loadProblem = { kind: 'fromNewerVersion', version: migrated.version }
      writeBlocked = true
      logger.error(
        'Settings',
        'settings.json uses a newer schema than this build; saving is disabled',
        `v${migrated.version}`
      )
    } else if (migrated.status === 'gap') {
      loadProblem = {
        kind: 'unreadable',
        detail: `配置格式 v${migrated.at} 到 v${CURRENT_SETTINGS_VERSION} 之间缺一步迁移`,
      }
      writeBlocked = true
      logger.error(
        'Settings',
        'settings.json migration chain is broken; saving is disabled',
        `v${migrated.at}`
      )
    } else {
      raw = normalizeDocument(migrated.doc)
      // 旧格式文件不写版本号，搬上来之后必须把版本盖回去，否则下一个版本只能继续猜。
      // 只在真读到文件时才做这一步——首次运行不该因为「版本对不上」凭空造出一份配置。
      needsVersionStamp = migrated.status === 'migrated'
    }
  } else if (read.status === 'corrupt') {
    const archivedTo = await archiveCorruptSettings()
    if (archivedTo) {
      loadProblem = { kind: 'corrupt', detail: read.detail, archivedTo }
    } else {
      loadProblem = { kind: 'unreadable', detail: '解析失败，且原件没能改名保留，写下去会盖掉它' }
      writeBlocked = true
    }
    logger.error('Settings', 'settings.json is not valid JSON', read.detail)
  } else if (read.status === 'unreadable') {
    loadProblem = { kind: 'unreadable', detail: read.detail }
    writeBlocked = true
    logger.error('Settings', 'settings.json could not be read; saving is disabled', read.detail)
  }

  cache = buildCache(raw)
  try {
    // 读失败时上面已经把 raw 换回默认值：既没有旧字段可搬，也没有明文 Key 可迁，
    // 这两个条件自然为 false，不会去动那份读不出来的文件。
    if (needsVersionStamp) await writeRaw(raw)
    if (cache.migrated) await migratePlainKeys(raw)
  } catch (e) {
    // 迁移写盘失败不影响这次能不能用：内存里已经是迁移后的值，照常干活，下次启动再试。
    // 但必须留痕——磁盘上会继续留着旧字段、历史明文 Key，而这只有翻日志的人才知道。
    logger.warn(
      'Settings',
      'Migrating settings on disk failed',
      e instanceof Error ? e.message : String(e)
    )
  }
  return cache
}

/** 主进程内部用的配置：密钥已解密。渲染层一律走 getSettingsView */
export async function loadSettings(): Promise<AppSettings> {
  const current = await readCache()
  return { ...current.plain }
}

/** 给界面的脱敏视图：几把 Key 在这里就不再返回明文，渲染层拿到的是「有没有、能不能用、是不是明文」 */
export async function getSettingsView(): Promise<SettingsView> {
  const current = await readCache()
  const { asrApiKey: _asr, aiApiKey: _ai, ttsApiKey: _tts, ...rest } = current.raw
  return {
    ...rest,
    asrKeyStatus: current.status.asrApiKey,
    aiKeyStatus: current.status.aiApiKey,
    ttsKeyStatus: current.status.ttsApiKey,
    keyEncryptionAvailable: encryptionAvailable(),
    storageProblem: describeLoadProblem(loadProblem),
  }
}

/**
 * 保存。密钥字段的语义和普通字段不同，界面上的输入框是「留空＝不改」：
 * - 缺席 / 空串：保留磁盘上已有的那把（改个接口地址不用重贴 Key）
 * - null：显式清除（界面「清除已保存的 Key」按钮）
 * - 非空字符串：替换，并按本机能不能加密决定存密文还是明文
 */
export async function saveSettings(patch: SettingsPatch): Promise<SettingsView> {
  const current = await readCache()
  const merged: AppSettings = { ...current.raw }
  const incoming = patch as Partial<AppSettings>
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
    if (SECRET_FIELDS.includes(key as SecretField)) continue
    // 只认这里列得出的配置项，且只收字符串：界面上多带的字段（脱敏视图的状态位）
    // 和任何手改出来的怪值都不该被写回磁盘
    const value = incoming[key]
    if (typeof value === 'string') merged[key] = value
  }
  for (const field of SECRET_FIELDS) {
    const incomingSecret = patch[field]
    if (incomingSecret === undefined || incomingSecret === '') continue
    if (incomingSecret === null) {
      merged[field] = ''
      continue
    }
    merged[field] = seal(incomingSecret.trim())
  }
  await writeRaw(merged)
  return getSettingsView()
}

/**
 * 接口地址归一化。
 * 各家文档常直接给 `https://api.openai.com/v1` 这种带后缀的形式，而请求统一拼成
 * `${apiBase}/v1/...`，所以这里容忍末尾斜杠和多余的 /v1。
 * 转写、校对、以及设置里的「测试连接」必须共用这一个实现，否则测试用归一化后的地址、
 * 干活用原始地址，就会出现「测试说可用、一转写就 404」这种最难查的分歧。
 */
export function normalizeApiBase(raw: string): string {
  return (raw || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

export async function getASRConfig(): Promise<Record<string, unknown>> {
  const settings = await loadSettings()
  return {
    provider: settings.asrProvider,
    apiKey: settings.asrApiKey,
    apiBase: normalizeApiBase(settings.asrApiBase),
    model: settings.asrModel,
    localModel: normalizeLocalModel(settings.asrLocalModel),
  }
}

/** AI 校对配置；留空时回落到 OpenAI 端点，否则拼出来的是非法相对地址，报错对用户毫无意义 */
export async function getAIConfig(): Promise<{ apiKey: string; apiBase: string; model: string }> {
  const settings = await loadSettings()
  return {
    apiKey: settings.aiApiKey,
    apiBase: normalizeApiBase(settings.aiApiBase) || 'https://api.openai.com',
    model: settings.aiModel || 'gpt-4o-mini',
  }
}

/**
 * 配音用哪一档。界面上的「配音引擎」与这里必须是同一组值；认不出的值落回云端，
 * 因为那是 1.0.5 以来唯一的一档——手改 settings.json 改出一个怪值，不该让配音凭空换了个后端。
 */
export type TtsEngineMode = 'cloud' | 'local'

export function normalizeTtsEngine(raw: unknown): TtsEngineMode {
  return raw === 'local' ? 'local' : 'cloud'
}

/**
 * 本地档的音色取值。
 * 空 → '0'（推荐档）；已经是编号字符串 → 原样；别的（例如从云端那档残留的 `alloy`）也原样带过去，
 * 让 ttsService 的校验报出「音色得是编号」——在这儿悄悄换成 0，用户会以为自己的选择生效了，
 * 听到的却是另一个人的声音。
 */
export function normalizeLocalVoice(raw: string): string {
  const trimmed = (raw || '').trim()
  return trimmed || '0'
}

/**
 * 配音（TTS）配置。
 * 云端档：接口地址与 Key 是「留空＝沿用校对那套」——多数人是同一个网关既发对话又发声，
 * 让他们重贴一次 Key 只会有人在这儿留个空、然后撞上 401。只做对话的服务商没有音频端点，
 * 这时把配音指到另一家、单独填一把 Key 才是正路，所以这两项也允许独立填。
 * 模型和音色**不回落**——`/v1/audio/speech` 收的是配音模型 id，拿 chat 模型去调必然 400；
 * 而填 tts-1 还是 CosyVoice 由服务商决定，静默替用户猜一个只会把「配置没填」
 * 变成一条看不出所以然的 404/400，宁可让调用方报「还没填」。
 * 本地档：Key、接口地址、模型名三样都不参与（`voice` 这时是 sid），
 * 所以这里回的是一个「按档取过值」的配置，而不是把六个字段原样摊给调用方——
 * 每个调用点自己判断哪档该问哪些字段，就是 #220/#227 那种「判松判严都拦错人」的源头。
 */
export async function getTTSConfig(): Promise<{
  engine: TtsEngineMode
  apiKey: string
  apiBase: string
  model: string
  voice: string
  localEngine: LocalTtsEngineId
}> {
  const settings = await loadSettings()
  const engine = normalizeTtsEngine(settings.ttsEngine)
  return {
    engine,
    apiKey: settings.ttsApiKey || settings.aiApiKey,
    apiBase:
      normalizeApiBase(settings.ttsApiBase) ||
      normalizeApiBase(settings.aiApiBase) ||
      'https://api.openai.com',
    model: settings.ttsModel,
    voice: engine === 'local' ? normalizeLocalVoice(settings.ttsLocalVoice) : settings.ttsVoice,
    localEngine: normalizeLocalTtsEngine(settings.ttsLocalEngine),
  }
}
