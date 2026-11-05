/**
 * settings.json 的格式版本与迁移链（settingsSchema）——纯函数，不碰磁盘。
 * 这一层是 1.0.9 多配置/历史记录的前置契约：搬动用户数据的规则要能在「只有一步生产注册表」
 * 的情况下被证明会走多步、会断链、会拒绝降级，否则等真加了一步再测就晚了。
 *
 * v3 之后生产注册表有三步，这里分成两半：
 * - 对真链提要求：进方案的扁平键一个不落地搬进对应那档、密钥原样搬、搬走的旧键删干净；
 *   没被方案认领的那几项（转写模式 / 本地档位 / 转写语言 / 配音引擎与本地那两样 / 配音音色）
 *   留在文档根上；v2 那份「音色在方案里」的文件要能把音色升回根上。
 *   那才是「用户填过的东西有没有在这一次搬运里丢掉」唯一说得清的地方。
 * - 保留假注册表那些极端形状（链中间缺一步、从链中间起步）：它们在第②③步之外
 *   永远证不了，等真缺一步时再测就晚了。
 * target / steps 做成入参就是为了那一段能测。
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
 * v1 磁盘上那 17 个扁平键，按**当前**口径拆成两张表写死，逐条列成 [扁平键, 值, 落到哪一档, 落成哪个字段]。
 * 这里刻意不 import CAPABILITY_FIELDS：表少写一条、把 localModel 归错档，
 * 用同一张表构造输入再用它断言输出会一起错过去，那样这条测试等于没写。
 *
 * 进方案的是「这家网关的参数」：三档各三项（地址 / Key / 模型，ai 那档另带 provider——
 * 它是「这套凭据属于哪家」的书签）。**配音音色不在里面**：v3 起它和「走不走云端」「本地档位」
 * 一样是这一批怎么选的问题，所以走下面那张全局表。
 * 剩下的都在下面那张全局表里——换一家网关时这些东西都不该跟着换。
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
]

/**
 * 没被任何一档方案认领的键：迁移一个都不许碰，它们照原样躺在文档根上（读进内存后叫 globals）。
 * ttsVoice 走这张表是双重的正确：v1 本来就把它平铺在根上，而 v3 起表里不认它，
 * 于是一路搬到当前版也还在根上——1.0.8 的用户升级后看到的音色还是自己填的那个。
 */
const V1_GLOBAL: ReadonlyArray<readonly [string, string]> = [
  ['asrProvider', 'cloud'],
  ['asrLocalModel', 'small'],
  ['asrLanguage', 'en'],
  ['ttsEngine', 'local'],
  ['ttsLocalEngine', 'kokoro-multi-lang-v1_1'],
  ['ttsLocalVoice', '3'],
  ['ttsVoice', 'alloy'],
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

describe('生产注册表：三步首尾相接', () => {
  it('0→1、1→2、2→当前版，中间不留缝', () => {
    expect(SETTINGS_MIGRATIONS.map((s) => [s.from, s.to])).toEqual([
      [0, 1],
      [1, 2],
      [2, CURRENT_SETTINGS_VERSION]
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

describe('v1 → 当前版：扁平键拆成方案列表，音色留在根上', () => {
  it('进方案的扁平键一项不落地搬进各自那档，搬完旧键全部消失', () => {
    // 这里走的是**真链**（不显式传 target），所以一个 1.0.8 用户升级后拿到什么就在这里被证明：
    // 先拆成方案列表，再跑 v2→v3——那一步对他那份文件没有可搬的东西，音色本来就在根上
    const result = migrateSettingsDocument(v1Document())
    if (result.status !== 'migrated') throw new Error(`期望 migrated，实际 ${result.status}`)
    // ran 记下「这两步真的跑过」，而不是「看起来已经是新形状」
    expect(result.ran).toEqual([1, 2])
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
    // 用户切一家网关，语言跟着换了。这一条钉的就是那些「这次任务怎么选」的键不许再进方案
    const doc = migrated(migrateSettingsDocument(v1Document()))
    for (const [flatKey, value] of V1_GLOBAL) {
      expect(doc[flatKey], `全局键 ${flatKey} 不该被搬走或改掉`).toBe(value)
    }
    for (const [flatKey] of V1_GLOBAL) {
      for (const cap of PROFILE_CAPABILITIES) {
        expect(flatKey in profilesOf(doc)[cap][0], `全局键 ${flatKey} 不该出现在 ${cap} 的方案里`).toBe(false)
      }
    }
    // 每档磁盘上的键名就是这一版的归属表：多一个键意味着有一项「全局共用」被搬进了某条方案
    expect(Object.keys(profilesOf(doc).asr[0]).sort()).toEqual(['apiBase', 'apiKey', 'id', 'model', 'name'])
    expect(Object.keys(profilesOf(doc).ai[0]).sort()).toEqual([
      'apiBase',
      'apiKey',
      'id',
      'model',
      'name',
      'provider',
    ])
    // tts 与 asr 同形：v3 起配音音色不在方案里（v1→v2 不认领它，v2→v3 又把它摘出去）
    expect(Object.keys(profilesOf(doc).tts[0]).sort()).toEqual(['apiBase', 'apiKey', 'id', 'model', 'name'])
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

  it('v0 的文件一路走到当前版：旧配音键接管后，音色留在根上、模型进方案', () => {
    // 这一步证明的是链的顺序：把两步倒过来会读不到 ttsModel，方案里就是空的。
    // 而 `aiTtsVoice`（1.0.5 之前寄存配音的旧键）搬来的那份音色，走完 v2→v3 之后
    // 落在根上——这正是「老用户的音色在升级后还是他填的那个」唯一的证明处
    const doc = migrated(migrateSettingsDocument({ aiTtsModel: 'cosyvoice-v1', aiTtsVoice: 'zh-x' }))
    expect(profilesOf(doc).tts[0]).toMatchObject({ model: 'cosyvoice-v1' })
    expect('voice' in profilesOf(doc).tts[0]).toBe(false)
    expect(doc.ttsVoice).toBe('zh-x')
    // 旧键与中转那份扁平键都不该留下：ttsModel 被方案认领了，当前版的磁盘上就不该再有它
    expect('aiTtsModel' in doc).toBe(false)
    expect('ttsModel' in doc).toBe(false)
  })

  it('已经是当前版的文件：一步都不跑，原样交回同一个对象', () => {
    // 「读不懂就整理一下」是这一层最危险的想头：文件里已有的多套方案被重新拆一遍，
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

describe('v2 → v3：配音音色从方案里搬回文档根', () => {
  /** 1.0.9 真正发出去的那份形状：音色躺在方案里，根上没有 ttsVoice */
  function v2Document(
    tts: unknown[],
    defaultTtsId: string,
    globals: SettingsDocument = {}
  ): SettingsDocument {
    return {
      [CURRENT_SETTINGS_VERSION_FIELD]: 2,
      ...globals,
      profiles: {
        asr: [{ id: 'asr-default', name: '默认', apiKey: '', model: 'whisper-1' }],
        ai: [{ id: 'ai-default', name: '默认', apiKey: '', model: 'gpt-4o' }],
        tts,
      },
      defaultProfileId: { asr: 'asr-default', ai: 'ai-default', tts: defaultTtsId },
    }
  }

  const toV3 = (doc: SettingsDocument) => migrated(migrateSettingsDocument(doc))

  it('当前使用那条的音色升到根上，方案列表里那份 voice 全部消失', () => {
    const doc = toV3(
      v2Document(
        [
          { id: 'tts-a', name: 'A', apiKey: '', model: 'tts-1', voice: 'alloy' },
          { id: 'tts-b', name: 'B', apiKey: '', model: 'cosyvoice-v2', voice: 'longxiaochun' },
        ],
        'tts-a'
      )
    )
    expect(doc.ttsVoice).toBe('alloy')
    // 列表里其余那条的音色没有第二个落点：新口径下它不属于方案，界面也没地方显示「B 套的音色」
    expect(JSON.stringify(profilesOf(doc).tts)).not.toContain('longxiaochun')
    for (const profile of profilesOf(doc).tts) {
      expect('voice' in profile, `方案 ${profile.id} 里还留着 voice`).toBe(false)
    }
    // 其余字段一个字都不许多动：这一步只摘 voice，模型名与 Key 照原样
    expect(profilesOf(doc).tts[1]).toMatchObject({ id: 'tts-b', model: 'cosyvoice-v2', apiKey: '' })
    expect(profilesOf(doc).asr[0].model).toBe('whisper-1')
  })

  it('「当前使用」指不到人（空串或写了个没见过的 id）：落回列表第一条，而不是丢掉这个值', () => {
    for (const id of ['', 'tts-ghost']) {
      const doc = toV3(
        v2Document([{ id: 'tts-a', name: 'A', apiKey: '', model: 'tts-1', voice: 'alloy' }], id)
      )
      expect(doc.ttsVoice, `defaultProfileId.tts = ${JSON.stringify(id)}`).toBe('alloy')
    }
  })

  it('根上已经有个字符串就不接管，但方案里那份照样删干净', () => {
    // 根上那份是新形状写出来的（手改文件也照这条走）：谁的时代新用谁的。
    // 这一条同时也钉住「删」是无条件的——留着方案里那份就成了没人读的残留
    const doc = toV3(
      v2Document([{ id: 'tts-a', name: 'A', apiKey: '', model: 'tts-1', voice: 'alloy' }], 'tts-a', {
        ttsVoice: 'nova'
      })
    )
    expect(doc.ttsVoice).toBe('nova')
    expect('voice' in profilesOf(doc).tts[0]).toBe(false)
  })

  it('donor 的音色是空串或类型不对：根上不多这个键，也不替它编一个值', () => {
    // 取值收口在 settingsService 按默认值补；在这儿顺手填 'alloy' 会让这一步复盘不出来
    for (const junk of [undefined, '', 123, null, ['a'], {}]) {
      const doc = toV3(v2Document([{ id: 'tts-a', name: 'A', apiKey: '', model: 'tts-1', voice: junk }], 'tts-a'))
      expect('ttsVoice' in doc, `junk=${JSON.stringify(junk)} 时根上多出了一个音色`).toBe(false)
      expect('voice' in profilesOf(doc).tts[0]).toBe(false)
    }
  })

  it('profiles 整段缺失、tts 不是数组、条目不是对象：不报错，那些形状原样交给读盘收口', () => {
    // 这一步只负责把 voice 从 tts 那几条方案上摘掉。真去替 normalizeStore 收拾坏形状，
    // 就会出现「一次升级顺手改了用户没打算改的值」那种没法复盘的迁移
    for (const profiles of [undefined, 'nope', {}, { tts: 'nope' }, { tts: [null, 7, ['x']] }]) {
      const doc = toV3({ [CURRENT_SETTINGS_VERSION_FIELD]: 2, profiles })
      expect(doc.profiles).toEqual(profiles)
    }
  })

  it('不改传入的那份文档：连嵌套的方案对象都不许原地删键', () => {
    // splitFlatIntoProfiles 只重建了根，所以「返回新对象」在那一步几乎免费；这一步要动
    // profiles.tts 里的每一条，顺手 map 成原地 delete 就会把调用方手里那份磁盘快照改花
    const profile = { id: 'tts-a', name: 'A', apiKey: '', model: 'tts-1', voice: 'alloy' }
    const input = v2Document([profile], 'tts-a')
    migrateSettingsDocument(input)
    expect(input).toEqual(v2Document([profile], 'tts-a'))
    expect(profile.voice).toBe('alloy')
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
    // 版本 4 是「下一个版本可能写出的形状」；本版本读不懂它
    const doc: SettingsDocument = {
      [CURRENT_SETTINGS_VERSION_FIELD]: 4,
      profiles: { asr: [{ id: 'a', name: '工作', apiKey: 'v1:x' }] },
      histories: [{ id: 'h1', profileIds: { asr: 'a', ai: 'b', tts: 'c' } }]
    }
    const result = migrateSettingsDocument(doc, CURRENT_SETTINGS_VERSION, SETTINGS_MIGRATIONS)
    expect(result).toEqual({ status: 'fromNewerVersion', version: 4 })
    // 关键：那份 profiles 与 histories 一个字都没被动过——本版本没有权利替新版本整理文件
    expect(doc).toEqual({
      [CURRENT_SETTINGS_VERSION_FIELD]: 4,
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
