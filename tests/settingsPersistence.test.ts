/**
 * settings.json 的读盘/写盘契约。
 * 这里测的不是某个函数返回什么，而是「磁盘出问题时，用户填过的 Key 还在不在」：
 * 旧写法把一个 catch 等同于「给默认值」，于是半截 JSON、只读介质都会让界面以为「用户还没填」，
 * 用户点一次保存就把原来那份盖掉了——1.0.8 把这条排进 P0 就是因为它丢的是不可恢复的数据。
 * 后半段的「配置格式版本」是同一个问题的另一面：旧文件搬上来要盖戳，本版本读不懂的新文件
 * 既不搬、不改名、不写回——读不懂不等于坏了，把它当坏的就会抹掉更新版本正在用的配置。
 *
 * 1.0.9 把磁盘形状换成了按能力分列的**云端方案**列表（v2），这一层因此多出几条新的闸门与契约，
 * 都在下面：一次读盘/保存不许把用户没碰过的那几套方案弄没（列表是对象数组，
 * 「只收字符串」的旧收口会静默吃掉它），也不许把已经封好的 Key 在搬家路上换成一串解不开的。
 * 字段归属定了两次：v2 说方案里只躺这家网关的参数（接口地址 / Key / 模型，配音另加音色），
 * 1.1.0 的 v3 把配音音色也挪回文档根——所以下面大部分用例是拿**真 v2 文件**读过来的
 * （顺手把迁移跑一遍），只有「版本对上了就别动手」那几条用本版本自己写的形状。
 * 「磁盘上这条方案的 keys 有哪几个」本身就是要被测的契约，它是下一个版本要读的东西。
 * 三档列表都可以是空的（还没建过云端方案），空列表在落盘后仍然是空的：
 * 读盘与写盘都不许凭空补一条用户没建过的方案。
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
  CURRENT_SETTINGS_VERSION,
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

/** setup.ts 里那份假加密的可解形式：`v1:` + base64('fake:<明文>') */
const sealed = (plain: string) => `v1:${Buffer.from(`fake:${plain}`, 'utf-8').toString('base64')}`

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

/**
 * 一份磁盘内容：三档各一条默认方案、默认指向、以及**平铺在根上的全局段**
 * （asrProvider / asrLocalModel / asrLanguage / ttsEngine 这些不属于任何方案的键）。
 * 全局段必须能表达，因为「保存改了档位／引擎」看得见的位置就是文档根。
 *
 * `at` 决定它长成一版还是三版，这是这一层唯一的形状来源：v2（1.0.9 发出去的那份）把配音音色
 * 存在方案里，v3 起它在根上叫 `ttsVoice`。「读一份真用户的旧文件」与「读本版本自己写的文件」
 * 只有靠这个参数才分得开——而这两条路的证据不一样：前者测迁移，后者测「版本没对上就别动手」。
 *
 * 方案里只躺**那一版认得的**方案字段（地址 / Key / 模型，v2 的配音另加音色、校对另带服务商）。
 * 「引擎」这种已经挪去全局段的键不放进来——放了它，每个用例都等于顺带测一次中途形状的救援，
 * 那份证据就该由「字段归属改过」那条单独给。
 */
function diskDocument(
  at: number,
  profiles: Partial<Record<keyof SettingsProfiles, Array<Record<string, unknown>>>> = {},
  defaultProfileId: Partial<DefaultProfileId> = {},
  globals: Record<string, unknown> = {}
): string {
  const ttsDefault: Record<string, unknown> = {
    id: 'tts-default',
    name: '默认',
    apiKey: '',
    model: 'tts-1',
    ...(at >= 3 ? {} : { voice: 'alloy' })
  }
  return JSON.stringify(
    {
      schemaVersion: at,
      ...(at >= 3 ? { ttsVoice: 'alloy' } : {}),
      ...globals,
      profiles: {
        asr: [{ id: 'asr-default', name: '默认', apiKey: '', model: 'asr-default-model' }],
        ai: [{ id: 'ai-default', name: '默认', apiKey: '', model: 'gpt-4o' }],
        tts: [ttsDefault],
        ...profiles
      },
      defaultProfileId: { ...DEFAULT_PROFILE_IDS, ...defaultProfileId }
    },
    null,
    2
  )
}

/** 1.0.9 真发出去的那份形状：读它等于走一次 v2→v3 */
function v2Document(
  profiles: Partial<Record<keyof SettingsProfiles, Array<Record<string, unknown>>>> = {},
  defaultProfileId: Partial<DefaultProfileId> = {},
  globals: Record<string, unknown> = {}
): string {
  return diskDocument(2, profiles, defaultProfileId, globals)
}

/** 本版本自己写得出来的形状：读它一个字节都不该动 */
function v3Document(
  profiles: Partial<Record<keyof SettingsProfiles, Array<Record<string, unknown>>>> = {},
  defaultProfileId: Partial<DefaultProfileId> = {},
  globals: Record<string, unknown> = {}
): string {
  return diskDocument(CURRENT_SETTINGS_VERSION, profiles, defaultProfileId, globals)
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
    // 先放一份磁盘上已有的配置：三档首次运行都是 0 条方案，而凭据只能写进某一条方案里
    // （这一条要核的是密文往返，不是「没地方写」那句规矩）
    await writeFile(file(), v2Document())
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
    // 从一个空目录开始：三档首次运行都是空列表，所以「建第一条方案」就是这里的第 1 次写盘。
    // 它之前磁盘上没有文件可备份，所以那句「还没有 .bak」量的正是「第一次写不产生备份」
    await loadInto(dir)
    const created = await service.createProfile('ai', { values: { aiModel: 'gpt-4o' } })
    const id = created.profiles.ai[0].id
    expect(await namesWith('settings.json.bak')).toEqual([])

    await service.saveSettings({ aiApiKey: 'sk-first-abcdef' })
    const first = diskProfile(await readJson(file()), 'ai', id).apiKey
    expect(first).toMatch(/^v1:/)

    await service.saveSettings({ aiApiKey: 'sk-second-uvwxyz' })
    const backup = diskProfile(await readJson(`${file()}.bak`), 'ai', id).apiKey
    expect(backup).toBe(first)
    expect(diskProfile(await readJson(file()), 'ai', id).apiKey).not.toBe(first)
  })

  it('留空＝不改、null＝清除：只改模型名不会把磁盘上那把 Key 弄丢', async () => {
    await writeFile(file(), v2Document())
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

    // 那份半截文件已经挪走，此刻的 store 是默认那份（三档都空）——所以建一条方案是
    // 「写回新配置」最短的一次写；下面那句 storageProblem 才是这条真正要核的东西
    const created = await service.createProfile('ai', { values: { aiModel: 'gpt-4o' } })
    const createdId = created.profiles.ai[0].id
    expect(diskProfile(await readJson(file()), 'ai', createdId).model).toBe('gpt-4o')
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
  it('没有版本字段的旧文件：一路搬到当前版并把版本盖回去，而且这事不打扰用户', async () => {
    // 1.0.5 及之前的文件确实不写版本号，这一条既是迁移也是「别再靠猜」的收口：
    // 只有写盘那一处产生版本字段，下一个读的人不用再猜第二遍。
    // 这份输入故意带上寄存过的旧配音键：走完三步之后它落在**根上**（v3 的音色归属），
    // 而模型名进了方案——一条链走到底的样子只有在这儿看得见
    await writeFile(file(), JSON.stringify({ aiTtsModel: 'cosyvoice-v1', aiTtsVoice: 'zh-x', aiModel: 'gpt-4o' }))
    await loadInto(dir)

    const settings = await service.loadSettings()
    expect(settings.ttsModel).toBe('cosyvoice-v1')
    expect(settings.ttsVoice).toBe('zh-x')
    expect(settings.aiModel).toBe('gpt-4o')
    expect((await service.getSettingsView()).storageProblem).toBeNull()

    const onDisk = await readJson(file())
    expect(onDisk.schemaVersion).toBe(CURRENT_SETTINGS_VERSION)
    expect(onDisk.ttsVoice).toBe('zh-x')
    expect('aiTtsModel' in onDisk).toBe(false)
    expect('aiTtsVoice' in onDisk).toBe(false)
    expect('ttsModel' in onDisk).toBe(false)
    expect(diskProfile(onDisk, 'tts').model).toBe('cosyvoice-v1')
    expect('voice' in diskProfile(onDisk, 'tts')).toBe(false)
  })

  it('1.0.9 那份 v2 文件：音色升到根上并当场写回，方案列表其余一个字都不动', async () => {
    // 这一条是 v2→v3 唯一「连磁盘一起」的证据：settingsSchema 那边证的是纯函数，
    // 而用户实际撞上的是「升级后第一次启动就把他的文件改了形状」——改完必须自己站得住，
    // 下次启动不能再靠内存里那一次搬运
    const key = sealed('sk-tts-abcdef')
    await writeFile(
      file(),
      v2Document({
        tts: [
          { id: 'tts-default', name: '默认', apiKey: '', model: 'tts-1', voice: 'alloy' },
          { id: 'tts-work', name: '工作', apiKey: key, apiBase: 'https://work.example', model: 'cosyvoice-v2', voice: 'longxiaochun' }
        ]
      })
    )
    await loadInto(dir)
    expect((await service.loadSettings()).ttsVoice).toBe('alloy')
    expect((await service.loadSettings({ tts: 'tts-work' })).ttsModel).toBe('cosyvoice-v2')

    const onDisk = await readJson(file())
    expect(onDisk.schemaVersion).toBe(CURRENT_SETTINGS_VERSION)
    // donor 是「当前使用」那条（默认指向 tts-default），所以根上留下的是它那份音色；
    // 另一条的音色没有第二个落点——见 liftTtsVoiceToRoot 正文里那条取舍
    expect(onDisk.ttsVoice).toBe('alloy')
    expect('voice' in diskProfile(onDisk, 'tts', 'tts-default')).toBe(false)
    expect('voice' in diskProfile(onDisk, 'tts', 'tts-work')).toBe(false)
    // 而那一条方案的凭据、地址、模型必须原样还在（搬音色不是「整理列表」的许可证）
    expect(diskProfile(onDisk, 'tts', 'tts-work')).toMatchObject({ apiBase: 'https://work.example', model: 'cosyvoice-v2' })
    expect(diskProfile(onDisk, 'tts', 'tts-work').apiKey).toBe(key)

    // 当「重启一次」：磁盘上那份得自己站得住，不靠内存里那一次升字段
    await loadInto(dir)
    expect((await service.loadSettings()).ttsVoice).toBe('alloy')
    expect(await namesWith('settings.json.corrupt-')).toEqual([])
  })

  it('版本已经是当前值：读完一个字节都不动', async () => {
    // 迁移不是「顺手整理一下」。文件说自己已经是当前版了还去重写，用户看到的保存成功
    // 其实是我们替他改过一次配置，而这次改动没有任何人要求过
    const content = v3Document()
    await writeFile(file(), content)
    await loadInto(dir)
    await service.loadSettings()
    await service.getSettingsView()
    expect(await readFile(file(), 'utf-8')).toBe(content)
    expect(await namesWith('settings.json')).toEqual(['settings.json'])
  })

  it('文件来自更新版本：界面说得出是哪个版本，写盘被拦，那份文件一字未动', async () => {
    // 这条防的是「装了更新的版本又回退到本版」：那一版的形状本版本读不懂，
    // 但读不懂不等于坏了——改名留档会挪走人家正在用的配置，写回会抹掉他不认识的段落
    const next = CURRENT_SETTINGS_VERSION + 1
    const content = JSON.stringify(
      {
        schemaVersion: next,
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
    expect(view.storageProblem).toContain(`v${next}`)
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
    // 按 v0 走三步就把它整理回本版本认得的样子；装成未来版本会让人一直卡在写不进去
    await writeFile(file(), JSON.stringify({ schemaVersion: '1', aiTtsModel: 'old-voice' }))
    await loadInto(dir)
    expect((await service.getSettingsView()).storageProblem).toBeNull()
    const onDisk = await readJson(file())
    expect(onDisk.schemaVersion).toBe(CURRENT_SETTINGS_VERSION)
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
    expect(onDisk.schemaVersion).toBe(CURRENT_SETTINGS_VERSION)
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

describe('多方案的两道闸门', () => {
  it('一次保存不许吃掉用户没碰过的那套方案，也不许动它的 Key', async () => {
    // 这就是第①步最容易翻车的一处：v1 时代的读盘收口「只收字符串」，而方案列表是对象数组。
    // 照那份写法，用户在这里加的第二套方案会「读成功、写成功、东西没了」——
    // 一次普通的改模型名就把他另一套配置抹了，而且界面上一句错都不报
    const other = {
      id: 'asr-work',
      name: '工作',
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
    // 而这在只有测试能看出来的时候根本没有界面能看出来
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
    await service.saveSettings({ asrApiBase: 'https://selected.example' })
    const onDisk = await readJson(file())
    expect(diskProfile(onDisk, 'asr', 'asr-selected').apiBase).toBe('https://selected.example')
    expect(diskProfile(onDisk, 'asr', 'asr-first').model).toBe('not-this-one')
    expect(diskProfile(onDisk, 'asr', 'asr-first').apiBase).toBe('')
  })

  it('非凭据那三项落在文档根上，一条方案里都不许出现', async () => {
    // 这条钉的是磁盘契约的另外一半：「换一家网关」换的是凭据三项，模式/档位/语言是全局段。
    // 它们要是又跑回方案里，界面上选了 A 网关、下次切 B 网关就会连语言一起被换掉
    await writeFile(file(), v2Document({}, {}, { asrProvider: 'local', asrLocalModel: 'base', asrLanguage: 'zh' }))
    await loadInto(dir)
    await service.saveSettings({ asrProvider: 'cloud', asrLocalModel: 'small', asrLanguage: 'en' })

    const onDisk = await readJson(file())
    expect(onDisk).toMatchObject({ asrProvider: 'cloud', asrLocalModel: 'small', asrLanguage: 'en' })
    for (const profile of diskProfiles(onDisk).asr) {
      expect(Object.keys(profile).sort()).toEqual(['apiBase', 'apiKey', 'id', 'model', 'name'])
    }
    // 重灌一次模块当「重启应用」：磁盘上那份必须自己站得住
    await loadInto(dir)
    expect((await service.getASRConfig()).localModel).toBe('small')
  })

  it('手写文件里 defaultProfileId 指不到任何方案：三档都落空串，空列表不补方案', async () => {
    // 磁盘是系统边界：这一条不许假设「我们写出去的 id 一定指得到人」。
    // 三档同一口径（#222 重写⑧）：没人指路时不落回第一条——那等于用排第一的那家网关替用户
    // 做了决定，而下一次花的钱按那条计价。「列表本来就空」哪一档都不许凭空补一条，那是造用户
    // 没建过的配置。
    await writeFile(
      file(),
      JSON.stringify(
        {
          schemaVersion: 2,
          profiles: {
            asr: [{ id: 'asr-a', name: 'A', model: 'first' }],
            ai: [{ id: 'ai-a', name: 'A', model: 'gpt-a' }, { id: 'ai-b', name: 'B', model: 'gpt-b' }],
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
    expect(settings.asrModel).toBe('')
    expect(settings.aiModel).toBe('')
    expect(await service.resolveProfileId('asr')).toBe('')
    expect(await service.resolveProfileId('ai')).toBe('')
    expect((await service.getSettingsView()).storageProblem).toBeNull()

    // 指针是空串＝「没选」，凭据得点名写进某一条；不带 profileIds 的这句会被拦下
    await expect(service.saveSettings({ aiModel: 'no-place' })).rejects.toThrow(
      '这一类现在还没有任何配置方案'
    )
    await service.saveSettings({ aiModel: 'renamed', profileIds: { ai: 'ai-a' } })
    const onDisk = await readJson(file())
    expect(onDisk.defaultProfileId).toEqual({ asr: '', ai: '', tts: '' })
    expect(diskProfile(onDisk, 'ai', 'ai-a').model).toBe('renamed')
    // 空着的那一档还是空着：落盘不补方案
    expect(diskProfiles(onDisk).tts).toEqual([])
    expect(diskProfiles(onDisk).asr).toHaveLength(1)
  })

  it('中途挪回全局段的那些字段：从方案里升回文档根，方案里那份随下一次写盘消失', async () => {
    // v2 换过一次字段归属而版本戳没换（这一版从没发到用户手上），开发机上的文件还是
    // 「引擎/档位/语言躺在方案里」那副形状。按新表收口会把这些值当怪键扔掉——
    // 那是用户填过的「配音引擎＝本地」，丢完连痕迹都不剩。这一条钉的就是那次救援。
    await writeFile(
      file(),
      JSON.stringify(
        {
          schemaVersion: 2,
          profiles: {
            asr: [{ id: 'asr-a', name: 'A', model: 'w1', provider: 'cloud', localModel: 'small', language: 'en' }],
            ai: [{ id: 'ai-a', name: 'A', model: 'gpt-a' }],
            tts: [{ id: 'tts-a', name: 'A', engine: 'local', localEngine: 'kokoro', localVoice: '3' }]
          },
          defaultProfileId: { asr: 'asr-a', ai: 'ai-a', tts: 'tts-a' }
        },
        null,
        2
      )
    )
    await loadInto(dir)

    const settings = await service.loadSettings()
    expect(settings).toMatchObject({
      asrProvider: 'cloud',
      asrLocalModel: 'small',
      asrLanguage: 'en',
      ttsEngine: 'local',
      ttsLocalEngine: 'kokoro',
      ttsLocalVoice: '3',
    })

    // 一次只改全局段的保存，把内存里那份（已升过字段）落回磁盘：读的时候救上来，
    // 写的时候方案里就不该再带着这些没人读的键
    await service.saveSettings({ asrLanguage: 'en' })
    const onDisk = await readJson(file())
    expect(onDisk).toMatchObject({ ttsEngine: 'local', ttsLocalEngine: 'kokoro', asrLocalModel: 'small' })
    expect(diskProfile(onDisk, 'tts', 'tts-a')).toMatchObject({ id: 'tts-a' })
    // v3 的 tts 方案与 asr 同形：只剩地址 / Key / 模型三项（音色已经不在方案里了）
    expect(Object.keys(diskProfile(onDisk, 'tts', 'tts-a')).sort()).toEqual([
      'apiBase',
      'apiKey',
      'id',
      'model',
      'name',
    ])

    // 重灌一次模块当「重启应用」：磁盘上那份必须自己站得住，不靠内存里那一次升字段
    await loadInto(dir)
    expect((await service.loadSettings()).ttsLocalVoice).toBe('3')
  })

  it('文档根上已经有那个键时以根上的为准：方案里的旧形状不许把它盖掉', async () => {
    // 新形状写出来的那份在根上，方案里的是上一版形状的残留。谁的时代新用谁的，
    // 否则一次「重读旧文件」就把用户后来改过的档位倒回去
    await writeFile(
      file(),
      JSON.stringify(
        {
          schemaVersion: 2,
          ttsEngine: 'cloud',
          profiles: {
            asr: [],
            ai: [],
            tts: [{ id: 'tts-a', name: 'A', engine: 'local' }]
          },
          defaultProfileId: { asr: '', ai: '', tts: 'tts-a' }
        },
        null,
        2
      )
    )
    await loadInto(dir)
    expect((await service.loadSettings()).ttsEngine).toBe('cloud')
  })
})
