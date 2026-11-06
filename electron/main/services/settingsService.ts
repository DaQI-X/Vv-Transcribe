/**
 * 设置持久化服务
 * 主进程里唯一读写 settings.json 的地方：读盘并分诊、按本机密钥库加解密、把配置交给转写/校对/配音。
 * 支持内存缓存，避免重复读取磁盘。
 *
 * 磁盘形状和对外形状是两件事，这一层刻意把它们分开：
 * - 磁盘上（配置格式 v2，1.0.9 起）按能力存三份**云端方案**列表（profiles.asr / ai / tts）
 *   加一个 defaultProfileId，其余没进方案的键平铺在文档根上（内存里叫 store.globals），
 *   形状与迁移都在 settingsSchema。
 * - 对外的 AppSettings 仍是那批扁平键（1.1.1 起多了 `ttsProvider` / `asrVendor` 两个厂商书签），
 *   含义是「全局段 + 这一档当前那条方案的投影」。
 *   这么分的理由是增量落地：转写、校对、配音的取值点，设置表单，preload 与 IPC 全都按
 *   扁平字段读，先把内部形状换成方案列表、契约不动，界面那一半才不用跟着返工（#222 第①步）。
 *   第②步把 profileId 接到了 getter 与增删改上（#222 第②步）：外面那套字段名仍然没改，
 *   只是每处取值多了「按哪个 id 取」这一问——缺省都是该档当前默认方案，与第①步的行为一致。
 * - 一条方案都可以没有（#222 新口径）：这一档的列表是空的、defaultProfileId 是空串，
 *   投影出来的凭据就是默认值（＝没填）。转写选「云端优先」而一条方案都没建过时，
 *   界面说的是「先新建一套」，不是「你的 Key 丢了」。
 *
 * API Key 单独说：磁盘上方案里的 apiKey 走系统的 safeStorage（macOS Keychain /
 * Windows DPAPI）加密后写入，值形如 `v1:<base64>`。没有前缀的按历史明文处理——首次读到且本机
 * 能加密就就地换掉。safeStorage 不可用时退回明文并让界面说清楚（见 getSettingsView 的
 * keyEncryptionAvailable）。明文不进渲染进程：给界面的一律是脱敏视图，只有主进程拿得到解密结果。
 * 一条规矩贯穿全部改动：方案搬家时密钥原样搬运，绝不重新加密——重新加密会把「能不能解密」
 * 变成「换过机器」，用户看到的就是「我填过的 Key 没了」，而那是不可恢复的谎报。
 */
import { safeStorage } from 'electron'
import { rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { logger } from './logger'
import { normalizeLocalTtsEngine, type LocalTtsEngineId } from './localTtsEngine'
import { normalizeTtsVendor, ttsVendorNeedsVoice, type TtsVendorId } from './ttsVendor'
import { normalizeAsrVendor } from './asr/asrVendor'
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
  CAPABILITY_FIELDS,
  CURRENT_SETTINGS_VERSION,
  CURRENT_SETTINGS_VERSION_FIELD,
  DEFAULT_PROFILE_ID_FIELD,
  DEFAULT_PROFILE_IDS,
  DEFAULT_PROFILE_NAME,
  MAX_PROFILES_PER_CAPABILITY,
  PROFILE_CAPABILITIES,
  PROFILE_FIELDS_MOVED_TO_GLOBALS,
  PROFILES_FIELD,
  migrateSettingsDocument,
  type DefaultProfileId,
  type Profile,
  type ProfileCapability,
  type SettingsDocument,
  type SettingsGlobals,
  type SettingsProfiles,
  type SettingsStore,
} from './settingsSchema'

/**
 * 对外的扁平配置：一项能力当前选用那套方案的投影。
 * 键名与 v1 时代磁盘上的扁平键一致，所以转写/校对/配音那几处取值点不用动。
 */
export interface AppSettings {
  asrProvider: string
  /**
   * 云端转写去哪家网关（1.1.1，#224 转写侧）。和上面那一项**不是一回事**：
   * `asrProvider` 是「走不走云端」，`asrVendor` 是「走云端时发成哪一家的形状」。
   * 名字没法统一（前者从 1.0.5 就叫这个了），取值点各自看清自己在问哪一项。
   * 它跟着方案走，这里的默认值只在「这一档还没建过方案」时投出来——那时按 OpenAI 兼容发，
   * 也就是 1.1.1 之前唯一的形状。
   */
  asrVendor: string
  asrApiKey: string
  asrApiBase: string
  asrModel: string
  /**
   * 讯飞那一档要的第二、第三把凭据（1.1.2，#343）。只有这一家用得上：它的签名要
   * AppID + APIKey + APISecret 三样一起才算得出来，缺任何一样都发不出请求。
   * 走 multipart 的那几家（OpenAI 兼容、MiniMax）读不到这两项，界面上也按厂商不画这两格。
   *
   * AppID 不是凭据（它出现在签名参数里、也要拼进 URL），所以走明文格；
   * APISecret 只用来算 HMAC、**从不作为参数发出去**，与 APIKey 同一条 safeStorage 通道。
   * 两格都跟着方案走，与 `ttsResourceId` 一样：老方案磁盘上没有，读出来是空串，不需要一次迁移。
   */
  asrAppId: string
  asrApiSecret: string
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
   * 1.1.1 起再加一项 provider：它决定这趟请求长成哪家的形状（路径 / 字段名 / 音频编码），
   * 见 ttsVendor。老方案磁盘上没有这一项，读出来是空串，取值时按 OpenAI 兼容处理。
   */
  ttsProvider: string
  ttsApiBase: string
  ttsApiKey: string
  ttsModel: string
  /**
   * 那一家「账号买的是哪一版服务」的编号（1.1.2，#342 豆包配音）。它不是模型名也不是密钥：
   * 豆包 v3 把它写在请求头 `X-Api-Resource-Id`（标准音色与复刻音色是两条不同的编号），
   * 而模型格已经装了 `req_params.model`，一格说两件事会让同一格在两家之间换意思。
   * 只有豆包读它，其余厂商在请求里不看这一项；界面上按厂商出现，不是豆包时那一格根本不画。
   * 转写那一档没有同一格：收它的只有豆包转写，而豆包转写本版不接（理由见 `asr/asrVendor.ts` 抬头）。
   */
  ttsResourceId: string
  /**
   * 云端档的音色名。1.1.0 起它不在方案里——那是「这一批怎么念」的问题，不是「这家网关有什么」的问题；
   * 现在也没有任何界面写它：配音页那一格是单次覆盖，这一份存的是旧版留下的默认音色，
   * 界面没选时按它走，它本身也空着就干脆不发 voice 这一项（有的模型不收）。
   */
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
type SecretField = 'asrApiKey' | 'asrApiSecret' | 'aiApiKey' | 'ttsApiKey'
const SECRET_FIELDS: SecretField[] = ['asrApiKey', 'asrApiSecret', 'aiApiKey', 'ttsApiKey']

/**
 * 方案字段里哪几格算凭据（走 safeStorage、跨 IPC 只给状态位、保存时「留空＝不改」）。
 *
 * 按**字段名**列而不是按「哪一档」列：`apiSecret` 此刻只有转写档用得上（讯飞那一家的签名
 * 要 AppID + APIKey + APISecret 三把，1.1.2 #343），另两档的方案里根本不会出现这一格，
 * 所以「这一档有哪几项」仍然只由 CAPABILITY_FIELDS 说了算，这里只回答「这一格要不要封起来」。
 * 少一张按档列的表，就少一处「加了一档凭据、忘了在另一张表里登记」的分叉。
 */
const SECRET_PROFILE_FIELDS: readonly string[] = ['apiKey', 'apiSecret']

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
  /**
   * 转写档那第二把凭据（APISecret）的状态。只有讯飞用得上，另两档没有这一格——
   * 所以它不跟上面那三个并列命名成 `asrApiSecretStatus`：那会让人以为校对/配音也该有一个。
   */
  asrSecretStatus: SecretStatus
  keyEncryptionAvailable: boolean
  /**
   * 这份配置是怎么来的：null＝正常读到了磁盘上的配置；非 null＝磁盘那份没读出来，
   * 界面必须把它当成「出问题了」而不是「用户还没填」。文案见 describeLoadProblem。
   */
  storageProblem: string | null
}

/**
 * 界面上的一条方案（脱敏）。`values` 的键名是**界面上那套扁平名**（asrApiBase / ttsLocalEngine / …），
 * 不是磁盘上的字段名（apiBase / localEngine）：表单状态、getSettings 的脱敏视图、保存补丁说的
 * 都是扁平名这一套，这里换成磁盘名就等于让渲染层再抄一份字段对照表——那张表一旦和
 * CAPABILITY_FIELDS 分叉，「界面显示 A、存进去的是 B」就又回来了。
 * 每档给哪几项也取自那张表：转写此刻只有凭据三项，模式/档位/语言是全局段，不在任何一条方案里。
 * apiKey 一律不在这里——跨 IPC 只带状态位，与 SettingsView 同一个规矩。
 */
export interface ProfileView {
  id: string
  name: string
  values: Record<string, string>
  keyStatus: SecretStatus
  /**
   * 这一档除 apiKey 之外还封着的凭据在界面上的状态，键是**扁平名**（此刻只有转写档的
   * `asrApiSecret`，讯飞要三把）。没有这一格的档就是空对象。
   * 为什么不并进 keyStatus：三档的列表行与编辑弹窗都在读 keyStatus 说「Key 存没存」，
   * 把它摊成一张按档不同的表，等于让另两档凭空多一层要读的东西。
   */
  secretStatus: Record<string, SecretStatus>
}

/**
 * 三档的方案列表 + 每档当前选哪条 + 上限，一次给全：界面不用为「第几条是不是默认」再问一次。
 * 某一档的数组可以是空的（还没建过云端方案），此时该档的 defaultProfileId 是空串——
 * 界面要的是「0 配置」这句话，不是把空列表演成「有一条但读不出来」。
 */
export interface ProfilesView {
  profiles: Record<ProfileCapability, ProfileView[]>
  defaultProfileId: DefaultProfileId
  maxProfiles: number
  /** 与 SettingsView.storageProblem 同一个来源：增删改也要说得出「这份配置本来就没读出来」 */
  storageProblem: string | null
}

/**
 * 「保存」能接受的补丁形状。密钥单独摊出来写，是为了让 null（清除）真的能通过类型检查：
 * `Partial<AppSettings> & Partial<Record<SecretField, string | null>>` 这种交叉类型里，
 * 同名属性会被求交收成 `string | undefined`，null 直接判不兼容——于是调用方只能传 ''，
 * 而 '' 的语义是「不改」，传下去就是把用户的 Key 留着不删。界面那个「清除 Key」按钮
 * 走的是同一条 IPC，写错一次就是当着用户的面把配置改了却没删掉他以为删掉的东西。
 * handlers 与 preload 都引用这个类型，别再各写一遍。
 *
 * `profileIds` 是第②步加的：这份补丁写进哪几条方案，缺省＝各档当前默认方案（就是第①步
 * 的行为）。传了 id 却指不到人时是**报错**而不是落回默认——静默写到默认那条会吃掉用户
 * 另一套配置，而那是他没碰过的那一条。
 *
 * `defaultProfileIds` 是重写这版加的：界面上那颗「是否默认」开关在**编辑表单里**翻，
 * 跟着「保存设置」一起落盘，所以保存要能顺带改指针。每档只给一个值，互斥是结构保证的
 * （磁盘上就一个 defaultProfileId）；给空串＝明确「这一档现在没有正在使用的方案」，
 * 给一个指不到人的 id 是报错。
 *
 * handlers 与 preload 都引用这个类型，别再各写一遍。
 */
export type SettingsPatch = Partial<Omit<AppSettings, SecretField>> &
  Partial<Record<SecretField, string | null>> & {
    profileIds?: Partial<DefaultProfileId>
    defaultProfileIds?: Partial<DefaultProfileId>
  }

const DEFAULT_SETTINGS: AppSettings = {
  asrProvider: 'local',
  asrVendor: 'openai',
  asrApiKey: '',
  asrApiBase: '',
  asrModel: '',
  asrAppId: '',
  asrApiSecret: '',
  asrLocalModel: 'base',
  asrLanguage: 'zh',
  aiProvider: 'openai',
  aiApiKey: '',
  aiApiBase: '',
  aiModel: '',
  ttsProvider: 'openai',
  ttsApiBase: '',
  ttsApiKey: '',
  ttsModel: '',
  // 空串＝不发这一项；豆包那一支自己落回文档里的固定值（见 ttsVendor 的默认资源编号）
  ttsResourceId: '',
  ttsVoice: '',
  ttsEngine: 'cloud',
  // 空串＝还没选过，取值时落回中文默认档（见 normalizeLocalTtsEngine）
  ttsLocalEngine: '',
  // 空串同上：VITS 与 Kokoro 的 sid0 都是各自那档里推荐的那个音色
  ttsLocalVoice: '',
}

/**
 * 全局段的键＝DEFAULT_SETTINGS 里那些**没被 CAPABILITY_FIELDS 认领**的扁平键。
 * 从两张表推出来而不是在这里再列一遍：那张表是「哪一档有哪几项」唯一的事实来源，
 * 这里抄一份就会出现「asr 已经把 provider 退回全局、全局段还当它是方案字段」这种分叉，
 * 而分叉的方向是把用户填过的值写进一个没人读的位置——读得到、写进去、东西没了。
 * 此刻是 asrProvider / asrLocalModel / asrLanguage / ttsEngine / ttsLocalEngine / ttsLocalVoice
 * / ttsVoice 七个（三档方案收窄到只剩网关参数之后，「走不走云端」「本地档位」「本地音色编号」
 * 都在这；配音音色从 v3 起也回到这里——它是这一批怎么选的问题，不是这家网关的参数）。
 */
const GLOBAL_FLAT_KEYS: readonly string[] = (() => {
  const claimed = new Set<string>()
  for (const cap of PROFILE_CAPABILITIES) {
    for (const [flatKey] of CAPABILITY_FIELDS[cap]) claimed.add(flatKey)
  }
  return Object.keys(DEFAULT_SETTINGS).filter((flatKey) => !claimed.has(flatKey))
})()

/** 全局段该长什么样（首次运行、以及读盘收口时的落点）：逐项取 DEFAULT_SETTINGS */
function defaultGlobals(): SettingsGlobals {
  const globals: SettingsGlobals = {}
  for (const flatKey of GLOBAL_FLAT_KEYS) {
    globals[flatKey] = DEFAULT_SETTINGS[flatKey as keyof AppSettings]
  }
  return globals
}

/** 一条方案里那几格封过的凭据：键是方案字段名，值同时带明文与它给界面看的状态 */
type ProfileSecrets = Record<string, { value: string; status: SecretStatus }>

/**
 * 一份缓存两样用途：raw 是磁盘上该原样写回的样子（全局段 + 方案列表，密文不动它），
 * secrets 是按「能力 + 方案 id + 方案字段」索引的一张查找表——解密后的凭据和它的状态。
 *
 * 为什么不干脆再存一份「解密后的方案列表」：那要把整个 store 深拷贝一遍，而两处列表
 * 迟早会分叉（就地加密改一处、保存改另一处）。凭据是唯一需要解密的字段，把它单独摊成
 * 一张表，「谁被解过、解成什么状态」就只有一份事实；其余字段本来就是明文，读 raw 即可。
 * 每次解密都要过一遍系统密钥库，所以按进程缓存，不在每次取配置时重解。
 *
 * 这一张表原来是 `plain` + `status` 两张（一条方案只有一格凭据时够用）；讯飞那一档要第二格
 * 之后合成一张，是因为两张表的键完全一样、只差一个字段维度——分成两张就会出现
 * 「解出来的是 A 的明文、状态说的是 B 的」这种编译期管不住的错配。
 */
interface SettingsCache {
  raw: SettingsStore
  /**
   * [能力][方案 id][方案字段] → 解出来的明文与它的状态。
   * 键是**方案字段名**（apiKey / apiSecret），一条方案此刻最多两格；
   * 缺项即「这条方案没有这一格」（老方案里没有 apiSecret 就是这一种）。
   */
  secrets: Record<ProfileCapability, Record<string, ProfileSecrets>>
  /** 磁盘上有没有需要就地加密的历史明文（任何一条方案里的都算） */
  migrated: boolean
}

/** 凭据查找表的空壳：buildCache 往里逐项填，缺项即「这条方案不存在」或「没有这一格」 */
function emptySecrets(): Record<ProfileCapability, Record<string, ProfileSecrets>> {
  const secrets = {} as Record<ProfileCapability, Record<string, ProfileSecrets>>
  for (const cap of PROFILE_CAPABILITIES) secrets[cap] = {}
  return secrets
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

/**
 * 动手改配置之前先问一次闸门，和 writeRaw 里那句是同一个条件、两处都要：
 * writeRaw 那句保证「无论如何都写不出去」，这一句保证**报的是真原因**。
 * 读失败时内存里那份是默认 store（三档都空），于是界面拿着的每一个方案 id 都「指不到人」——
 * 不先拦这一步，用户看到的是「配音配置里已经没有这套方案了（可能在别处被删掉）」，
 * 而真相是文件压根没读出来。让他去找一把自己没删过的 Key，是我们把话说错了。
 *
 * 调用点必须在 `await readCache()` 之后：闸门是那次读盘读出来才立起来的，
 * 放在读之前看到的一律是 false，这道检查就成了空动作。
 */
function rejectIfWriteBlocked(): void {
  if (writeBlocked) throw new SettingsWriteBlockedError(writeBlockedMessage())
}

/**
 * 方案本身的规矩没守住（到了上限、id 指不到人、要删的是最后一条、名字空）。
 * 与 SettingsWriteBlockedError 分开建类：那一条的意思是「磁盘现在不能碰」，
 * 这一条的意思是「你这个操作本身不成立」，界面给的出路完全不同——
 * 前者让人去查数据目录或更新应用，后者只是把按钮按回去。
 * 消息都是给人看的一句话，IPC 处理器原样透成 toast。
 */
export class SettingsProfileRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettingsProfileRuleError'
  }
}

/** 三档在界面话术里的名字；只在给用户看的句子里出现，与设置页那三个 tab 的口径一致 */
const CAPABILITY_LABEL: Record<ProfileCapability, string> = {
  asr: '转写配置',
  ai: '校对配置',
  tts: '配音配置',
}

/** 到了上限那句（第③步的「新建方案」按钮与这里的判断共用一句话，别各写一份） */
export const PROFILE_LIMIT_MESSAGE = `每一类配置最多 ${MAX_PROFILES_PER_CAPABILITY} 套，先删掉一套再新建`

/**
 * 这一档一条方案都没有，补丁里却带着要写进方案的凭据。
 * 不自动替他建一条：刚删光方案的人下一步点保存，如果保存又把那条建回来，删掉的到底是什么
 * 就没人说得清了。出路界面上已经摆着——那颗「新建API接入」。
 *
 * 从第⑧步起三档的凭据都只住在小弹窗里、由弹窗自己那颗「保存」落盘（新建走 `createProfile`，
 * 编辑走 `settings:save` 且一定带着那条的 id——id 指不到人另有那句「已经没有这套方案」），
 * 右下角「保存设置」送的只有全局段，所以界面正常操作走不到这里。它现在是主进程侧的一条不变量：
 * 任何绕过弹窗往 `settings:save` 塞凭据的调用（手改文件之外的新入口、测试直连）都得先建一条。
 */
export const PROFILE_CREATE_FIRST_MESSAGE =
  '这一类现在还没有任何配置方案，这几项没地方可存。请点这一类的「新建API接入」，在弹窗里填好那几格再点弹窗里的「保存」'

/**
 * 界面传回来的 id 指不到人。多半是另一扇窗刚删了这条方案，不能把它当成「写默认那条」。
 * 句子里不带那个 id：`asr-1a2b3c4d` 这种内部编号出现在 toast 上只是噪声，
 * 而 guard 那层已经按通道记了失败原因，排查要看的是通道名不是号。
 */
function profileMissingMessage(cap: ProfileCapability): string {
  return `${CAPABILITY_LABEL[cap]}里已经没有这套方案了（可能在别处被删掉），请重新选一次`
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

/**
 * 密文解不开时不能把「解不开」当成「没配」，否则用户会去重填一个本来就对的 Key。
 * 方案列表里每一条都要单独解、单独记状态：一条方案的 Key 换过机器不代表另一条也是，
 * 界面（第③④步）按 (能力, 方案 id) 显示的就是这里的 status。
 */
function buildCache(raw: SettingsStore): SettingsCache {
  const secrets = emptySecrets()
  let migrated = false
  for (const cap of PROFILE_CAPABILITIES) {
    for (const profile of raw.profiles[cap]) {
      const entry: ProfileSecrets = {}
      for (const field of SECRET_PROFILE_FIELDS) {
        const stored = profile[field]
        // 这一格在这条方案里根本不存在时（老方案没有 apiSecret）不建条目：建一个
        // status='none' 的空壳和「确实没填」在界面上分不出来，而缺项才是真话
        if (typeof stored !== 'string' || !stored) continue
        const { value, status } = unseal(stored)
        entry[field] = { value, status }
        if (status === 'plaintext') migrated = true
      }
      secrets[cap][profile.id] = entry
    }
  }
  return { raw, secrets, migrated }
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
async function writeRaw(store: SettingsStore): Promise<void> {
  if (writeBlocked) {
    throw new SettingsWriteBlockedError(writeBlockedMessage())
  }
  await atomicWriteJson(
    settingsFile(),
    {
      [CURRENT_SETTINGS_VERSION_FIELD]: CURRENT_SETTINGS_VERSION,
      // 全局段平铺在根上（键名来自 GLOBAL_FLAT_KEYS 那份白名单，所以这里不会冒出
      // 一个恰好叫 profiles / schemaVersion 的键把下面两段盖掉）；顺序把它放在两段之前，
      // 真撞名时也是磁盘上那两个 v2 段落赢。
      ...store.globals,
      [PROFILES_FIELD]: store.profiles,
      [DEFAULT_PROFILE_ID_FIELD]: store.defaultProfileId,
    },
    {
      backup: true,
      // 备份没成不阻断这次保存（原子写才是主菜），但也不能悄悄过去：
      // 日后要找上一版时，日志里这一行解释为什么没有 .bak。
      onBackupFailure: (detail) =>
        logger.warn('Settings', 'Backing up previous settings failed', detail),
    }
  )
  cache = buildCache(store)
}

/**
 * 读到历史明文且本机现在能加密 → 立刻就地加密回写；写成功才认「已迁移」。
 * 在副本上做：失败时（闸门、磁盘故障）内存里那份还是原样，不会留下「半加密」的状态。
 */
async function migratePlainKeys(store: SettingsStore): Promise<void> {
  if (!encryptionAvailable()) return
  const sealed = cloneStore(store)
  for (const cap of PROFILE_CAPABILITIES) {
    for (const profile of sealed.profiles[cap]) {
      for (const field of SECRET_PROFILE_FIELDS) {
        const stored = profile[field]
        if (typeof stored === 'string' && stored && !stored.startsWith(ENC_PREFIX)) {
          profile[field] = seal(stored)
        }
      }
    }
  }
  await writeRaw(sealed)
}

/** 磁盘上任何一段都可能是 null、字符串或数组：这一句把「不是对象」统一收成空对象 */
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * 一条全新的默认方案：id / name 用生产那对常量，业务字段逐个落回 DEFAULT_SETTINGS。
 * 字段只按 CAPABILITY_FIELDS 那张表写，所以「这一档有哪几项」加一项时不用改这里
 * （凭据除外：它的默认值不在这里猜，只从磁盘那一份来）。
 */
function defaultProfileFor(cap: ProfileCapability): Profile {
  const profile: Profile = { id: DEFAULT_PROFILE_IDS[cap], name: DEFAULT_PROFILE_NAME, apiKey: '' }
  for (const [flatKey, field] of CAPABILITY_FIELDS[cap]) {
    if (SECRET_PROFILE_FIELDS.includes(field)) continue
    profile[field] = DEFAULT_SETTINGS[flatKey as keyof AppSettings]
  }
  return profile
}

/**
 * 首次运行、以及「读盘失败退回默认配置」用的那份。
 *
 * 三档都是**空列表**：一条方案都没建过时，界面要给的正是那颗「新建API接入」，
 * 而不是一条空凭据的方案占着列表（#222 新口径里的 0 配置）。以前校对/配音各留一条
 * 「默认」方案是为了喂老那套「设为当前使用」交互——它们的界面换成同一个列表之后，
 * 那条凭空出现的空方案就只剩副作用：界面上多一行没填过的东西，而 `getAIConfig` 拿到的
 * 是「有一条方案、但地址和 Key 都空」，报错话术比「一条都没有」更难指路。
 * 全局段照 DEFAULT_SETTINGS 起步：转写模式与配音引擎都默认本地/云端各自的默认值，
 * 空列表不影响「本地转写 + 本地校对」这条零配置的路能走。
 */
function defaultStore(): SettingsStore {
  const profiles = {} as SettingsProfiles
  const defaultProfileId = {} as DefaultProfileId
  for (const cap of PROFILE_CAPABILITIES) {
    profiles[cap] = []
    defaultProfileId[cap] = ''
  }
  return { globals: defaultGlobals(), profiles, defaultProfileId }
}

/** 逐条浅拷贝：方案字段全是字符串，一层就够；深拷贝会把不存在的对象形状也猜出来 */
function cloneStore(store: SettingsStore): SettingsStore {
  const profiles = {} as SettingsProfiles
  for (const cap of PROFILE_CAPABILITIES) {
    profiles[cap] = store.profiles[cap].map((profile) => ({ ...profile }))
  }
  return {
    globals: { ...store.globals },
    profiles,
    defaultProfileId: { ...store.defaultProfileId },
  }
}

/**
 * 「这一档的当前使用该写谁」——读盘收口与每条增删改写盘前共用这一句，两处的规则不许分叉。
 *
 * - 列表空 → 空串。没有可指的方案，硬指一条等于凭空造配置。
 * - id 指得到人 → 原样。
 * - id 指不到人（缺失、被删、手写坏）→ 空串。
 *   用户删掉「当前使用」那条之后，界面和 readiness 会直接说「现在没有正在使用的方案」，
 *   让应用悄悄换成列表里排第一的那条等于替他选了家网关，而下一次花的钱是按那条网关计价的。
 *   原来这里给校对/配音留过「落回第一条」的兜底，因为那时它们的凭据取值没有别的路解释
 *   「没选」；那两档换成同一个列表口径之后，兜底就成了唯一的分叉，所以删了。
 */
function fixDefaultId(list: Profile[], wanted: string): string {
  if (list.length === 0) return ''
  return list.some((profile) => profile.id === wanted) ? wanted : ''
}

/**
 * 这一档当前选用的那条方案（没指定 id 时的落点）。列表真的可以是空——云端模式下还没建过任何
 * 方案，那时返回 null，投出来的凭据落回默认值（＝没填）而不是随便抓一条。
 * defaultProfileId 是空串时也走 null：上面那句 fixDefaultId 保证了「要么指得到人、要么是空串」，
 * 所以这里不再需要「找不到就抓第一条」那种兜底——那种兜底会把「用户明确不要当前使用这条」
 * 读成「用列表里第一个」，而那正是新口径要禁掉的猜测。
 */
function pickDefault(store: SettingsStore, cap: ProfileCapability): Profile | null {
  return store.profiles[cap].find((profile) => profile.id === store.defaultProfileId[cap]) ?? null
}

/**
 * 按 id 取这一档的一条方案；id 空或指不到人时落回该档当前默认方案（可能是 null）。
 * 落回而不是报错是给「干活那条路」用的：界面传回来的 id 可能刚被另一扇窗删掉，
 * 这时候把手上那次转写打断，比「用你当前选着的那套跑完」更糟。
 * 所以要知道实际用的是哪一条，读返回值的 id 或调 resolveProfileId，别信传进来的那个。
 */
function pickProfile(
  store: SettingsStore,
  cap: ProfileCapability,
  profileId?: string | null
): Profile | null {
  const wanted = (profileId ?? '').trim()
  if (!wanted) return pickDefault(store, cap)
  return store.profiles[cap].find((profile) => profile.id === wanted) ?? pickDefault(store, cap)
}

/** 增删改写的那条：id 指不到人就是操作本身不成立，绝不静默落到默认那条上去 */
function mustFindProfile(store: SettingsStore, cap: ProfileCapability, profileId: string): Profile {
  const found = store.profiles[cap].find((profile) => profile.id === profileId)
  if (!found) throw new SettingsProfileRuleError(profileMissingMessage(cap))
  return found
}

/**
 * 这次取值实际会落到哪条方案上（与 pickProfile 同一条规则，单独问一次而已）。
 * 历史记录要按档记下这个 id（#247），日志与 readiness 也用它——用传进来的那个会记错，
 * 因为未知 id 已经落回默认了。
 *
 * 空串＝这次没有任何方案在用（这一档一条都没建过，或当前使用那条刚被删掉）。
 * 调用方要把它当成一个真状态：日志里就落 `profileId: ''`，别补一个看起来像 id 的词。
 */
export async function resolveProfileId(
  cap: ProfileCapability,
  profileId?: string | null
): Promise<string> {
  return pickProfile((await readCache()).raw, cap, profileId)?.id ?? ''
}

/** 新方案的 id：随机一段而不是「第几条」。删掉中间那条后按序号编会复用老 id，而历史记录是按 id 认的 */
function freshProfileId(cap: ProfileCapability, taken: Set<string>): string {
  let id = ''
  do {
    id = `${cap}-${randomUUID().slice(0, 8)}`
  } while (taken.has(id))
  return id
}

/** 没起名时给一个不重样的默认名：方案 1、方案 2……（转写这一档从 0 条起步，第一条就叫「方案 1」） */
function nextProfileName(cap: ProfileCapability, list: Profile[]): string {
  const used = new Set(list.map((profile) => profile.name))
  for (let n = 1; n <= MAX_PROFILES_PER_CAPABILITY; n += 1) {
    const candidate = `方案 ${n}`
    if (!used.has(candidate)) return candidate
  }
  return `方案 ${list.length + 1}-${cap}`
}

/**
 * 收口磁盘上的一条方案：id 必须是能拿来指人的非空字符串，其余逐项按默认值收，
 * 只认表里列得出的键——界面上多带的状态位、手改出来的非字符串值、旧版本残留的扁平键，
 * 都不该原样留在配置里。
 */
function normalizeProfile(cap: ProfileCapability, entry: unknown): Profile | null {
  const src = asObject(entry)
  // 没有 id 的方案没法被 defaultProfileId 指到，也没法被历史记录引用（#247 按 id 记），
  // 所以不收；现编一个号反而会造出两条看起来一样、实际不同的方案
  if (typeof src.id !== 'string' || !src.id) return null
  const profile = defaultProfileFor(cap)
  profile.id = src.id
  if (typeof src.name === 'string' && src.name) profile.name = src.name
  for (const [, field] of CAPABILITY_FIELDS[cap]) {
    const value = src[field]
    if (typeof value === 'string') profile[field] = value
  }
  return profile
}

/**
 * 全局段从文档根上读：只认 GLOBAL_FLAT_KEYS 里那几个名字，且只收字符串。
 * 所以手改文件里多出来的怪键、以及已经被方案认领的那批扁平键（`asrApiBase` 这种残影）
 * 都不会进内存，下一次 writeRaw 也就不会把它们再写回去——磁盘上那份文件里躺着的
 * 是「这个版本认得的配置」，不是原文件的副本。
 */
function normalizeGlobals(doc: SettingsDocument): SettingsGlobals {
  const globals = defaultGlobals()
  for (const flatKey of GLOBAL_FLAT_KEYS) {
    const value = doc[flatKey]
    if (typeof value === 'string') globals[flatKey] = value
  }
  return globals
}

/**
 * 中途从方案挪回全局段的那几个字段（表在 settingsSchema 的 PROFILE_FIELDS_MOVED_TO_GLOBALS）：
 * 读盘时先把值升回文档根，再由 normalizeGlobals 收进全局段。
 *
 * 这一步只在开发机上有效力，但它守的是那条不许破的承诺：v2 中途换过一次归属，而版本戳没换
 * （这一版从没发到用户手上），同一台机器上的 settings.json 可能还是「引擎/档位/语言躺在方案里」
 * 那副形状。按新表收口等于把这些字段当没认出来的怪键扔掉——用户填过的「配音引擎＝本地」
 * 读得到、写成功、东西没了。升回根上之后，方案里那份残留因为不在表里，下一次 writeRaw 自然不再写它。
 *
 * 两条取舍：
 * - 根上已经有个字符串就不接管。根上那份是新形状写出来的，方案里的是旧形状，谁的年代新用谁的。
 * - donor 用「当前使用」那条，指不到人就用列表第一条。多条方案各自带着不同的引擎值时，
 *   新口径下这个值本来就不属于方案——按正在用的那条走是唯一不猜的理由。
 */
function hoistRelocatedFields(
  doc: SettingsDocument,
  rawProfiles: Record<string, unknown>,
  rawIds: Record<string, unknown>
): SettingsDocument {
  let next = doc
  for (const [cap, field, flatKey] of PROFILE_FIELDS_MOVED_TO_GLOBALS) {
    if (typeof next[flatKey] === 'string') continue
    const entries = Array.isArray(rawProfiles[cap]) ? rawProfiles[cap] : []
    const wanted = typeof rawIds[cap] === 'string' ? rawIds[cap] : ''
    const donor = asObject(entries.find((entry) => asObject(entry).id === wanted) ?? entries[0])
    const value = donor[field]
    if (typeof value !== 'string' || !value) continue
    next = { ...next, [flatKey]: value }
  }
  return next
}

/**
 * 把迁移过的文档落成 SettingsStore。
 *
 * 这一层存在的理由就写在名字里：v1 时代的读盘收口「只收字符串」，而方案列表是对象数组——
 * 照那份写法读 v2 的文件会「读成功、写成功、东西没了」，用户的多套配置静默消失。
 * 所以列表要单独按形状收，并且收完自己站得住：defaultProfileId 要么指得到人、要么是空串
 * （空串＝这一档现在没有正在使用的方案）。列表本身可以空，那是「还没建过云端方案」的正常状态。
 */
function normalizeStore(doc: SettingsDocument): SettingsStore {
  const profiles = {} as SettingsProfiles
  const defaultProfileId = {} as DefaultProfileId
  const src = asObject(doc[PROFILES_FIELD])
  const ids = asObject(doc[DEFAULT_PROFILE_ID_FIELD])
  // 先升字段再收口：normalizeProfile 只认表里那几项，方案里的旧字段一旦被它接手就没了
  const docForGlobals = hoistRelocatedFields(doc, src, ids)
  for (const cap of PROFILE_CAPABILITIES) {
    const entries = Array.isArray(src[cap]) ? src[cap] : []
    const list: Profile[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      const profile = normalizeProfile(cap, entry)
      if (!profile) continue
      // 两条同 id 会被 defaultProfileId 与历史记录（#247 按 id 记）认成同一条，更要命的是
      // 密钥查找表按 id 索引——buildCache 里后写的那条会盖掉先写的，于是「A 方案的表单
      // 配着 B 方案的 Key」。撞号时给后一条换个新 id 而不是丢掉它：那是用户填过的东西，
      // 出现撞号最像是手改文件时把整段复制粘贴了一遍
      if (seen.has(profile.id)) profile.id = freshProfileId(cap, seen)
      seen.add(profile.id)
      list.push(profile)
    }
    // 一条都没收到（整段缺失、写成字符串、每条都没 id）就留空列表，**不补一条默认方案**：
    // 那是凭空造出一条用户没建过的配置，而新口径下「0 条」正是界面要说清楚的那个状态。
    //
    // 这里刻意**不按 MAX_PROFILES_PER_CAPABILITY 剪**：那个数是产品上限，只在写入侧拦新建
    // （createProfile），读侧剪掉就是「读成功、写成功、东西没了」——破的是「绝不静默丢用户
    // 的东西」。手改文件里有 5 条就照 5 条读，界面上多出来的那几条照样能选、能删。
    profiles[cap] = list
    defaultProfileId[cap] = fixDefaultId(list, typeof ids[cap] === 'string' ? ids[cap] : '')
  }
  return { globals: normalizeGlobals(docForGlobals), profiles, defaultProfileId }
}

/**
 * 「这次按哪几条方案」：三档各一个可选 id，缺席＝该档当前默认方案。
 * 界面在还没长出方案选择器时传空对象/undefined，拿到的就是第①步的行为。
 */
export type ProfileSelection = Partial<DefaultProfileId>

/**
 * store 投成对外那批扁平键：全局段原样铺上，每档再按 selection 取一条方案盖上去
 * （取不到落回该档当前默认，那条也没有就留默认值）。密钥按它的 id 从解密表里取。
 * 这是「磁盘形状」与「对外契约」唯一的交界处——别处再各自拼 store 就会出现
 * 「转写读默认方案、界面读第一条」这种两边不一致的分歧。
 *
 * 某一档没有方案时那几项**留空**而不是猜一条：转写选云端却还没建过方案，投出来的
 * apiBase/model 就是空，readiness 那句「先新建一套」才有东西可判。
 */
function flattenFor(current: SettingsCache, selection?: ProfileSelection): AppSettings {
  const out: AppSettings = { ...DEFAULT_SETTINGS, ...current.raw.globals }
  for (const cap of PROFILE_CAPABILITIES) {
    const profile = pickProfile(current.raw, cap, selection?.[cap])
    if (!profile) continue
    for (const [flatKey, field] of CAPABILITY_FIELDS[cap]) {
      const value = SECRET_PROFILE_FIELDS.includes(field)
        ? current.secrets[cap][profile.id]?.[field]?.value
        : profile[field]
      out[flatKey as keyof AppSettings] = typeof value === 'string' ? value : ''
    }
  }
  return out
}

/** 某个 id（缺省＝该档默认方案）那一格凭据在界面上的状态：视图里那几个 `*Status` 取自这里 */
function secretStatusFor(
  current: SettingsCache,
  cap: ProfileCapability,
  field: string,
  selection?: ProfileSelection
): SecretStatus {
  const profile = pickProfile(current.raw, cap, selection?.[cap])
  // 这一档现在没有方案，「有没有」的答案就是「没有」——不是「读不出来」
  if (!profile) return 'none'
  return current.secrets[cap][profile.id]?.[field]?.status ?? 'none'
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
  let store = defaultStore()
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
      store = normalizeStore(migrated.doc)
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

  cache = buildCache(store)
  try {
    // 读失败时上面已经把 store 换回默认值：既没有旧字段可搬，也没有明文 Key 可迁，
    // 这两个条件自然为 false，不会去动那份读不出来的文件。
    if (needsVersionStamp) await writeRaw(store)
    if (cache.migrated) await migratePlainKeys(store)
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
export async function loadSettings(selection?: ProfileSelection): Promise<AppSettings> {
  return flattenFor(await readCache(), selection)
}

/** 给界面的脱敏视图：凭据在这里就不再返回明文，渲染层拿到的是「有没有、能不能用、是不是明文」 */
export async function getSettingsView(selection?: ProfileSelection): Promise<SettingsView> {
  const current = await readCache()
  const flat = flattenFor(current, selection)
  const { asrApiKey: _asr, asrApiSecret: _asrSecret, aiApiKey: _ai, ttsApiKey: _tts, ...rest } = flat
  return {
    ...rest,
    asrKeyStatus: secretStatusFor(current, 'asr', 'apiKey', selection),
    aiKeyStatus: secretStatusFor(current, 'ai', 'apiKey', selection),
    ttsKeyStatus: secretStatusFor(current, 'tts', 'apiKey', selection),
    asrSecretStatus: secretStatusFor(current, 'asr', 'apiSecret', selection),
    keyEncryptionAvailable: encryptionAvailable(),
    storageProblem: describeLoadProblem(loadProblem),
  }
}

/**
 * 这份补丁是不是真的带着要写进方案的凭据。用在「这一档一条方案都没有」那句提示上：
 * 只改了转写模式/本地档位/语言（全局段）的保存不该被拦，而填了接口地址或模型或 Key
 * 却没地方写，才是用户以为存下来了、其实没存的那一种。
 * 密钥那格只认非空字符串：留空＝不改，null＝清除——一条方案都不在，这两样都没有东西可做。
 */
function hasCredentialInput(patch: SettingsPatch, cap: ProfileCapability): boolean {
  for (const [flatKey, field] of CAPABILITY_FIELDS[cap]) {
    if (SECRET_PROFILE_FIELDS.includes(field)) {
      const secret = patch[flatKey as SecretField]
      if (typeof secret === 'string' && secret) return true
      continue
    }
    const value = (patch as Partial<AppSettings>)[flatKey as keyof AppSettings]
    if (typeof value === 'string' && value.trim()) return true
  }
  return false
}

/**
 * 保存。补丁里属于全局段的键写进 `store.globals`，属于某一档的凭据写进那条方案——
 * 写进哪条由 `patch.profileIds` 决定，缺席＝各档当前默认方案。
 * 传了 id 却指不到人时**报错**而不是落回默认那条——静默写到默认方案会吃掉用户另一套配置，
 * 而那是他没碰过的那一条。
 * 这一档现在没有方案（还没新建过，或刚删完）而补丁带着凭据时也只报错、不代建：
 * 界面上那颗「新建一套」才是建方案的入口，保存里偷偷建一条会让「删掉最后一条」
 * 这件事看起来像没生效。
 *
 * 密钥字段的语义和普通字段不同，界面上的输入框是「留空＝不改」：
 * - 缺席 / 空串：保留磁盘上已有的那把（改个接口地址不用重贴 Key）
 * - null：显式清除（界面「清除已保存的 Key」按钮）
 * - 非空字符串：替换，并按本机能不能加密决定存密文还是明文
 */
export async function saveSettings(patch: SettingsPatch): Promise<SettingsView> {
  const current = await readCache()
  // 闸门先看，再谈「这几项没地方写」：这一档此刻没有方案是 0 配置的正常状态（三档都从空列表
  // 起步），而「先新建一条再点弹窗里的保存」这条出路在闸门落着的时候一个字都走不通。两个原因都要说，
  // 但磁盘不能碰那个才是用户当下能行动的那个。
  rejectIfWriteBlocked()
  const merged = cloneStore(current.raw)
  const incoming = patch as Partial<AppSettings>
  // 全局段只认 GLOBAL_FLAT_KEYS 里那几个名字，且只收字符串：界面上多带的字段
  // （脱敏视图的状态位、profileIds 这种）都不会被当成配置写回磁盘
  for (const flatKey of GLOBAL_FLAT_KEYS) {
    const value = incoming[flatKey as keyof AppSettings]
    if (typeof value === 'string') merged.globals[flatKey] = value
  }
  const target = {} as DefaultProfileId
  for (const cap of PROFILE_CAPABILITIES) {
    const wanted = (patch.profileIds?.[cap] ?? '').trim()
    const profile = wanted ? mustFindProfile(merged, cap, wanted) : pickDefault(merged, cap)
    if (!profile) {
      target[cap] = ''
      if (hasCredentialInput(patch, cap)) {
        throw new SettingsProfileRuleError(PROFILE_CREATE_FIRST_MESSAGE)
      }
      continue
    }
    target[cap] = profile.id
    for (const [flatKey, field] of CAPABILITY_FIELDS[cap]) {
      if (SECRET_FIELDS.includes(flatKey as SecretField)) {
        const incomingSecret = patch[flatKey as SecretField]
        if (incomingSecret === undefined || incomingSecret === '') continue
        profile[field] = incomingSecret === null ? '' : seal(incomingSecret.trim())
        continue
      }
      // 只认这里列得出的配置项，且只收字符串：界面上多带的字段（脱敏视图的状态位）
      // 和任何手改出来的怪值都不该被写回磁盘
      const value = incoming[flatKey as keyof AppSettings]
      if (typeof value === 'string') profile[field] = value
    }
  }
  // 「是否默认」那颗开关在编辑表单里翻，跟着这次保存一起落盘；空串是用户明确表示
  // 「这一档现在不要当前使用的方案」，不是「没填」——所以缺席才是不改，给了就必须是真人
  for (const cap of PROFILE_CAPABILITIES) {
    const raw = patch.defaultProfileIds?.[cap]
    if (raw === undefined) continue
    const next = raw.trim()
    merged.defaultProfileId[cap] = next ? mustFindProfile(merged, cap, next).id : ''
  }
  // 写盘前把「默认 id 指得到人」这条不变量再对一遍，与每条增删改共用同一个规则
  for (const cap of PROFILE_CAPABILITIES) {
    merged.defaultProfileId[cap] = fixDefaultId(merged.profiles[cap], merged.defaultProfileId[cap])
  }
  await writeRaw(merged)
  // 回来的视图要说的是「刚写进去的那几条」，不然界面编辑一条非默认方案时
  // 看到的是默认方案的字段，像保存没生效
  return getSettingsView(target)
}

/**
 * 界面传来的能力名收口。这三档的值会被用来索引 store 的 profiles / 密钥表，
 * 所以不能把渲染层那根字符串直接当键用；认不出就报错，宁可让 toast 说一句「不知道要改哪类」。
 */
function normalizeCapability(raw: unknown): ProfileCapability {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!PROFILE_CAPABILITIES.includes(value as ProfileCapability)) {
    throw new SettingsProfileRuleError('不知道要改哪一类配置，请重新选一次')
  }
  return value as ProfileCapability
}

/** id 同样要先收口：它是磁盘上那条方案的寻址键，空串在界面语境里是「没选」而不是「第一条」 */
function normalizeProfileIdArg(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

/** 一条方案投成界面看的脱敏形状：字段按 CAPABILITY_FIELDS 那张表给，凭据只给状态 */
function profileViewFor(
  current: SettingsCache,
  cap: ProfileCapability,
  profile: Profile
): ProfileView {
  const values: Record<string, string> = {}
  const secretStatus: Record<string, SecretStatus> = {}
  const secrets = current.secrets[cap][profile.id] ?? {}
  for (const [flatKey, field] of CAPABILITY_FIELDS[cap]) {
    if (!SECRET_PROFILE_FIELDS.includes(field)) {
      const value = profile[field]
      values[flatKey] = typeof value === 'string' ? value : ''
      continue
    }
    // apiKey 那一格的状态走下面那个 keyStatus（三档的列表行都在读它），不在这张表里再抄一份
    if (field !== 'apiKey') secretStatus[flatKey] = secrets[field]?.status ?? 'none'
  }
  return {
    id: profile.id,
    name: profile.name,
    values,
    keyStatus: secrets.apiKey?.status ?? 'none',
    secretStatus,
  }
}

/** 三档的方案列表 + 每档选哪条，一次给全。增删改的返回值也走它，界面不用为「改完了长什么样」再问一次 */
export async function listProfiles(): Promise<ProfilesView> {
  const current = await readCache()
  const profiles = {} as Record<ProfileCapability, ProfileView[]>
  for (const cap of PROFILE_CAPABILITIES) {
    profiles[cap] = current.raw.profiles[cap].map((profile) => profileViewFor(current, cap, profile))
  }
  return {
    profiles,
    defaultProfileId: { ...current.raw.defaultProfileId },
    maxProfiles: MAX_PROFILES_PER_CAPABILITY,
    storageProblem: describeLoadProblem(loadProblem),
  }
}

/**
 * 改完 store 的收尾，五条增删改共用：把「默认 id 要么指得到人、要么是空串」这条不变量
 * 重新对正（规则与读盘收口是同一句 `fixDefaultId`），再落盘。
 * 写盘走唯一的 writeRaw 出口，所以读失败时的闸门、版本戳、原子写与 .bak 对增删改同样生效
 * ——这几件事少做一件，配置列表就成了绕过闸门的旁路。
 *
 * 列表可以是空的，这里不再拦「删到一条不剩」：那正是 #222 新口径里的 0 配置状态。
 */
async function commitStore(merged: SettingsStore): Promise<ProfilesView> {
  for (const cap of PROFILE_CAPABILITIES) {
    merged.defaultProfileId[cap] = fixDefaultId(merged.profiles[cap], merged.defaultProfileId[cap])
  }
  await writeRaw(merged)
  return listProfiles()
}

/**
 * 新建一条方案的入参。渲染层传来的是界面此刻的样子，主进程这边一律先收口再用：
 * 这些值来自 IPC，类型不受我们控制。
 */
export interface ProfileCreateInput {
  /** 界面不再让用户起名，只有校对/配音那套老按钮还会给；空则按模型名/「方案 N」兜底 */
  name?: unknown
  /**
   * 照哪一条复制：省略＝该档当前默认那条；给 id＝照那条；给空串＝一条全空白（连 Key 都不带）。
   * 复制时密钥**原样搬运密文**，不重新封一次——重封会把「能不能解密」变成「换过机器」。
   */
  fromProfileId?: unknown
  /** 以界面当前输入为准：键名是界面上那套扁平名（asrApiBase / asrModel / asrApiKey / …） */
  values?: unknown
  /** 是否把这条设为当前使用；这一档原本一条都没有时不用给，第一条自动是它 */
  setDefault?: unknown
}

/**
 * 新建一条方案，当场落盘。
 *
 * 凭据以 `values`（＝界面此刻的输入）为准，没给的字段才落回「照来源那条复制」——
 * 转写这一档点「新建一套」时用户要的就是「我表单里填的这几项变成一条方案」，
 * 而不是先复制一份再让他改第二遍。Key 那一格给空串是**真的空**（界面上允许「缺 Key」，
 * 自建网关本来就可能不要 Key），这点和保存不同：保存里的空串是「保留磁盘上那把」，
 * 两处若都按保存那套走，刚建的方案就躺着上一家的密钥。
 *
 * 上限只在这里拦：读取侧不按 cap 剪列表，所以手改文件里多出来的几条照样能读能删，
 * 但不能再点「新建」。
 */
export async function createProfile(
  rawCap: unknown,
  input?: ProfileCreateInput
): Promise<ProfilesView> {
  const cap = normalizeCapability(rawCap)
  const current = await readCache()
  rejectIfWriteBlocked()
  const merged = cloneStore(current.raw)
  const list = merged.profiles[cap]
  if (list.length >= MAX_PROFILES_PER_CAPABILITY) {
    throw new SettingsProfileRuleError(PROFILE_LIMIT_MESSAGE)
  }
  const sourceId = normalizeProfileIdArg(input?.fromProfileId)
  // 「要一条全空白」的暗号是显式给了一个空串；省略这个字段是「照当前那条复制」，两件事不能混
  const wantsBlank = input?.fromProfileId === ''
  const source = wantsBlank ? null : sourceId ? mustFindProfile(merged, cap, sourceId) : pickDefault(merged, cap)
  const created: Profile = { ...(source ?? defaultProfileFor(cap)) }
  created.id = freshProfileId(cap, new Set(list.map((profile) => profile.id)))
  if (wantsBlank) {
    // 「空白一套」真的什么都不带：密钥也清空，否则界面按「新方案」填完字段就以为自己
    // 拿到了一把干净的 Key，实际底下躺着上一套的那把
    created.apiKey = ''
    for (const [, field] of CAPABILITY_FIELDS[cap]) {
      if (field === 'apiKey') continue
      created[field] = defaultProfileFor(cap)[field]
    }
  }
  const values = asObject(input?.values)
  for (const [flatKey, field] of CAPABILITY_FIELDS[cap]) {
    const value = values[flatKey]
    if (typeof value !== 'string') continue
    if (field === 'apiKey') {
      created.apiKey = value ? seal(value.trim()) : ''
      continue
    }
    created[field] = value
  }
  const named = normalizeProfileName(input?.name)
  created.name = named || (created.model || '').trim() || nextProfileName(cap, list)
  const wasEmpty = list.length === 0
  list.push(created)
  // 第一条自动是当前使用：新建完就能转写，不用再去找开关。之后几条只在表单上那颗
  // 「是否默认」明确开着时才改指针——把旧那条顶掉就是它该有的意思，互斥由结构保证
  // （磁盘上每档只有一个 defaultProfileId）。
  if (wasEmpty || input?.setDefault === true) merged.defaultProfileId[cap] = created.id
  return commitStore(merged)
}

/** 方案名：去空格，空的那句要说清楚是不能为空而不是「没改」；长度收一口，界面上的名字不能把列表撑破 */
function normalizeProfileName(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value.slice(0, 40)
}

const PROFILE_NAME_REQUIRED_MESSAGE = '方案名不能为空，随便起一个能认出来的名字'

/** 改名：只动 name，其余字段（含密钥原样）不碰。id 不变，所以历史记录里那条引用不会断 */
export async function renameProfile(
  rawCap: unknown,
  rawProfileId: unknown,
  name: unknown
): Promise<ProfilesView> {
  const cap = normalizeCapability(rawCap)
  const profileId = normalizeProfileIdArg(rawProfileId)
  const next = normalizeProfileName(name)
  if (!next) throw new SettingsProfileRuleError(PROFILE_NAME_REQUIRED_MESSAGE)
  const current = await readCache()
  rejectIfWriteBlocked()
  const merged = cloneStore(current.raw)
  mustFindProfile(merged, cap, profileId).name = next
  return commitStore(merged)
}

/**
 * 删掉一条方案，含它保存的密钥。允许删到最后一条：这一档从此是「0 配置」，
 * 界面给的是那颗「新建API接入」，getter 投出来的是空凭据，readiness 拦下这一次云端调用并说清楚为什么。
 *
 * 删掉的正是「当前使用」那条时**不落回剩下第一条**（`fixDefaultId` 那句），
 * 因为那等于用界面上排第一的那家网关替用户做了决定，而下一次花的钱按那条计价。
 */
export async function deleteProfile(rawCap: unknown, rawProfileId: unknown): Promise<ProfilesView> {
  const cap = normalizeCapability(rawCap)
  const profileId = normalizeProfileIdArg(rawProfileId)
  const current = await readCache()
  rejectIfWriteBlocked()
  const merged = cloneStore(current.raw)
  mustFindProfile(merged, cap, profileId)
  merged.profiles[cap] = merged.profiles[cap].filter((profile) => profile.id !== profileId)
  return commitStore(merged)
}

/**
 * 把这一档当前用的方案换成指定那条。转写/校对/配音下一次取值就走这条，无需重启。
 * 界面上这条通道现在只有校对、配音那两条老方案条还在用；转写那一档的「是否默认」开关
 * 改由「保存设置」带 `defaultProfileIds` 落盘（#222 新口径：那颗开关在编辑表单里）。
 */
export async function setDefaultProfile(
  rawCap: unknown,
  rawProfileId: unknown
): Promise<ProfilesView> {
  const cap = normalizeCapability(rawCap)
  const profileId = normalizeProfileIdArg(rawProfileId)
  const current = await readCache()
  rejectIfWriteBlocked()
  const merged = cloneStore(current.raw)
  mustFindProfile(merged, cap, profileId)
  merged.defaultProfileId[cap] = profileId
  return commitStore(merged)
}

/**
 * 应用自己往根地址后面接的那几条路径，逐条抄自五个拼请求的地方：
 * `ttsVendor.VENDOR_SHAPES`、`ttsVendor.VENDOR_VOICE_LIST_PATH`、`ttsVendor.VENDOR_VOICE_CLONE`、
 * `asrVendor.buildAsrRequest`、`asr/iflytekAsr`、`ai/openaiCompatible`。
 * 这张表只用来**认用户粘错的尾巴**，不用来拼请求——拼法仍以那几处为准，
 * 新增一条端点而忘了登记到这里的代价是「粘贴完整端点又变成 404」，
 * `tests/settingsNormalize.test.ts` 里有一条对账测试专门盯这件事。
 *
 * 表里只放**真的会发出去**的那几条：`/v1/responses`、`/v1/messages` 这类「以后也许接」的先不登记，
 * 因为认下它们的尾巴只会把一份本来就不兼容的配置洗成「看着像能用」——应用照旧发
 * `/v1/chat/completions` 加 Bearer，撞过去的还是那句错，只是这次连用户填的原话都看不到了。
 */
const APPENDED_ENDPOINT_PATHS: readonly string[] = [
  '/v1/audio/transcriptions',
  '/v1/speech_to_text',
  '/api/v3/auc/bigmodel/recognize/flash',
  '/v2/upload',
  '/v2/getResult',
  '/v1/audio/speech',
  '/v1/t2a_v2',
  // 配音页那格音色的候选名单（#340）：也是真发出去的一条，所以照样要认下用户粘的尾巴
  '/v1/get_voice',
  // 声音复刻那两步（#330）：MiniMax 先上传换 file_id 再复刻，百炼一条 customization 走完
  '/v1/files/upload',
  '/v1/voice_clone',
  '/api/v1/services/audio/tts/customization',
  '/api/v1/services/audio/tts/speechsynthesizer',
  '/api/v3/tts/unidirectional',
  '/v1/chat/completions',
]

/**
 * 接口地址归一化。
 * 各家文档常直接给 `https://api.openai.com/v1` 这种带后缀的形式，而请求统一拼成
 * `${apiBase}/v1/...`，所以这里容忍末尾斜杠和多余的 /v1。
 * 转写、校对、以及设置里的「测试连接」必须共用这一个实现，否则测试用归一化后的地址、
 * 干活用原始地址，就会出现「测试说可用、一转写就 404」这种最难查的分叉。
 *
 * 再把「对方文档里那条完整端点」也认下来（见 APPENDED_ENDPOINT_PATHS）：用户照着文档整段复制
 * 粘进来的就是 `https://api.minimax.cn/v1/speech_to_text`，而应用自己还要再接一次路径，
 * 拼出来是 `.../v1/speech_to_text/v1/speech_to_text`——症状是一句 404，而他填的明明是对方的原话。
 *
 * 表没更新（新加端点、或对方改了路径）时兜底的是 `apiPath.appendApiPath`：那条尾巴接不上我们
 * 要接的那一条就不再接第二遍，打出去的就是用户填的原话。这张表仍然留着，因为它多治一类
 * 表兜不住的情况——在 MiniMax 的地址上粘了百炼的端点：按原话打必然不通，认成尾巴洗回根地址反而能用。
 */
export function normalizeApiBase(raw: string): string {
  const noSlash = (raw || '').trim().replace(/\/+$/, '')
  // 两边都要小写：表里有一条大小写混排的（讯飞的 `/v2/getResult`），只把用户粘的那一份转小写
  // 会让那一条永远匹配不上——症状是「粘完整端点又变回 404」，正是这张表要治的那一类。
  // 切长度用表里原样的那一份：ASCII 的大小写转换不改长度，所以两个数必然相等。
  const lowered = noSlash.toLowerCase()
  const tail = APPENDED_ENDPOINT_PATHS.find((path) => lowered.endsWith(path.toLowerCase()))
  const rooted = tail ? noSlash.slice(0, -tail.length).replace(/\/+$/, '') : noSlash
  return rooted.replace(/\/v1$/i, '')
}

/**
 * 转写配置。`profileId` 是界面「这次用哪套转写配置」传下来的那条；空或指不到人时
 * 落回该档当前默认方案（与没长出选择器时同一结果）；该档一条方案都没有时投出来的是空凭据，
 * 而 `provider`（云端／本地那一份）/ `localModel` 走的是全局段，不受有没有方案影响——本地转写照样能跑。
 * 1.1.1 起的 `vendor` 是**另一件事**：它是方案里那一项（去云端哪家网关），没方案时投成 OpenAI 兼容，
 * 也就是这一条链路 1.1.1 之前的唯一形状。这两个键名挨得太像，取值点别当同一个用。
 * 真正用到的那条 id 用 resolveProfileId 再问一次——历史记录要按 id 记（#247），
 * 拿传进来的那个记会在落回默认时记错。
 */
export async function getASRConfig(
  profileId?: string | null
): Promise<Record<string, unknown>> {
  const settings = await loadSettings({ asr: profileId ?? undefined })
  return {
    provider: settings.asrProvider,
    // 云端那一腿发成哪家的形状（路径 / 字段名 / 默认模型）。本地档不看这一项，
    // 但和配音一样投得出来，免得调用方自己判断「这一项什么时候有意义」——那正是
    // #220/#227 那种「判松判严都拦错人」的源头
    vendor: normalizeAsrVendor(settings.asrVendor),
    apiKey: settings.asrApiKey,
    apiBase: normalizeApiBase(settings.asrApiBase),
    model: settings.asrModel,
    // 讯飞那一档要的另外两把（#343）：它的签名要 AppID + APIKey + APISecret 一起才算得出来。
    // 其余厂商的适配层读不到这两项，所以照旧投得出来，不由调用方判断「这一项什么时候有意义」
    appId: settings.asrAppId,
    apiSecret: settings.asrApiSecret,
    localModel: normalizeLocalModel(settings.asrLocalModel),
  }
}

/** AI 校对配置；留空时回落到 OpenAI 端点，否则拼出来的是非法相对地址，报错对用户毫无意义 */
export async function getAIConfig(
  profileId?: string | null
): Promise<{ apiKey: string; apiBase: string; model: string }> {
  const settings = await loadSettings({ ai: profileId ?? undefined })
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
 *
 * `profileId` 只挑配音那档的方案。回落时用的「校对那套」固定是**校对档当前默认的**那条，
 * 不跟着配音的 id 走：三档的方案列表各选各的，一个 id 同时能指到两档的话，
 * 「配音指哪家网关」就变成由校对的选择决定了。
 */
export async function getTTSConfig(profileId?: string | null): Promise<{
  engine: TtsEngineMode
  vendor: TtsVendorId
  apiKey: string
  apiBase: string
  model: string
  resourceId: string
  voice: string
  localEngine: LocalTtsEngineId
}> {
  const settings = await loadSettings({ tts: profileId ?? undefined })
  const engine = normalizeTtsEngine(settings.ttsEngine)
  const vendor = normalizeTtsVendor(settings.ttsProvider)
  return {
    engine,
    // 本地档不看这一项（那边连地址和 Key 都不参与），但它在两份配置里都算得出来，
    // 投出来比「本地档时留个空」少一处「这个字段什么时候有意义」的分叉
    vendor,
    apiKey: settings.ttsApiKey || settings.aiApiKey,
    apiBase:
      normalizeApiBase(settings.ttsApiBase) ||
      normalizeApiBase(settings.aiApiBase) ||
      'https://api.openai.com',
    model: settings.ttsModel,
    // 本地档不看它，投出来和 vendor 同一个理由：少一处「这一项什么时候有意义」的分叉。
    // 空串留给适配层决定发不发（只有豆包读它，见 ttsVendor）
    resourceId: settings.ttsResourceId,
    // 根上那一份 `ttsVoice` 是 1.1.0 把音色从方案里摘出来时留下的位置，界面上已经没有格子能改它
    // （改的是配音页那一格，不落盘）。所以它只剩两种来源：旧方案迁过来的那一次，和空串。
    // 把它当默认音色递给 OpenAI 兼容是原本的意思；递给 MiniMax／百炼／豆包就是拿一家的音色名
    // 去问另一家——界面已经写了「这一家不收空音色」，落回一个外来音色等于替用户把那句话绕过去。
    voice:
      engine === 'local'
        ? normalizeLocalVoice(settings.ttsLocalVoice)
        : ttsVendorNeedsVoice(vendor)
          ? ''
          : settings.ttsVoice,
    localEngine: normalizeLocalTtsEngine(settings.ttsLocalEngine),
  }
}
