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
 * v1 = 扁平的 17 个键（1.0.5～1.0.8）；v2 = 按能力分列表的多方案（1.0.9）。
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
  /** 界面上给用户看的方案名 */
  name: string
  /** 密文原样（`v1:<base64>`）——迁移与就地加密之外，任何一步都不许重新加密 */
  apiKey: string
  [field: string]: string
}

export type SettingsProfiles = Record<ProfileCapability, Profile[]>

/** 每档当前选用的方案；历史记录要按档记下这三个 id（#247） */
export type DefaultProfileId = Record<ProfileCapability, string>

export interface SettingsStore {
  profiles: SettingsProfiles
  defaultProfileId: DefaultProfileId
}

/**
 * v1 那 17 个扁平键与 v2 方案字段的对应表：`[扁平键, 方案字段]`。
 * 6 + 4 + 7 = 17，一项不落——这张表就是「旧配置搬新家」的全部依据，也是
 * 「新磁盘形状投回扁平视图」的依据，两处共用一份才不会各认各的。
 */
export const CAPABILITY_FIELDS: Record<
  ProfileCapability,
  ReadonlyArray<readonly [string, string]>
> = {
  asr: [
    ['asrProvider', 'provider'],
    ['asrApiKey', 'apiKey'],
    ['asrApiBase', 'apiBase'],
    ['asrModel', 'model'],
    ['asrLocalModel', 'localModel'],
    ['asrLanguage', 'language'],
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
    ['ttsEngine', 'engine'],
    ['ttsLocalEngine', 'localEngine'],
    ['ttsLocalVoice', 'localVoice'],
  ],
}

/** 从 v1 搬出来的那条方案的 id 与界面上的名字：三步（迁移 / 读盘 / 落盘）都取这一处 */
export const DEFAULT_PROFILE_IDS: DefaultProfileId = {
  asr: 'asr-default',
  ai: 'ai-default',
  tts: 'tts-default',
}

export const DEFAULT_PROFILE_NAME = '默认'

/** 版本字段的名字只在这里出现一次，写盘与读盘都取它，避免拼写分叉 */
export const CURRENT_SETTINGS_VERSION_FIELD = 'schemaVersion'

/** v2 那两个新段落的名字，同上：写盘、读盘、迁移三处共用 */
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
 * v1 → v2：把 17 个扁平键按能力拆成三份各只有一条「默认」方案的列表。
 *
 * 三条规矩，都是「用户填过的东西不能再这一次搬运里丢掉」：
 * - 密钥原样搬。`v1:<base64>` 是上一版按这台机器的密钥库封的，重新加密会变成
 *   「前缀对但解不开」，界面上就显示成「Key 没配」——那是不可恢复的谎报。
 * - 扁平键搬完一律删掉。留着会出现「界面读默认方案、旧键还趴在磁盘上」，
 *   下一次保存只写方案列表，那些旧键就成了永远没人读的残留（同 v0→v1 的理由）。
 * - 只搬字符串。类型不对的值不搬，也不删掉方案里对应的位置——取值收口在
 *   settingsService 按默认值补，这一步只管形状。
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
