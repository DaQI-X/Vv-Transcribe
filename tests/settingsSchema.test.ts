/**
 * settings.json 的格式版本与迁移链（settingsSchema）——纯函数，不碰磁盘。
 * 这一层是 1.0.9 多配置/历史记录的前置契约：搬动用户数据的规则要能在「只有一步生产注册表」
 * 的情况下被证明会走多步、会断链、会拒绝降级，否则等真加了一步再测就晚了。
 * target / steps 做成入参就是为了这一段能测。
 */
import { describe, expect, it } from 'vitest'
import {
  CURRENT_SETTINGS_VERSION,
  CURRENT_SETTINGS_VERSION_FIELD,
  SETTINGS_MIGRATIONS,
  migrateSettingsDocument,
  readSettingsVersion,
  type MigrateOutcome,
  type SettingsDocument,
  type SettingsMigration
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

describe('生产注册表：v0 → v1 搬旧配音字段', () => {
  it('只有一步、首尾接到 CURRENT_SETTINGS_VERSION', () => {
    expect(SETTINGS_MIGRATIONS.map((s) => [s.from, s.to])).toEqual([[0, CURRENT_SETTINGS_VERSION]])
  })

  it('旧键搬进新键，并且旧键一定从文档里消失', () => {
    const doc = migrated(migrateSettingsDocument({ aiTtsModel: 'cosyvoice-v1', aiTtsVoice: 'zh-x' }))
    expect(doc).toMatchObject({ ttsModel: 'cosyvoice-v1', ttsVoice: 'zh-x' })
    expect('aiModel' in doc).toBe(false)
    expect('aiTtsModel' in doc).toBe(false)
    expect('aiTtsVoice' in doc).toBe(false)
  })

  it('新键已经有值时不被旧键覆盖，但旧键照样删掉', () => {
    // 这条防的是「用户清空配音模型、下次启动旧值又复活」：删是无条件的，接管才有条件
    const doc = migrated(migrateSettingsDocument({ aiTtsModel: 'old-voice', ttsModel: 'tts-1' }))
    expect(doc.ttsModel).toBe('tts-1')
    expect('aiTtsModel' in doc).toBe(false)
  })

  it('旧键是空串或类型不对时不搬，但键还是要删干净', () => {
    for (const junk of ['', 123, null, ['a'], {}]) {
      const doc = migrated(migrateSettingsDocument({ aiTtsModel: junk }))
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
    const doc: SettingsDocument = {
      [CURRENT_SETTINGS_VERSION_FIELD]: 2,
      profiles: [{ name: '工作' }],
      aiTtsModel: 'legacy'
    }
    const result = migrateSettingsDocument(doc, CURRENT_SETTINGS_VERSION, SETTINGS_MIGRATIONS)
    expect(result).toEqual({ status: 'fromNewerVersion', version: 2 })
    // 关键：那份 profiles（以及旧键）一个字都没被动过——本版本没有权利替新版本整理文件
    expect(doc).toEqual({
      [CURRENT_SETTINGS_VERSION_FIELD]: 2,
      profiles: [{ name: '工作' }],
      aiTtsModel: 'legacy'
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
