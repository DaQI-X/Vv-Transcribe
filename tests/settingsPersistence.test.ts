/**
 * settings.json 的读盘/写盘契约。
 * 这里测的不是某个函数返回什么，而是「磁盘出问题时，用户填过的 Key 还在不在」：
 * 旧写法把一个 catch 等同于「给默认值」，于是半截 JSON、只读介质都会让界面以为「用户还没填」，
 * 用户点一次保存就把原来那份盖掉了——1.0.8 把这条排进 P0 就是因为它丢的是不可恢复的数据。
 * 后半段的「配置格式版本」是同一个问题的另一面：旧文件搬上来要盖戳，本版本读不懂的新文件
 * 既不搬、不改名、不写回——读不懂不等于坏了，把它当坏的就会抹掉更新版本正在用的配置。
 *
 * 1.0.9 的第①步把磁盘形状换成了按能力分列的方案列表（v2），这一层因此多出两条新的闸门，
 * 都在下面：一次读盘/保存不许把用户没碰过的那几套方案弄没（列表是对象数组，
 * 「只收字符串」的旧收口会静默吃掉它），也不许把已经封好的 Key 在搬家路上换成一串解不开的。
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SETTINGS_WRITE_BLOCKED,
  SETTINGS_WRITE_BLOCKED_NEWER_VERSION
} from '../electron/main/services/settingsService'
import {
  DEFAULT_PROFILE_IDS,
  type DefaultProfileId,
  type SettingsProfiles
} from '../electron/main/services/settingsSchema'

type Service = typeof import('../electron/main/services/settingsService')

let dir = ''
let service: Service

const file = () => join(dir, 'settings.json')

/** 换一份干净的 userData：用例里中途换目录时必须先删掉旧的，不然临时目录会越堆越多 */
async function resetDir(): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  dir = await mkdtemp(join(tmpdir(), 'vv-settings-'))
}

/**
 * 每个用例都要一份全新的模块：cache / loadProblem / writeBlocked 是模块级状态，
 * 不重灌就会把上一个用例的结论带进来。setup.ts 里的 electron 替身在 resetModules 之后
 * 仍是同一个对象（实测过），所以这里 spyOn 就够用，不必为了测试给生产代码开后门。
 */
async function loadInto(freshDir: string): Promise<void> {
  vi.resetModules()
  vi.spyOn(app, 'getPath').mockImplementation(
    ((name: string) => (name === 'userData' ? freshDir : join(freshDir, name))) as typeof app.getPath
  )
  service = await import('../electron/main/services/settingsService')
}

async function namesWith(prefix: string): Promise<string[]> {
  return (await readdir(dir))
    .filter((name) => name.startsWith(prefix))
    .sort()
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
}

/** 读磁盘上那三列方案：先判形状，免得一句 `undefined.x` 把断言失败伪装成 TypeError */
function diskProfiles(doc: Record<string, unknown>): SettingsProfiles {
  const profiles = doc.profiles
  if (!profiles || typeof profiles !== 'object') throw new Error('磁盘上没有 profiles 这一段')
  return profiles as SettingsProfiles
}

/** 按 id 从磁盘那一列里挑方案；挑不到就判红，别让「没了」看起来像「值不一样」 */
function diskProfile(
  doc: Record<string, unknown>,
  cap: keyof SettingsProfiles,
  id = DEFAULT_PROFILE_IDS[cap]
): Record<string, string> {
  const found = diskProfiles(doc)[cap].find((p) => p.id === id)
  if (!found) throw new Error(`磁盘上 ${cap} 那一列里没有方案 ${id}`)
  return found as unknown as Record<string, string>
}

/** 一份 v2 形状的磁盘内容：默认三档各一条方案，按档整体替换或改默认指向 */
function v2Document(
  profiles: Partial<Record<keyof SettingsProfiles, Array<Record<string, unknown>>>> = {},
  defaultProfileId: Partial<DefaultProfileId> = {}
): string {
  return JSON.stringify(
    {
      schemaVersion: 2,
      profiles: {
        asr: [{ id: 'asr-default', name: '默认', apiKey: '', provider: 'local' }],
        ai: [{ id: 'ai-default', name: '默认', apiKey: '', model: 'gpt-4o' }],
        tts: [{ id: 'tts-default', name: '默认', apiKey: '', engine: 'cloud' }],
        ...profiles
      },
      defaultProfileId: { ...DEFAULT_PROFILE_IDS, ...defaultProfileId }
    },
    null,
    2
  )
}

beforeEach(resetDir)

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('首次运行', () => {
  it('没有 settings.json 时按默认值起来，storageProblem 是 null（没文件不是故障）', async () => {
    await loadInto(dir)
    const settings = await service.loadSettings()
    expect(settings.asrProvider).toBe('local')
    expect(settings.aiApiBase).toBe('')
    expect((await service.getSettingsView()).storageProblem).toBeNull()
    // 只读不该在磁盘上留下任何文件：首次启动的用户此刻还没有一份需要他负责的配置
    expect(await readdir(dir)).toEqual([])
  })
})

describe('正常读写', () => {
  it('Key 以 v1: 密文落盘，重新载入后还能解出来（模拟一次重启）', async () => {
    await loadInto(dir)
    await service.saveSettings({ asrApiKey: 'sk-first-abcdef', aiModel: 'gpt-4o' })
    expect(diskProfile(await readJson(file()), 'asr').apiKey).toMatch(/^v1:/)
    expect(await readFile(file(), 'utf-8')).not.toContain('sk-first-abcdef')

    await loadInto(dir)
    const reloaded = await service.loadSettings()
    expect(reloaded.asrApiKey).toBe('sk-first-abcdef')
    expect(reloaded.aiModel).toBe('gpt-4o')
    expect((await service.getSettingsView()).asrKeyStatus).toBe('encrypted')
  })

  it('第二次保存前把上一份复制成 .bak，里面是被替换掉的那一版', async () => {
    await loadInto(dir)
    await service.saveSettings({ asrApiKey: 'sk-first-abcdef' })
    const first = diskProfile(await readJson(file()), 'asr').apiKey
    expect(await namesWith('settings.json.bak')).toEqual([])

    await service.saveSettings({ asrApiKey: 'sk-second-uvwxyz' })
    const backup = diskProfile(await readJson(`${file()}.bak`), 'asr').apiKey
    expect(backup).toBe(first)
    expect(diskProfile(await readJson(file()), 'asr').apiKey).not.toBe(first)
  })

  it('留空＝不改、null＝清除：只改模型名不会把磁盘上那把 Key 弄丢', async () => {
    await loadInto(dir)
    await service.saveSettings({ aiApiKey: 'sk-keep-me' })
    await service.saveSettings({ aiModel: 'gpt-4o-mini' })
    expect((await service.loadSettings()).aiApiKey).toBe('sk-keep-me')

    await service.saveSettings({ aiApiKey: null })
    expect((await service.loadSettings()).aiApiKey).toBe('')
  })
})

describe('settings.json 解不开（corrupt）', () => {
  const broken = '{"asrProvider":"local","aiApiKey":"v1:'

  it('原件改名留档、内容一字不差，界面拿到那句提示', async () => {
    await writeFile(file(), broken)
    await loadInto(dir)

    const problem = (await service.getSettingsView()).storageProblem
    expect(problem).toContain('没能解析')
    const archived = await namesWith('settings.json.corrupt-')
    expect(archived).toHaveLength(1)
    expect(problem).toContain(archived[0])
    expect(await readFile(join(dir, archived[0]), 'utf-8')).toBe(broken)
    // 坏的那份不再占着原位，下一次写盘是全新的一份，不会跟半截内容混在一起
    await expect(readFile(file(), 'utf-8')).rejects.toThrow('ENOENT')
  })

  it('留档之后允许写回新配置，但「原件被留档过」不会因为写盘成功而消失', async () => {
    await writeFile(file(), broken)
    await loadInto(dir)
    await service.getSettingsView()
    const archived = (await namesWith('settings.json.corrupt-'))[0]

    await service.saveSettings({ aiModel: 'gpt-4o' })
    expect(diskProfile(await readJson(file()), 'ai').model).toBe('gpt-4o')
    // 这条是设计决定，不是实现巧合：留档发生过，界面就得一直说得出原件在哪个文件里
    expect((await service.getSettingsView()).storageProblem).toContain(archived)
  })

  it('空文件与「解得开但不是对象」都按解析失败留档，不会当成一份合法配置', async () => {
    for (const content of ['', 'null', '[1,2]', '"asr"']) {
      await resetDir()
      await writeFile(file(), content)
      await loadInto(dir)
      expect((await service.getSettingsView()).storageProblem).toContain('没能解析')
      expect(await namesWith('settings.json.corrupt-')).toHaveLength(1)
    }
  })

  it('留档最多只留最新 5 份：每次启动都坏一次的话，不能把数据目录变成垃圾场', async () => {
    for (let i = 0; i < 7; i++) {
      await writeFile(join(dir, `settings.json.corrupt-2026010${i}-000000`), 'x')
    }
    await writeFile(file(), broken)
    await loadInto(dir)
    await service.getSettingsView()

    const kept = await namesWith('settings.json.corrupt-')
    expect(kept).toHaveLength(5)
    expect(kept).not.toContain('settings.json.corrupt-20260100-000000')
    expect(kept).toContain('settings.json.corrupt-20260106-000000')
  })
})

describe('settings.json 读不出内容（unreadable）', () => {
  /**
   * 用「settings.json 是个目录」造这个状态：readFile 稳定抛 EISDIR（本机实测），
   * 而且不像 chmod 那样——CI 里以 root 跑时权限位根本不拦人，会测出一个假通过。
   */
  beforeEach(async () => {
    await mkdir(file())
  })

  it('提示里带上 errno 和「保存已停用」，且这份配置不会被就地覆盖', async () => {
    await loadInto(dir)
    const problem = (await service.getSettingsView()).storageProblem
    expect(problem).toContain('EISDIR')
    expect(problem).toContain('保存已暂时停用')
    expect((await readdir(dir)).includes('settings.json')).toBe(true)
  })

  it('本次禁止写盘：连内容都没读到，写下去就是把猜测盖到用户的东西上', async () => {
    await loadInto(dir)
    await expect(service.saveSettings({ aiModel: 'gpt-4o' })).rejects.toThrow(SETTINGS_WRITE_BLOCKED)
    // 闸门在碰磁盘之前就落下：既不写 .tmp，也不复制 .bak（那份读不出来的东西不该被任何人读过一遍就改名）
    expect((await readdir(dir)).includes('settings.json.tmp')).toBe(false)
    expect((await readdir(dir)).includes('settings.json.bak')).toBe(false)
  })
})

describe('配置格式版本（schemaVersion 与迁移链）', () => {
  it('没有版本字段的旧文件：一路搬到 v2 并把版本盖回去，而且这事不打扰用户', async () => {
    // 1.0.5 及之前的文件确实不写版本号，这一条既是迁移也是「别再靠猜」的收口：
    // 只有写盘那一处产生版本字段，下一个读的人不用再猜第二遍
    await writeFile(file(), JSON.stringify({ aiTtsModel: 'cosyvoice-v1', aiModel: 'gpt-4o' }))
    await loadInto(dir)

    const settings = await service.loadSettings()
    expect(settings.ttsModel).toBe('cosyvoice-v1')
    expect(settings.aiModel).toBe('gpt-4o')
    expect((await service.getSettingsView()).storageProblem).toBeNull()

    const onDisk = await readJson(file())
    expect(onDisk.schemaVersion).toBe(2)
    expect('aiTtsModel' in onDisk).toBe(false)
    expect('ttsModel' in onDisk).toBe(false)
    expect(diskProfile(onDisk, 'tts').model).toBe('cosyvoice-v1')
  })

  it('版本已经是当前值：读完一个字节都不动', async () => {
    // 迁移不是「顺手整理一下」。文件说自己已经是 v2 了还去重写，用户看到的保存成功
    // 其实是我们替他改过一次配置，而这次改动没有任何人要求过
    const content = v2Document()
    await writeFile(file(), content)
    await loadInto(dir)
    await service.loadSettings()
    await service.getSettingsView()
    expect(await readFile(file(), 'utf-8')).toBe(content)
    expect(await namesWith('settings.json')).toEqual(['settings.json'])
  })

  it('文件来自更新版本：界面说得出是哪个版本，写盘被拦，那份文件一字未动', async () => {
    // 这条防的是「装了 1.0.10 又回退到本版」：v3 的历史记录那一段（#247）本版本读不懂，
    // 但读不懂不等于坏了——改名留档会挪走人家正在用的配置，写回会抹掉 histories
    const content = JSON.stringify(
      {
        schemaVersion: 3,
        profiles: { asr: [{ id: 'a', name: '工作', apiKey: 'v1:x' }] },
        defaultProfileId: { asr: 'a', ai: 'b', tts: 'c' },
        histories: [{ id: 'h1', profileIds: { asr: 'a', ai: 'b', tts: 'c' } }]
      },
      null,
      2
    )
    await writeFile(file(), content)
    await loadInto(dir)

    const view = await service.getSettingsView()
    expect(view.storageProblem).toContain('更新版本')
    expect(view.storageProblem).toContain('v3')
    expect(view.aiModel).toBe('')

    await expect(service.saveSettings({ aiModel: 'gpt-4o-mini' })).rejects.toThrow(
      SETTINGS_WRITE_BLOCKED_NEWER_VERSION
    )
    expect(await readFile(file(), 'utf-8')).toBe(content)
    // 不改名（那是「它坏了」的说法，可它没坏）、不备份、不留临时文件。按前缀筛而不是比整个目录：
    // 这一条会写 ERROR 日志，userData 下多一个 logs/ 是正常的
    expect(await namesWith('settings.json')).toEqual(['settings.json'])
  })

  it('版本写坏成字符串/小数时不按「未来版本」处理：先搬回当前再盖新戳', async () => {
    // 与上一条的分别是「哪个方向更可恢复」：这种写法更像是有人手改坏了文件，
    // 按 v0 走两步就把它整理回本版本认得的样子；装成未来版本会让人一直卡在写不进去
    await writeFile(file(), JSON.stringify({ schemaVersion: '1', aiTtsModel: 'old-voice' }))
    await loadInto(dir)
    expect((await service.getSettingsView()).storageProblem).toBeNull()
    const onDisk = await readJson(file())
    expect(onDisk.schemaVersion).toBe(2)
    expect(diskProfile(onDisk, 'tts').model).toBe('old-voice')
    expect('aiTtsModel' in onDisk).toBe(false)
  })

  it('旧字段与历史明文 Key 同时存在时，一次读盘就把两件事都办完', async () => {
    // 迁移写盘与密钥就地加密各写一次，中间那次留下的 .bak 是「搬完但还没加密」的那份——
    // 这条测的是两次写不打架：最终的磁盘上版本、字段、密文三样都对
    await writeFile(
      file(),
      JSON.stringify({ aiTtsModel: 'cosyvoice-v1', aiApiKey: 'sk-legacy-plaintext' })
    )
    await loadInto(dir)
    expect((await service.loadSettings()).aiApiKey).toBe('sk-legacy-plaintext')

    const onDisk = await readJson(file())
    expect(onDisk.schemaVersion).toBe(2)
    expect('aiTtsModel' in onDisk).toBe(false)
    expect('aiApiKey' in onDisk).toBe(false)
    expect(diskProfile(onDisk, 'ai').apiKey).toMatch(/^v1:/)
    expect(await readFile(file(), 'utf-8')).not.toContain('sk-legacy-plaintext')

    // 内存里那份照常能用：迁移写盘失败也不该让用户觉得自己的配置没了（见 readCache 的 WARN 分支）
    const inMemory = await service.loadSettings()
    expect(inMemory.aiApiKey).toBe('sk-legacy-plaintext')
    expect(inMemory.ttsModel).toBe('cosyvoice-v1')

    // 再重灌一次模块当「重启应用」：磁盘上那份必须自己站得住——版本对、旧键没了、密文解得开
    await loadInto(dir)
    const rebooted = await service.loadSettings()
    expect(rebooted.aiApiKey).toBe('sk-legacy-plaintext')
    expect(rebooted.ttsModel).toBe('cosyvoice-v1')
  })
})

describe('多方案（v2）的两道闸门', () => {
  /** setup.ts 里那份假加密的可解形式：`v1:` + base64('fake:<明文>') */
  const sealed = (plain: string) => `v1:${Buffer.from(`fake:${plain}`, 'utf-8').toString('base64')}`

  it('一次保存不许吃掉用户没碰过的那套方案，也不许动它的 Key', async () => {
    // 这就是第①步最容易翻车的一处：v1 时代的读盘收口「只收字符串」，而方案列表是对象数组。
    // 照那份写法，用户在这里加的第二套方案会「读成功、写成功、东西没了」——
    // 一次普通的改模型名就把他另一套配置抹了，而且界面上一句错都不报
    const other = {
      id: 'asr-work',
      name: '工作',
      provider: 'openai',
      apiBase: 'https://work.example',
      model: 'whisper-1',
      apiKey: sealed('sk-other-abcdef')
    }
    await writeFile(
      file(),
      v2Document({
        asr: [{ id: 'asr-default', name: '默认', apiKey: '', model: 'first' }, other]
      })
    )
    await loadInto(dir)

    await service.saveSettings({ asrModel: 'renamed' })

    const onDisk = await readJson(file())
    expect(diskProfiles(onDisk).asr).toHaveLength(2)
    expect(diskProfile(onDisk, 'asr').model).toBe('renamed')
    // 没碰过的那条逐个字段比回去：他写的每一项都还是原样（读盘时按默认值补齐的其余字段不算改动）
    expect(diskProfile(onDisk, 'asr', 'asr-work')).toMatchObject(other)
    expect(onDisk.defaultProfileId).toEqual({ ...DEFAULT_PROFILE_IDS })
    // 明文也不许从别的方案身上漏出来
    expect(await readFile(file(), 'utf-8')).not.toContain('sk-other-abcdef')
  })

  it('就地加密历史明文时，只碰确实明文的那几条', async () => {
    // 读到明文 Key 会就地加密回写；这一趟不许把旁边那条已经是密文的「整理」一遍——
    // 重新加密出来的新串跟旧的不等长，用户看不见差别，但任何按密文比对的工具都会失配
    await writeFile(
      file(),
      v2Document({
        asr: [
          { id: 'asr-default', name: '默认', apiKey: 'sk-plain-one', model: 'first' },
          { id: 'asr-work', name: '工作', apiKey: sealed('sk-already-sealed') }
        ]
      })
    )
    await loadInto(dir)
    expect((await service.loadSettings()).asrApiKey).toBe('sk-plain-one')

    const onDisk = await readJson(file())
    expect(diskProfile(onDisk, 'asr').apiKey).not.toBe('sk-plain-one')
    expect(diskProfile(onDisk, 'asr').apiKey).toMatch(/^v1:/)
    expect(diskProfile(onDisk, 'asr', 'asr-work').apiKey).toBe(sealed('sk-already-sealed'))
    expect(await readFile(file(), 'utf-8')).not.toContain('sk-plain-one')
    expect(await readFile(file(), 'utf-8')).not.toContain('sk-already-sealed')
  })

  it('默认方案不是列表第一条时，取值与状态都跟着默认那条走', async () => {
    // 取成「列表第一条」的话，界面显示的和实际用的会分叉成两套配置，
    // 而第①步还没有任何界面能看出来——只能靠这条测试拦住
    await writeFile(
      file(),
      v2Document(
        {
          asr: [
            { id: 'asr-first', name: '第一套', apiKey: '', model: 'not-this-one' },
            { id: 'asr-selected', name: '在用的这套', apiKey: sealed('sk-selected'), model: 'this-one' }
          ]
        },
        { asr: 'asr-selected' }
      )
    )
    await loadInto(dir)

    const settings = await service.loadSettings()
    expect(settings.asrModel).toBe('this-one')
    expect(settings.asrApiKey).toBe('sk-selected')
    expect((await service.getSettingsView()).asrKeyStatus).toBe('encrypted')

    // 保存的落点也必须是默认那条：写进列表第一条就是当着用户的面改错一套配置
    await service.saveSettings({ asrLanguage: 'en' })
    const onDisk = await readJson(file())
    expect(diskProfile(onDisk, 'asr', 'asr-selected').language).toBe('en')
    expect(diskProfile(onDisk, 'asr', 'asr-first').model).toBe('not-this-one')
  })

  it('手写文件里 defaultProfileId 指不到任何方案：落回第一条，不崩、不凭空造方案', async () => {
    // 磁盘是系统边界：这一条不许假设「我们写出去的 id 一定指得到人」
    await writeFile(
      file(),
      JSON.stringify(
        {
          schemaVersion: 2,
          profiles: {
            asr: [{ id: 'asr-a', name: 'A', model: 'first' }],
            ai: [],
            tts: []
          },
          defaultProfileId: { asr: 'asr-ghost', ai: 'ai-ghost', tts: 'tts-ghost' }
        },
        null,
        2
      )
    )
    await loadInto(dir)

    const settings = await service.loadSettings()
    expect(settings.asrModel).toBe('first')
    expect((await service.getSettingsView()).storageProblem).toBeNull()

    await service.saveSettings({ asrProvider: 'openai' })
    const onDisk = await readJson(file())
    // 空列表那两档补一条默认方案，指不到的 id 落成真正存在的 id
    expect(diskProfiles(onDisk).ai).toHaveLength(1)
    expect(onDisk.defaultProfileId).toEqual({ asr: 'asr-a', ai: 'ai-default', tts: 'tts-default' })
  })
})
