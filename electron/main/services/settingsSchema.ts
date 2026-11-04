/**
 * settings.json 的格式版本与迁移链
 *
 * 为什么要有这一层，而不是继续「读的时候顺手把旧字段搬一下」：
 * 磁盘上那份文件此前不写自己的格式版本，读的人只能靠猜——猜错了不会报错，只会把
 * 一份合法但形状不同的配置写成自己认识的样子。1.0.9 把配置拆成了多套（profile），
 * 那是一次真正的结构改动；没有版本戳的话，它只能靠「有没有 profiles 字段」反推该不该搬，
 * 而那种推断在用户回退版本、或半路崩溃留下旧形状时会静默改写用户的数据。
 *
 * 两个方向要分开对待，这是整层的立意：
 * - 版本比本应用旧 → 按注册表一步步搬上来，搬完落盘（这是迁移）。
 * - 版本比本应用新 → 本应用读不懂它，绝不改名、绝不搬、绝不写回（用户可能只是装了个
 *   旧版本的应用，那份文件是他新版里正在用的东西）。这一条防的就是「装了 1.0.9 又
 *   回退到 1.0.8」时把 profiles 整段抹掉——1.0.8 不处理它，但也不能毁掉它。
 *
 * 「搬」这一步只管形状，取值收口（档位白名单、接口地址修剪、缺字段补默认）一律在
 * settingsService：迁移要可预期、可复盘，混进归一化就会出现「一次升级顺手改了用户
 * 没打算改的值」。
 */

/**
 * 本应用读写认到这一版。
 * v1 = 扁平的 17 个键（1.0.5～1.0.8）；v2 = 云端方案按能力各一个列表（1.0.9）。
 *
 * v2 在 1.0.9 开发中途改过一次口径，这里记下的是改完的那版：三档的方案都**只装这家网关的参数**
 * （接口地址 / Key / 模型，配音另加音色），「走不走云端」「本地档位」「转写语言」这类不进方案，
 * 留在文档根上那批扁平键里（读进内存后叫 store.globals）。原先那版把 17 个键全搬进了
 * 方案，于是每条方案各自带着一份转写语言和本地档位——用户要的是「多家网关换着使」，
 * 不是「每家一套语言」。
 * 唯一一项不是凭据却留在方案里的是 ai 的 provider：它是「这套地址+Key 属于哪家」的书签，
 * 界面上拿它预填地址和模型，换方案就得换书签；而 asr 那个同名键说的是「本地还是云端」，
 * 是这一档要不要花钱的开关，所以它退回全局段。
 * 这一版没发到任何用户手上，所以改的是 v2 自己的定义，不另起 v3：发出去的人只有 v1→v2
 * 这一条路要走，而它现在搬的是对的形状。
 *
 * 「哪些键算全局」这件事不在这张表里再列一遍：CAPABILITY_FIELDS 没认领的扁平键就是全局段，
 * 那个集合由 settingsService 从 DEFAULT_SETTINGS 推出来。所以这一版改字段归属只改那张表，
 * 迁移与读写跟着就对了——v1→v2 也只删它真正搬走的那几个键，剩下的原样躺在根上。
 * 但中途挪走过的那些键在开发机上已经躺在方案里了，那份残留靠下面这张
 * PROFILE_FIELDS_MOVED_TO_GLOBALS 读回全局段，不然就是「读成功、写成功、东西没了」。
 */
export const CURRENT_SETTINGS_VERSION = 2

/** 磁盘上还没收口成配置对象的那份原始文档：字段可能是旧的、多余的、类型不对的 */
export type SettingsDocument = Record<string, unknown>

/**
 * 一项能力：转写（asr）、校对（ai）、配音（tts）。
 * v2 把配置按这三档各拆成一个列表——用户常常是「云端转写 + 本地配音」或
 * 「一家网关校对、另一家配音」，按能力各选各的方案才对得上实际用法（#222 的方案 A）。
 */
export type ProfileCapability = 'asr' | 'ai' | 'tts'

/** 遍历顺序固定用这一份，别让 Object.keys 的次序决定界面与日志里的顺序 */
export const PROFILE_CAPABILITIES: readonly ProfileCapability[] = ['asr', 'ai', 'tts']

/**
 * 磁盘上的一条方案。id / name / apiKey 三档共有，其余按 CAPABILITY_FIELDS 那张表各档不同。
 *
 * 这里没有写成 AsrProfile / AiProfile / TtsProfile 三个接口，是有意的：那些字段的名字
 * 本来就由下面那张表驱动（迁移、读盘收口、落盘、投给界面的扁平视图都按表读写），
 * 再各写一份接口只会出现「表里加了一个字段、接口没加」这种编译期管不住的分裂。
 * 表是唯一的事实来源，界面「这一档有哪几项配置」也取自它。
 */
export interface Profile {
  /** 稳定标识：defaultProfileId 与历史记录都按它指人，改名不该让引用断掉 */
  id: string
  /**
   * 界面上给用户看的方案名。新口径里列表那一行说的是「模型名 · 接口域名」，不再让用户
   * 起名，所以这里退成**兜底标签**：模型名空着的时候（新建还没填完、手改的文件里没写）
   * 界面总得有个能指人的词。改名那条通道还在（`settings:renameProfile`），只是按新口径
   * 它不再出现在转写这一档的界面上。
   */
  name: string
  /** 密文原样（`v1:<base64>`）——迁移与就地加密之外，任何一步都不许重新加密 */
  apiKey: string
  [field: string]: string
}

/** 这一档一条方案都没有也是合法状态：云端模式下还没建过任何方案（#222 新口径） */
export type SettingsProfiles = Record<ProfileCapability, Profile[]>

/**
 * 每档当前选用的方案；历史记录要按档记下这三个 id（#247）。
 * 空串＝这一档现在没有「当前使用」的方案，不是「第 0 条」——列表空着，或者用户删掉了
 * 正当前使用那条且不打算让应用猜下一个该用谁，都是这个值。
 */
export type DefaultProfileId = Record<ProfileCapability, string>

/**
 * 全局段：不属于任何一档方案的扁平配置（此刻是 asrProvider / asrLocalModel / asrLanguage /
 * ttsEngine / ttsLocalEngine / ttsLocalVoice）。
 * 键就是 v1 那批扁平键的名字，落盘时也平铺在文档根上，不再嵌一层——嵌进去就得让迁移知道
 * 哪些键归全局，而那份知识已经在 CAPABILITY_FIELDS 里了，抄第二遍迟早分叉。
 */
export type SettingsGlobals = Record<string, string>

export interface SettingsStore {
  globals: SettingsGlobals
  profiles: SettingsProfiles
  defaultProfileId: DefaultProfileId
}

/**
 * v1 那些扁平键与 v2 方案字段的对应表：`[扁平键, 方案字段]`。表里只列**进方案**的那些键，
 * 没被这张表认领的扁平键就留在文档根上（`SettingsGlobals`）——所以「这一档有哪几项配置」
 * 和「哪些配置全局共用」两件事仍然只有这一处定义，读盘、落盘、投给界面的扁平视图都按它走。
 *
 * 三档都按「换一家网关要换的东西」这条线收窄：
 * - asr 三项：地址 / Key / 模型。「用本地还是云端」「本地档位」「转写语言」是这次任务怎么选的问题，
 *   不是这家网关的参数。
 * - tts 四项：地址 / Key / 模型 / 音色。音色在 OpenAI 兼容网关里是对方给的名字（alloy 这套
 *   不是到处都有），跟模型一样属于网关；「走本地还是云端」「本地引擎」「本地音色编号」不属于。
 * - ai 四项：地址 / Key / 模型 + provider。provider 不是凭据，但它是「这套地址和 Key 是哪家」
 *   的书签——界面上按它预填地址与模型，换一套凭据就得换这个书签。它也不被主进程读取
 *   （取配置只看地址和 Key），所以留在方案里不改变任何行为。
 */
export const CAPABILITY_FIELDS: Record<
  ProfileCapability,
  ReadonlyArray<readonly [string, string]>
> = {
  asr: [
    ['asrApiKey', 'apiKey'],
    ['asrApiBase', 'apiBase'],
    ['asrModel', 'model'],
  ],
  ai: [
    ['aiProvider', 'provider'],
    ['aiApiKey', 'apiKey'],
    ['aiApiBase', 'apiBase'],
    ['aiModel', 'model'],
  ],
  tts: [
    ['ttsApiBase', 'apiBase'],
    ['ttsApiKey', 'apiKey'],
    ['ttsModel', 'model'],
    ['ttsVoice', 'voice'],
  ],
}

/**
 * v2 开发中途从方案里挪回全局段的那几个字段：`[哪一档, 方案里的旧字段名, 文档根上的扁平键]`。
 *
 * 这张表只为开发机上那份中途形状存在。口径改了而版本戳没改（v2 从没发到用户手上，
 * 中途的几种形状都在同一台机器上被同一个版本号盖着），读的人按新表收口就会把
 * 躺在方案里的旧字段直接丢掉：那是用户填过的「本地档位＝small」「配音引擎＝本地」，
 * 丢完下一次写盘连痕迹都不剩，正是「读成功、写成功、东西没了」。所以读盘时先把这些值
 * 升回文档根，再由 normalizeGlobals 收进全局段；方案里那份残留下一次写盘自然消失。
 *
 * 挪走而不是删除是另一回事：asr 的 provider / localModel / language 是 ①②步挪的，
 * tts 那三个是 ⑧步挪的——两张表都得留在这里，直到 v2 定稿发出、这些形状不再可能出现。
 */
export const PROFILE_FIELDS_MOVED_TO_GLOBALS: ReadonlyArray<
  readonly [ProfileCapability, string, string]
> = [
  ['asr', 'provider', 'asrProvider'],
  ['asr', 'localModel', 'asrLocalModel'],
  ['asr', 'language', 'asrLanguage'],
  ['tts', 'engine', 'ttsEngine'],
  ['tts', 'localEngine', 'ttsLocalEngine'],
  ['tts', 'localVoice', 'ttsLocalVoice'],
]

/** 从 v1 搬出来的那条方案的 id 与界面上的名字：三步（迁移 / 读盘 / 落盘）都取这一处 */
export const DEFAULT_PROFILE_IDS: DefaultProfileId = {
  asr: 'asr-default',
  ai: 'ai-default',
  tts: 'tts-default',
}

export const DEFAULT_PROFILE_NAME = '默认'

/**
 * 每一档最多能有几套方案（2026-10-31 用户定的产品上限：转写/校对/配音各最多 3 套）。
 *
 * 这个数**只在写入侧生效**——新建方案到数就拒；读取侧不许按它剪列表。
 * 手改的文件里塞了 5 条时剪掉 2 条，就是「读成功、写成功、东西没了」，撞的是
 * 「绝不静默丢用户的东西」那条承诺。所以它是产品上限，不是校验规则，
 * normalizeStore 那边照单全收，界面上限与这里的判断都取自这一个常量。
 */
export const MAX_PROFILES_PER_CAPABILITY = 3

/** 版本字段的名字只在这里出现一次，写盘与读盘都取它，避免拼写分叉 */
export const CURRENT_SETTINGS_VERSION_FIELD = 'schemaVersion'

/** v2 那两个新段落的名字，同上：写盘、读盘、迁移三处共用（全局段没有自己的段落——它就平铺在根上） */
export const PROFILES_FIELD = 'profiles'
export const DEFAULT_PROFILE_ID_FIELD = 'defaultProfileId'

export interface SettingsMigration {
  from: number
  to: number
  /**
   * 只做「把旧文档改成这一版认得的字段」，不做取值收口——
   * 归一化（档位白名单、接口地址修剪）是 settingsService 的事，混进来会让一条迁移
   * 顺手改了用户没打算改的值，而迁移应该是可预期、可复盘的那一步。
   */
  run: (doc: SettingsDocument) => SettingsDocument
}

/**
 * 1.0.5 及之前，配音寄存在校对名下（`aiTtsModel` / `aiTtsVoice`）。
 * 旧键不管有没有接管都要抹掉：留着会出现「用户把配音模型清空、下次启动旧值又复活」
 * 这种自己解不开的事；静默丢掉用户填过的音色则更糟，所以先搬再删。
 */
const LEGACY_TTS_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['aiTtsModel', 'ttsModel'],
  ['aiTtsVoice', 'ttsVoice'],
]

function adoptLegacyTtsFields(doc: SettingsDocument): SettingsDocument {
  const next = { ...doc }
  for (const [legacyKey, currentKey] of LEGACY_TTS_PAIRS) {
    const legacy = next[legacyKey]
    delete next[legacyKey]
    if (typeof legacy !== 'string' || !legacy) continue
    if (!next[currentKey]) next[currentKey] = legacy
  }
  return next
}

/**
 * v1 → v2：把 CAPABILITY_FIELDS 认领的那些扁平键按能力搬进各自那条「默认」方案。
 *
 * 四条规矩，都是「用户填过的东西不能再这一次搬运里丢掉」：
 * - 密钥原样搬。`v1:<base64>` 是上一版按这台机器的密钥库封的，重新加密会变成
 *   「前缀对但解不开」，界面上就显示成「Key 没配」——那是不可恢复的谎报。
 * - 扁平键搬完一律删掉。留着会出现「界面读默认方案、旧键还趴在磁盘上」，
 *   下一次保存只写方案列表，那些旧键就成了永远没人读的残留（同 v0→v1 的理由）。
 * - 只搬字符串。类型不对的值不搬，也不删掉方案里对应的位置——取值收口在
 *   settingsService 按默认值补，这一步只管形状。
 * - 表里没认领的键**一个都不碰**（转写模式、本地档位、转写语言这些照原样躺在根上，
 *   读的时候进 store.globals）。所以这里不需要知道「哪些是全局键」那份清单，
 *   以后把某一档的字段挪回全局也只改那张表，这条迁移不用跟着动。
 *
 * 老文件里那三项凭据不管填没填都会搬成一条方案：这一档从此有了「当前使用」那条，
 * 界面按它的模型名/域名列表。空着的那条不删——删空方案等于在这一步替用户决定
 * 「你没填的那些不算配置」，而它多半只是还没填完。
 */
function splitFlatIntoProfiles(doc: SettingsDocument): SettingsDocument {
  const next = { ...doc }
  const profiles = {} as SettingsProfiles
  for (const cap of PROFILE_CAPABILITIES) {
    const profile: Profile = {
      id: DEFAULT_PROFILE_IDS[cap],
      name: DEFAULT_PROFILE_NAME,
      apiKey: '',
    }
    for (const [flatKey, field] of CAPABILITY_FIELDS[cap]) {
      const value = next[flatKey]
      delete next[flatKey]
      if (typeof value === 'string') profile[field] = value
    }
    profiles[cap] = [profile]
  }
  next[PROFILES_FIELD] = profiles
  next[DEFAULT_PROFILE_ID_FIELD] = { ...DEFAULT_PROFILE_IDS }
  return next
}

/**
 * 迁移注册表。一条一步、首尾相接（0→1、1→2…）；中间缺一步会被下面的走链逻辑
 * 判成 gap 而不是「跳过那步」——跳过就等于把一份看不懂的文件当成看懂了。
 */
export const SETTINGS_MIGRATIONS: ReadonlyArray<SettingsMigration> = [
  { from: 0, to: 1, run: adoptLegacyTtsFields },
  { from: 1, to: 2, run: splitFlatIntoProfiles },
]

/**
 * 读文件自报的版本。只认非负整数：缺字段按 v0（这一版之前的文件确实没有这个字段），
 * 而 '1'、1.5、null 这类写坏的值也按 v0——往下走会被搬回当前版本并盖上新戳，
 * 往上装懂则可能读不懂就乱写。
 */
export function readSettingsVersion(doc: SettingsDocument): number {
  const raw = doc[CURRENT_SETTINGS_VERSION_FIELD]
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0
}

export type MigrateOutcome =
  | { status: 'current'; doc: SettingsDocument; version: number }
  | { status: 'migrated'; doc: SettingsDocument; from: number; version: number; ran: number[] }
  /** 这份文件来自更新版本的应用：本应用不搬、不写、不改名，交给调用方拦下写盘 */
  | { status: 'fromNewerVersion'; version: number }
  /** 注册表里缺一步：链断了，不能靠猜补过去 */
  | { status: 'gap'; at: number }

/**
 * 把文档搬到 target。target / steps 可以被调用方显式传入，是为了让「链怎么走的」
 * 这件事本身可测——多步顺序与断链检测没法靠只有一步的生产注册表证明。
 */
export function migrateSettingsDocument(
  input: SettingsDocument,
  target: number = CURRENT_SETTINGS_VERSION,
  steps: ReadonlyArray<SettingsMigration> = SETTINGS_MIGRATIONS
): MigrateOutcome {
  const from = readSettingsVersion(input)
  if (from > target) return { status: 'fromNewerVersion', version: from }
  if (from === target) return { status: 'current', doc: input, version: target }

  let doc = input
  let version = from
  const ran: number[] = []
  while (version < target) {
    const step = steps.find((item) => item.from === version)
    if (!step) return { status: 'gap', at: version }
    doc = step.run(doc)
    ran.push(version)
    version = step.to
  }
  return { status: 'migrated', doc, from, version, ran }
}
