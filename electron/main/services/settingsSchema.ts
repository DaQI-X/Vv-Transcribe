/**
 * settings.json 的格式版本与迁移链
 *
 * 为什么要有这一层，而不是继续「读的时候顺手把旧字段搬一下」：
 * 磁盘上那份文件此前不写自己的格式版本，读的人只能靠猜——猜错了不会报错，只会把
 * 一份合法但形状不同的配置写成自己认识的样子。1.0.9 要把配置拆成多套（profile）并
 * 加历史记录，那是一次真正的结构改动；没有版本戳的话，它只能靠「有没有 profiles 字段」
 * 反推该不该搬，而那种推断在用户回退版本、或半路崩溃留下旧形状时会静默改写用户的数据。
 *
 * 两个方向要分开对待，这是整层的立意：
 * - 版本比本应用旧 → 按注册表一步步搬上来，搬完落盘（这是迁移）。
 * - 版本比本应用新 → 本应用读不懂它，绝不改名、绝不搬、绝不写回（用户可能只是装了个
 *   旧版本的应用，那份文件是他新版里正在用的东西）。这一条防的就是「装了 1.0.9 又
 *   回退到 1.0.8」时把 profiles 整段抹掉——1.0.8 不处理它，但也不能毁掉它。
 */

/** 本应用读写认到这一版；1.0.9 的多配置改动把这里推到 2，并补一条 from:1 的步骤 */
export const CURRENT_SETTINGS_VERSION = 1

/** 磁盘上还没收口成 AppSettings 的那份原始文档：字段可能是旧的、多余的、类型不对的 */
export type SettingsDocument = Record<string, unknown>

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
 * 迁移注册表。一条一步、首尾相接（0→1、1→2…）；中间缺一步会被下面的走链逻辑
 * 判成 gap 而不是「跳过那步」——跳过就等于把一份看不懂的文件当成看懂了。
 */
export const SETTINGS_MIGRATIONS: ReadonlyArray<SettingsMigration> = [
  { from: 0, to: 1, run: adoptLegacyTtsFields },
]

/** 版本字段的名字只在这里出现一次，写盘与读盘都取它，避免拼写分叉 */
export const CURRENT_SETTINGS_VERSION_FIELD = 'schemaVersion'

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
