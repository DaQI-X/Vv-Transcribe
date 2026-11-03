/**
 * settings.json 的格式版本与迁移链（settingsSchema）——纯函数，不碰磁盘。
 * 这一层是 1.0.9 多配置/历史记录的前置契约：搬动用户数据的规则要能在「只有一步生产注册表」
 * 的情况下被证明会走多步、会断链、会拒绝降级，否则等真加了一步再测就晚了。
 * target / steps 做成入参就是为了那一段能测。
 *
 * v2 落地之后生产注册表本身就有两步了，所以这里分成两半：
 * - 对真链提要求：进方案的扁平键一个不落地搬进对应那档、密钥原样搬、搬走的旧键删干净；
 *   没被方案认领的那几项（转写模式 / 本地档位 / 转写语言）留在文档根上。
 *   那才是「用户填过的东西有没有在这一次搬运里丢掉」唯一说得清的地方。
 * - 保留假注册表那些极端形状（链中间缺一步、从链中间起步）：它们在第②③步之外
 *   永远证不了，等真缺一步时再测就晚了。
 */
import { describe, expect, it } from 'vitest'
import {
  CURRENT_SETTINGS_VERSION,
  CURRENT_SETTINGS_VERSION_FIELD,
  DEFAULT_PROFILE_IDS,
  DEFAULT_PROFILE_NAME,
  PROFILE_CAPABILITIES,
  SETTINGS_MIGRATIONS,
  migrateSettingsDocument,
  readSettingsVersion,
  type MigrateOutcome,
  type ProfileCapability,
  type SettingsDocument,
  type SettingsMigration,
  type SettingsProfiles
} from '../electron/main/services/settingsSchema'

/** 给假注册表用的步骤：只往 doc 里记一笔「这一步跑过」，顺序与次数都能从数组读出来 */
function mark(name: string, from: number, to: number): SettingsMigration {
  return {
    from,
    to,
    run: (doc) => ({ ...doc, ran: [...((doc.ran as string[]) ?? []), name] })
  }
}

/** 断言「这条必须搬得动」并把文档交出来，省掉每个用例一遍 if 收窄 */
function migrated(result: MigrateOutcome): SettingsDocument {
  if (result.status !== 'migrated') throw new Error(`期望 migrated，实际 ${result.status}`)
  return result.doc
}

/** 搬完的文档必须有方案列表可读；没有就直接判红，而不是让下面每句断言各自撞 undefined */
function profilesOf(doc: SettingsDocument): SettingsProfiles {
  const profiles = doc.profiles
  if (!profiles || typeof profiles !== 'object') throw new Error('文档里没有 profiles 这一段')
  return profiles as SettingsProfiles
}

/**
 * v1 磁盘上那 17 个扁平键，按新口径拆成两张表写死，逐条列成 [扁平键, 值, 落到哪一档, 落成哪个字段]。
 * 这里刻意不 import CAPABILITY_FIELDS：表少写一条、把 localModel 归错档，
 * 用同一张表构造输入再用它断言输出会一起错过去，那样这条测试等于没写。
 *
 * asr 只有凭据三项进方案，模式 / 本地档位 / 转写语言落在下面那张全局表里——
 * 「换一家网关」换的是地址、Key、模型，语言跟着网关走是上一版拆错的地方。
 * ai / tts 这一轮还没改口径，所以仍带着各自的非凭据字段（provider / engine 等）。
 */
const V1_TO_PROFILE: ReadonlyArray<readonly [string, string, ProfileCapability, string]> = [
  ['asrApiKey', 'v1:YXNSLUtFWQ==', 'asr', 'apiKey'],
  ['asrApiBase', 'https://asr.example', 'asr', 'apiBase'],
  ['asrModel', 'whisper-1', 'asr', 'model'],
  ['aiProvider', 'openai', 'ai', 'provider'],
  ['aiApiKey', 'v1:QUktS0VZ', 'ai', 'apiKey'],
  ['aiApiBase', 'https://ai.example', 'ai', 'apiBase'],
  ['aiModel', 'gpt-4o', 'ai', 'model'],
  ['ttsApiBase', 'https://tts.example', 'tts', 'apiBase'],
  ['ttsApiKey', 'v1:VFQtS0VZ', 'tts', 'apiKey'],
  ['ttsModel', 'tts-1', 'tts', 'model'],
  ['ttsVoice', 'alloy', 'tts', 'voice'],
  ['ttsEngine', 'local', 'tts', 'engine'],
  ['ttsLocalEngine', 'kokoro-multi-lang-v1_1', 'tts', 'localEngine'],
  ['ttsLocalVoice', '3', 'tts', 'localVoice'],
]

/** 没被任何一档方案认领的键：迁移一个都不许碰，它们照原样躺在文档根上（读进内存后叫 globals） */
const V1_GLOBAL: ReadonlyArray<readonly [string, string]> = [
  ['asrProvider', 'cloud'],
  ['asrLocalModel', 'small'],
  ['asrLanguage', 'en'],
]

/** 一份写全了 v1 扁平键的文档（外加版本戳，好让这一步只测 v1→v2） */
function v1Document(extra: SettingsDocument = {}): SettingsDocument {
  return {
    [CURRENT_SETTINGS_VERSION_FIELD]: 1,
    ...Object.fromEntries(V1_TO_PROFILE.map(([flatKey, value]) => [flatKey, value])),
    ...Object.fromEntries(V1_GLOBAL),
    ...extra
  }
}

describe('readSettingsVersion：只认非负整数', () => {
  it('没有版本字段按 v0（这一版之前的文件确实不写版本号）', () => {
    expect(readSettingsVersion({})).toBe(0)
    expect(readSettingsVersion({ aiModel: 'gpt-4o' })).toBe(0)
  })

  it('写得出来的版本原样读回', () => {
    expect(readSettingsVersion({ [CURRENT_SETTINGS_VERSION_FIELD]: 0 })).toBe(0)
    expect(readSettingsVersion({ [CURRENT_SETTINGS_VERSION_FIELD]: 3 })).toBe(3)
  })

  it('字符串、小数、负数、null、NaN 都退回 v0，而不是「装懂」', () => {
    for (const bad of ['1', '1.5', 1.5, -1, -2, null, NaN, Infinity, true, {}, undefined]) {
      expect(readSettingsVersion({ [CURRENT_SETTINGS_VERSION_FIELD]: bad })).toBe(0)
    }
  })
})

describe('生产注册表：两步首尾相接', () => {
  it('0→1、1→当前版，中间不留缝', () => {
    expect(SETTINGS_MIGRATIONS.map((s) => [s.from, s.to])).toEqual([
      [0, 1],
      [1, CURRENT_SETTINGS_VERSION]
    ])
  })
})

describe('v0 → v1：搬旧配音字段', () => {
  /** 这一步的产物是「扁平的 v1」，所以显式收到 target=1，免得断言被下一步的拆表带跑 */
  const toV1 = (doc: SettingsDocument) => migrated(migrateSettingsDocument(doc, 1))

  it('旧键搬进新键，并且旧键一定从文档里消失', () => {
    const doc = toV1({ aiTtsModel: 'cosyvoice-v1', aiTtsVoice: 'zh-x' })
    expect(doc).toMatchObject({ ttsModel: 'cosyvoice-v1', ttsVoice: 'zh-x' })
    expect('aiModel' in doc).toBe(false)
    expect('aiTtsModel' in doc).toBe(false)
    expect('aiTtsVoice' in doc).toBe(false)
  })

  it('新键已经有值时不被旧键覆盖，但旧键照样删掉', () => {
    // 这条防的是「用户清空配音模型、下次启动旧值又复活」：删是无条件的，接管才有条件
    const doc = toV1({ aiTtsModel: 'old-voice', ttsModel: 'tts-1' })
    expect(doc.ttsModel).toBe('tts-1')
    expect('aiTtsModel' in doc).toBe(false)
  })

  it('旧键是空串或类型不对时不搬，但键还是要删干净', () => {
    for (const junk of ['', 123, null, ['a'], {}]) {
      const doc = toV1({ aiTtsModel: junk })
      expect('aiTtsModel' in doc).toBe(false)
      expect('ttsModel' in doc).toBe(false)
    }
  })

  it('不改传入的那份文档（迁移返回新对象，调用方手里那份还是磁盘上的样子）', () => {
    const input: SettingsDocument = { aiTtsModel: 'old' }
    migrateSettingsDocument(input)
    expect(input).toEqual({ aiTtsModel: 'old' })
  })
})

describe('v1 → v2：扁平键拆成方案列表', () => {
  it('进方案的扁平键一项不落地搬进各自那档，搬完旧键全部消失', () => {
    const result = migrateSettingsDocument(v1Document())
    if (result.status !== 'migrated') throw new Error(`期望 migrated，实际 ${result.status}`)
    // ran 记下「这一步真的跑过」，而不是「看起来已经是新形状」
    expect(result.ran).toEqual([1])
    const doc = result.doc
    const profiles = profilesOf(doc)
    for (const [flatKey, value, cap, field] of V1_TO_PROFILE) {
      // 带上扁平键名一起报：哪一条搬丢了，失败信息要说得出是哪一条
      expect(profiles[cap][0][field], `${cap}.${flatKey}`).toBe(value)
      expect(flatKey in doc, `旧扁平键 ${flatKey} 还留在文档里`).toBe(false)
    }
  })

  it('没进方案的那几项留在文档根上：搬完照原样，一条方案里都不许多出来', () => {
    // 上一版把 17 个键全塞进方案，于是每条网关各自带一份转写语言和本地档位——
    // 用户切一家网关，语言跟着换了。这一条钉的就是拆错的那三键不许再进方案
    const doc = migrated(migrateSettingsDocument(v1Document()))
    for (const [flatKey, value] of V1_GLOBAL) {
      expect(doc[flatKey], `全局键 ${flatKey} 不该被搬走或改掉`).toBe(value)
    }
    const asr = profilesOf(doc).asr[0]
    for (const [flatKey] of V1_GLOBAL) {
      expect(flatKey in asr, `全局键 ${flatKey} 不该出现在方案里`).toBe(false)
    }
    expect(Object.keys(asr).sort()).toEqual(['apiBase', 'apiKey', 'id', 'model', 'name'])
  })

  it('三把 Key 原样搬，一个字符都不改', () => {
    // 这一条是整个迁移里最贵的一条：`v1:` 那串是按这台机器的密钥库封的，
    // 搬的时候重新加密（或先解再封）都会变成「前缀对但解不开」，界面上就是「Key 没了」
    const profiles = profilesOf(migrated(migrateSettingsDocument(v1Document())))
    expect(profiles.asr[0].apiKey).toBe('v1:YXNSLUtFWQ==')
    expect(profiles.ai[0].apiKey).toBe('v1:QUktS0VZ')
    expect(profiles.tts[0].apiKey).toBe('v1:VFQtS0VZ')
  })

  it('新建的方案用固定的 id 与「默认」这个名字，defaultProfileId 指得回去', () => {
    const doc = migrated(migrateSettingsDocument(v1Document()))
    const profiles = profilesOf(doc)
    for (const cap of PROFILE_CAPABILITIES) {
      expect(profiles[cap].map((p) => p.id)).toEqual([DEFAULT_PROFILE_IDS[cap]])
      expect(profiles[cap][0].name).toBe(DEFAULT_PROFILE_NAME)
    }
    expect(doc.defaultProfileId).toEqual({ ...DEFAULT_PROFILE_IDS })
  })

  it('类型不对的扁平键不搬进方案：那个位置留空，由读盘收口补默认值', () => {
    // 迁移只管形状。在这儿顺手填 'base' 会让「这一步到底改了什么」复盘不出来
    const doc = migrated(migrateSettingsDocument(v1Document({ asrModel: 123 })))
    const asr = profilesOf(doc).asr[0]
    expect('model' in asr).toBe(false)
    // 同档其余字段照常搬，别把一条坏值变成整档失败
    expect(asr.apiBase).toBe('https://asr.example')
  })

  it('v0 的文件一路走到 v2：先接管旧配音键，再拆进方案', () => {
    // 这一步证明的是链的顺序：把两步倒过来会读不到 ttsModel，方案里就是空的
    const doc = migrated(migrateSettingsDocument({ aiTtsModel: 'cosyvoice-v1', aiTtsVoice: 'zh-x' }))
    const tts = profilesOf(doc).tts[0]
    expect(tts).toMatchObject({ model: 'cosyvoice-v1', voice: 'zh-x' })
    // 旧键与中转那份扁平键都不该留下：ttsModel 被方案认领了，v2 的磁盘上就不该再有它
    expect('aiTtsModel' in doc).toBe(false)
    expect('ttsModel' in doc).toBe(false)
  })

  it('已经是 v2 的文件：一步都不跑，原样交回同一个对象', () => {
    // 「读不懂就整理一下」是这一层最危险的想头：v2 文件里的多套方案被重新拆一遍，
    // 用户看到的保存成功其实是我们替他改过一次配置
    const doc: SettingsDocument = {
      [CURRENT_SETTINGS_VERSION_FIELD]: CURRENT_SETTINGS_VERSION,
      profiles: { asr: [{ id: 'a', name: 'A', apiKey: '' }], ai: [], tts: [] },
      defaultProfileId: { asr: 'a', ai: '', tts: '' }
    }
    const result = migrateSettingsDocument(doc)
    expect(result.status).toBe('current')
    if (result.status === 'current') expect(result.doc).toBe(doc)
  })
})

describe('走链：current / migrated / 降级 / 断链', () => {
  it('版本已经等于目标：原样返回同一个对象，一步都不跑', () => {
    const doc: SettingsDocument = { [CURRENT_SETTINGS_VERSION_FIELD]: 1, aiModel: 'gpt-4o' }
    const result = migrateSettingsDocument(doc, 1, [mark('a', 0, 1)])
    expect(result).toEqual({ status: 'current', doc, version: 1 })
  })

  it('多步按顺序跑完，ran 记下每一步的起点', () => {
    const steps = [mark('0→1', 0, 1), mark('1→2', 1, 2)]
    const result = migrateSettingsDocument({ [CURRENT_SETTINGS_VERSION_FIELD]: 0 }, 2, steps)
    expect(result).toMatchObject({ status: 'migrated', from: 0, version: 2, ran: [0, 1] })
    expect(migrated(result).ran).toEqual(['0→1', '1→2'])
  })

  it('链中间缺一步就停在缺口，绝不跳过猜着搬', () => {
    const steps = [mark('0→1', 0, 1), mark('2→3', 2, 3)]
    expect(migrateSettingsDocument({}, 3, steps)).toEqual({ status: 'gap', at: 1 })
  })

  it('注册表里完全没有这一步：报告缺口在起点', () => {
    expect(migrateSettingsDocument({}, 1, [])).toEqual({ status: 'gap', at: 0 })
  })

  it('文件比本应用新：不搬、原样交回，并把版本号报给调用方', () => {
    // 版本 3 是「下一个版本可能写出的形状」（历史记录那一段，#247）；本版本读不懂它
    const doc: SettingsDocument = {
      [CURRENT_SETTINGS_VERSION_FIELD]: 3,
      profiles: { asr: [{ id: 'a', name: '工作', apiKey: 'v1:x' }] },
      histories: [{ id: 'h1', profileIds: { asr: 'a', ai: 'b', tts: 'c' } }]
    }
    const result = migrateSettingsDocument(doc, CURRENT_SETTINGS_VERSION, SETTINGS_MIGRATIONS)
    expect(result).toEqual({ status: 'fromNewerVersion', version: 3 })
    // 关键：那份 profiles 与 histories 一个字都没被动过——本版本没有权利替新版本整理文件
    expect(doc).toEqual({
      [CURRENT_SETTINGS_VERSION_FIELD]: 3,
      profiles: { asr: [{ id: 'a', name: '工作', apiKey: 'v1:x' }] },
      histories: [{ id: 'h1', profileIds: { asr: 'a', ai: 'b', tts: 'c' } }]
    })
  })

  it('写坏的高版本号也按新版本处理，不按 v0 搬', () => {
    // 99 更可能是「未来的版本」而不是「有人手滑」，按新版本处理只会拦住写盘，
    // 按 v0 处理则会把一份看不懂的文件改写成自己认识的样子——后者才是不可恢复的那一边
    expect(migrateSettingsDocument({ [CURRENT_SETTINGS_VERSION_FIELD]: 99 })).toEqual({
      status: 'fromNewerVersion',
      version: 99
    })
  })

  it('从链中间起步：只跑还缺的那几步', () => {
    const steps = [mark('0→1', 0, 1), mark('1→2', 1, 2)]
    const result = migrateSettingsDocument({ [CURRENT_SETTINGS_VERSION_FIELD]: 1 }, 2, steps)
    expect(result.status === 'migrated' && result.ran).toEqual([1])
  })
})
