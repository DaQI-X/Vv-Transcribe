/**
 * 1.0.9 第②步的判据测试：profileId 接到了取值与增删改上。
 *
 * 这一层最值得测的是两条**方向相反**的回落规则，因为它们各自的错误代价不一样：
 * ① 干活那条路（getter / loadSettings / saveSettings 不带 id）按「该档当前默认方案」落——
 *    界面传回来的 id 可能刚被另一扇窗删掉，此刻打断用户正在跑的那次转写，比用他选着的
 *    那套跑完更糟。
 * ② 增删改与「显式指定了 id 的保存」指不到人就是**操作本身不成立**，必须报错：
 *    静默落到默认那条，等于当着用户的面把他没碰过的另一套配置改了。
 * 其余几条是产品口径：每档最多 3 套只在写入侧生效（读取侧剪列表就是「读成功、写成功、
 * 东西没了」）、至少留一套、复制一套时密钥原样搬运（重新封一次会把「能不能解密」变成
 * 「换过机器」）、以及密钥绝不因为「把方案列表发给界面」而跟着出去。
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROFILE_LAST_DELETE_MESSAGE,
  PROFILE_LIMIT_MESSAGE,
  SETTINGS_WRITE_BLOCKED,
  type ProfilesView
} from '../electron/main/services/settingsService'
import {
  DEFAULT_PROFILE_IDS,
  MAX_PROFILES_PER_CAPABILITY,
  type DefaultProfileId,
  type ProfileCapability,
  type SettingsProfiles
} from '../electron/main/services/settingsSchema'


type Service = typeof import('../electron/main/services/settingsService')
type ProfilesResult = { profiles: ProfilesView | null; error: string | null }
type SaveResult = {
  settings: { asrLocalModel?: string } | null
  tierRestart: string
  error: string | null
  saveError: string | null
}

/**
 * settings:save 里那句「档位变了就重启本地引擎」在测试中必须换成假动作：
 * 真 restartLocalEngine 会 spawn Python sidecar 去抢 8000，而这里要钉的只是
 * 「哪一次保存该按那个按钮」。connectionTestService 也从 asrServiceManager 取
 * getLocalEngineDetail，替身里少一个成员就是整份模块导入失败。
 */
const engine = vi.hoisted(() => ({
  restart: vi.fn(async () => ({ ok: true })),
  busy: vi.fn(() => false),
}))
vi.mock('../electron/main/services/asrServiceManager', () => ({
  restartLocalEngine: engine.restart,
  getLocalEngineDetail: async () => ({
    ready: true,
    error: null,
    modelLoaded: false,
    loadedModel: '',
    protocol: null,
    port: 8000,
  }),
}))
vi.mock('../electron/main/ipc/asrHandlers', () => ({ hasActiveTranscription: engine.busy }))

let dir = ''
let service: Service

const file = () => join(dir, 'settings.json')

async function resetDir(): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  dir = await mkdtemp(join(tmpdir(), 'vv-profiles-'))
}

/** 换 userData 就等于换一次进程：cache / writeBlocked 是模块级状态，必须重灌模块 */
async function loadInto(freshDir: string): Promise<void> {
  vi.resetModules()
  vi.spyOn(app, 'getPath').mockImplementation(
    ((name: string) => (name === 'userData' ? freshDir : join(freshDir, name))) as typeof app.getPath
  )
  service = await import('../electron/main/services/settingsService')
}

/** 这一层会写 ERROR 日志，userData 下多一个 logs/ 是正常的——比目录内容时先把它摘掉 */
async function keptNames(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name !== 'logs').sort()
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
}

/** setup.ts 里那份假加密的可解形式：`v1:` + base64('fake:<明文>') */
const sealed = (plain: string) => `v1:${Buffer.from(`fake:${plain}`, 'utf-8').toString('base64')}`

/** 一份 v2 文档：三档的方案列表与默认指向都能按档整体替换 */
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

function diskProfiles(doc: Record<string, unknown>): SettingsProfiles {
  const profiles = doc.profiles
  if (!profiles || typeof profiles !== 'object') throw new Error('磁盘上没有 profiles 这一段')
  return profiles as SettingsProfiles
}

/** 按 id 从磁盘那一列里挑方案；挑不到就判红，别让「没了」看起来像「值不一样」 */
function diskProfile(
  doc: Record<string, unknown>,
  cap: keyof SettingsProfiles,
  id: string
): Record<string, unknown> {
  const found = diskProfiles(doc)[cap].find((p) => p.id === id)
  if (!found) throw new Error(`磁盘上 ${cap} 那一列里没有方案 ${id}`)
  return found as unknown as Record<string, unknown>
}

/** 新建出来那条只能靠「多出来的那条」定位——id 是随机的，测试不许猜 */
async function onlyExtra(cap: keyof SettingsProfiles, known: string[]): Promise<Record<string, unknown>> {
  const list = diskProfiles(await readJson(file()))[cap]
  const extra = list.filter((profile) => !known.includes(profile.id))
  if (extra.length !== 1) throw new Error(`${cap} 那一列里新出来的方案应该有 1 条，实际 ${extra.length} 条`)
  return extra[0] as unknown as Record<string, unknown>
}

function idOf(cap: ProfileCapability, view: ProfilesView, name: string): string {
  const found = view.profiles[cap].find((profile) => profile.name === name)
  if (!found) throw new Error(`${cap} 那一列里没有名叫「${name}」的方案`)
  return found.id
}

/**
 * 拿一次「规则不成立」的拒绝原因。
 * 这里不用 `rejects.toThrow(SettingsProfileRuleError)`：每个用例都重灌过模块，
 * 抛出来的那个类与测试文件里静态 import 的已经不是同一个函数对象，instanceof 必然判假。
 * 按 name 判是同一件事，而且不需要为了测试给生产代码开后门。
 */
async function profileRuleRejection(run: Promise<unknown>): Promise<string> {
  const err = await run.then(
    () => null,
    (e: unknown) => e
  )
  if (!err) throw new Error('这次调用本该报错，却没有')
  const asError = err as { name?: string; message?: string }
  expect(asError.name).toBe('SettingsProfileRuleError')
  return String(asError.message)
}

beforeEach(resetDir)

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('取值按 id 挑方案', () => {
  /**
   * 三档各两条：默认那条都叫「默认」，另一条带可辨认的值。
   * asr-second 的 localModel 故意是 small——它是第②步唯一会牵动引擎重启的字段。
   */
  const twoEach = () =>
    v2Document(
      {
        asr: [
          { id: 'asr-default', name: '默认', apiKey: sealed('sk-asr-default'), provider: 'local', model: 'm-default', localModel: 'base' },
          { id: 'asr-second', name: '第二套', apiKey: sealed('sk-asr-second'), provider: 'openai', model: 'm-second', localModel: 'small' },
          { id: 'asr-third', name: '第三套', apiKey: '', provider: 'local', model: 'm-third', localModel: 'tiny' }
        ],
        ai: [
          { id: 'ai-default', name: '默认', apiKey: sealed('sk-ai-default'), apiBase: 'https://ai-default.example', model: 'gpt-default' },
          { id: 'ai-second', name: '第二套', apiKey: sealed('sk-ai-second'), apiBase: 'https://ai-second.example', model: 'gpt-second' }
        ],
        tts: [
          { id: 'tts-default', name: '默认', apiKey: '', engine: 'cloud', model: 'tts-default', apiBase: 'https://tts-default.example' },
          { id: 'tts-second', name: '第二套', apiKey: '', engine: 'cloud', model: 'tts-second', apiBase: '' }
        ]
      },
      { asr: 'asr-default', ai: 'ai-default', tts: 'tts-default' }
    )

  beforeEach(async () => {
    await writeFile(file(), twoEach())
    await loadInto(dir)
  })

  it('不传 id 与该档当前默认方案取值（第①步的行为没变）', async () => {
    const settings = await service.loadSettings()
    expect(settings.asrModel).toBe('m-default')
    expect(settings.asrApiKey).toBe('sk-asr-default')
    expect((await service.loadSettings({ asr: '' })).asrModel).toBe('m-default')
    expect((await service.loadSettings({})).asrModel).toBe('m-default')
  })

  it('传了 id 就按那条取，三档各挑各的互不干扰', async () => {
    const settings = await service.loadSettings({ asr: 'asr-third', ai: 'ai-second', tts: 'tts-second' })
    expect(settings.asrModel).toBe('m-third')
    expect(settings.asrApiKey).toBe('')
    expect(settings.aiModel).toBe('gpt-second')
    expect(settings.aiApiKey).toBe('sk-ai-second')
    expect(settings.ttsModel).toBe('tts-second')
    // 扁平视图里配音那格就是这条方案的空值；「沿用校对那套」发生在 getTTSConfig 里，见下面那条
    expect(settings.ttsApiBase).toBe('')
  })

  it('密钥状态跟着 id 走：不能把「默认那条有 Key」报成「这一条有 Key」', async () => {
    expect((await service.getSettingsView({ asr: 'asr-second' })).asrKeyStatus).toBe('encrypted')
    expect((await service.getSettingsView({ asr: 'asr-third' })).asrKeyStatus).toBe('none')
    expect((await service.getSettingsView({ ai: 'ai-second' })).aiKeyStatus).toBe('encrypted')
  })

  it('干活那条路：id 指不到人时落回默认，绝不打断手上的活', async () => {
    expect((await service.getASRConfig('asr-ghost')).model).toBe('m-default')
    expect((await service.getAIConfig('ai-ghost')).model).toBe('gpt-default')
    expect((await service.getTTSConfig('tts-ghost')).model).toBe('tts-default')
    // 落回之后 resolveProfileId 报的是实际用到的那条，不是传进来的那个（历史记录 #247 按这个记）
    expect(await service.resolveProfileId('asr', 'asr-ghost')).toBe('asr-default')
    expect(await service.resolveProfileId('asr', '  ')).toBe('asr-default')
    expect(await service.resolveProfileId('asr')).toBe('asr-default')
  })

  it('getter 带 id 时取到的是那一条的值', async () => {
    expect((await service.getASRConfig('asr-second')).model).toBe('m-second')
    expect((await service.getASRConfig('asr-second')).apiKey).toBe('sk-asr-second')
    expect((await service.getASRConfig('asr-second')).localModel).toBe('small')
    expect(await service.resolveProfileId('asr', 'asr-second')).toBe('asr-second')
    expect((await service.getAIConfig('ai-second')).apiBase).toBe('https://ai-second.example')
  })

  it('配音留空回落的「校对那套」固定是校对档当前默认那条，不跟配音的 id 走', async () => {
    const config = await service.getTTSConfig('tts-second')
    expect(config.apiBase).toBe('https://ai-default.example')
    // 反证：把校对的默认换成第二套，配音落点跟着**校对的默认**变，而不是跟着 tts 的 id 变
    await service.setDefaultProfile('ai', 'ai-second')
    expect((await service.getTTSConfig('tts-second')).apiBase).toBe('https://ai-second.example')
  })

  it('本地档的配音不吃 Key 与接口地址：按 id 取时 voice 走 localVoice', async () => {
    await service.saveSettings({ ttsEngine: 'local', ttsLocalVoice: '3', profileIds: { tts: 'tts-default' } })
    const config = await service.getTTSConfig('tts-default')
    expect(config.engine).toBe('local')
    expect(config.voice).toBe('3')
  })
})

describe('保存落在哪一条', () => {
  beforeEach(async () => {
    await writeFile(
      file(),
      v2Document(
        {
          asr: [
            { id: 'asr-default', name: '默认', apiKey: sealed('sk-a'), model: 'keep-me' },
            { id: 'asr-work', name: '工作', apiKey: '', model: 'other' }
          ]
        },
        { asr: 'asr-default' }
      )
    )
    await loadInto(dir)
  })

  it('不带 profileIds 就写默认那条——跟第①步一模一样', async () => {
    await service.saveSettings({ asrModel: 'renamed' })
    const onDisk = await readJson(file())
    expect(diskProfile(onDisk, 'asr', 'asr-default').model).toBe('renamed')
    expect(diskProfile(onDisk, 'asr', 'asr-work').model).toBe('other')
  })

  it('带 profileIds 就写那一条，默认那条一个字都不动', async () => {
    await service.saveSettings({ asrModel: 'edited-in-place', profileIds: { asr: 'asr-work' } })
    const onDisk = await readJson(file())
    expect(diskProfile(onDisk, 'asr', 'asr-work').model).toBe('edited-in-place')
    expect(diskProfile(onDisk, 'asr', 'asr-default').model).toBe('keep-me')
    expect(onDisk.defaultProfileId).toEqual({ ...DEFAULT_PROFILE_IDS })
  })

  it('显式传了 id 却指不到人时报错，且这次保存完全没落盘', async () => {
    // 与上一条是同一条规则的两面：静默落到默认那条会吃掉用户没碰过的配置，
    // 而「报错了但已经写下去一半」比报错更难查
    expect(
      await profileRuleRejection(service.saveSettings({ asrModel: 'nope', profileIds: { asr: 'asr-ghost' } }))
    ).toContain('已经没有这套方案')
    expect(await readFile(file(), 'utf-8')).toContain('keep-me')
    expect(diskProfile(await readJson(file()), 'asr', 'asr-default').model).toBe('keep-me')
    expect(await keptNames()).toEqual(['settings.json'])
  })

  it('返回的视图说的是「刚写进去的那一条」，不是默认那条', async () => {
    const view = await service.saveSettings({ asrModel: 'written', profileIds: { asr: 'asr-work' } })
    expect(view.asrModel).toBe('written')
    // 工作那条没填 Key；回成默认那把的话，界面会以为「这条有 Key」
    expect(view.asrKeyStatus).toBe('none')
  })

  it('密钥的「留空＝不改 / null＝清除」在指定方案时同样成立', async () => {
    await service.saveSettings({ asrModel: 'x', profileIds: { asr: 'asr-default' } })
    expect((await service.loadSettings()).asrApiKey).toBe('sk-a')
    await service.saveSettings({ asrApiKey: null, profileIds: { asr: 'asr-default' } })
    expect((await service.loadSettings()).asrApiKey).toBe('')
    await service.saveSettings({ asrApiKey: 'sk-new-key', profileIds: { asr: 'asr-work' } })
    expect((await service.loadSettings({ asr: 'asr-work' })).asrApiKey).toBe('sk-new-key')
    expect(await readFile(file(), 'utf-8')).not.toContain('sk-new-key')
  })
})

describe('方案列表：一次给全的脱敏形状', () => {
  beforeEach(async () => {
    await writeFile(
      file(),
      v2Document({
        ai: [
          { id: 'ai-default', name: '默认', apiKey: sealed('sk-never-show'), model: 'gpt-a' },
          { id: 'ai-b', name: 'B', apiKey: '', model: 'gpt-b' }
        ]
      })
    )
    await loadInto(dir)
  })

  it('values 的键名就是表里那几项，且不包含密钥', async () => {
    const view = await service.listProfiles()
    expect(Object.keys(view.profiles.ai[0].values).sort()).toEqual(['apiBase', 'model', 'provider'])
    expect(view.profiles.ai[1].values.model).toBe('gpt-b')
    expect(view.profiles.tts[0].values).toHaveProperty('localEngine')
    expect(view.profiles.asr[0].values).toHaveProperty('localModel')
  })

  it('三档的列表 + 每档默认 + 上限 + 读盘结论都在一份里', async () => {
    const view = await service.listProfiles()
    expect(view.defaultProfileId).toEqual({ ...DEFAULT_PROFILE_IDS })
    expect(view.maxProfiles).toBe(MAX_PROFILES_PER_CAPABILITY)
    expect(view.storageProblem).toBeNull()
    expect(view.profiles.asr.map((p) => p.id)).toEqual(['asr-default'])
  })

  it('解密的 Key 不因为「把列表发给界面」而跟着出去', async () => {
    const view = await service.listProfiles()
    expect(JSON.stringify(view)).not.toContain('sk-never-show')
    expect(JSON.stringify(view)).not.toContain('v1:')
    expect(view.profiles.ai.map((p) => p.keyStatus)).toEqual(['encrypted', 'none'])
  })
})

describe('新建方案', () => {
  beforeEach(async () => {
    await writeFile(
      file(),
      v2Document({
        asr: [{ id: 'asr-default', name: '默认', apiKey: sealed('sk-src'), provider: 'openai', apiBase: 'https://src.example', model: 'src-model', language: 'en' }]
      })
    )
    await loadInto(dir)
  })

  it('默认照着当前那条复制，密钥原样搬运（不重新封一次）', async () => {
    const view = await service.createProfile('asr', '工作')
    const created = await onlyExtra('asr', ['asr-default'])
    expect(created.id).toMatch(/^asr-[0-9a-f]{8}$/)
    expect(created.name).toBe('工作')
    expect(created.model).toBe('src-model')
    expect(created.apiBase).toBe('https://src.example')
    expect(created.language).toBe('en')
    expect(created.apiKey).toBe(sealed('sk-src'))
    // 磁盘上不许出现明文，也不许因为「复制」多出一份解不开的东西
    expect(await readFile(file(), 'utf-8')).not.toContain('sk-src')
    expect((await service.loadSettings({ asr: view.profiles.asr[1].id })).asrApiKey).toBe('sk-src')
  })

  it('fromProfileId 传空串＝真·空白一套：字段回默认值且不带上一套的 Key', async () => {
    await service.createProfile('asr', '空白', '')
    const created = await onlyExtra('asr', ['asr-default'])
    expect(created.apiKey).toBe('')
    expect(created.model).toBe('')
    expect(created.provider).toBe('local')
    expect(created.language).toBe('zh')
  })

  it('新建不改「当前用哪条」：下一次转写用的还是原来那套', async () => {
    const view = await service.createProfile('asr', '没填完的')
    expect(view.defaultProfileId.asr).toBe('asr-default')
    expect((await service.getASRConfig()).model).toBe('src-model')
  })

  it('没起名时给一个不重样的默认名', async () => {
    const first = await service.createProfile('asr')
    expect(first.profiles.asr[1].name).toBe('方案 2')
    const second = await service.createProfile('asr')
    expect(second.profiles.asr[2].name).toBe('方案 3')
  })

  it('第 4 条被拦，界面上那句与这里同一句；磁盘一个字没动', async () => {
    await service.createProfile('asr', '二')
    await service.createProfile('asr', '三')
    const before = await readFile(file(), 'utf-8')
    await expect(service.createProfile('asr', '四')).rejects.toThrow(PROFILE_LIMIT_MESSAGE)
    expect((await service.listProfiles()).profiles.asr).toHaveLength(MAX_PROFILES_PER_CAPABILITY)
    expect(await readFile(file(), 'utf-8')).toBe(before)
  })

  it('照着一条不存在的方案复制要报错，而不是凭空给一条空白', async () => {
    expect(
      await profileRuleRejection(service.createProfile('asr', '二', 'asr-ghost'))
    ).toContain('已经没有这套方案')
  })

  it('能力名不认识时报「不知道要改哪一类」——渲染层那根字符串不能直接当键用', async () => {
    for (const raw of ['', '  ', 'ASR', 'history', 42, null, undefined]) {
      await expect(service.createProfile(raw)).rejects.toThrow('不知道要改哪一类配置')
    }
  })

  it('上限之外的改动照样能读能删：读侧不按 cap 剪列表', async () => {
    // 手改 settings.json 塞进 5 条是这一层要接住的现实：剪掉就是「读成功、写成功、东西没了」
    await writeFile(
      file(),
      v2Document({
        asr: [
          { id: 'asr-1', name: '一' },
          { id: 'asr-2', name: '二' },
          { id: 'asr-3', name: '三' },
          { id: 'asr-4', name: '四' },
          { id: 'asr-5', name: '五' }
        ]
      })
    )
    await loadInto(dir)
    expect((await service.listProfiles()).profiles.asr).toHaveLength(5)
    await expect(service.createProfile('asr', '六')).rejects.toThrow(PROFILE_LIMIT_MESSAGE)
    await service.deleteProfile('asr', 'asr-4')
    await service.deleteProfile('asr', 'asr-5')
    expect((await service.listProfiles()).profiles.asr).toHaveLength(3)
    expect(diskProfiles(await readJson(file())).asr).toHaveLength(3)
  })
})

describe('改名 / 删除 / 换默认', () => {
  beforeEach(async () => {
    await writeFile(
      file(),
      v2Document({
        asr: [
          { id: 'asr-1', name: '第一个', apiKey: sealed('sk-1'), model: 'm-1' },
          { id: 'asr-2', name: '第二个', apiKey: sealed('sk-2'), model: 'm-2' },
          { id: 'asr-3', name: '第三个', apiKey: '', model: 'm-3' }
        ]
      })
    )
    await loadInto(dir)
  })

  it('改名只动名字：id、字段与密钥都不碰（历史记录按 id 认，改名不许断链）', async () => {
    const view = await service.renameProfile('asr', 'asr-2', '  公司网关  ')
    expect(view.profiles.asr.map((p) => p.id)).toEqual(['asr-1', 'asr-2', 'asr-3'])
    expect(idOf('asr', view, '公司网关')).toBe('asr-2')
    const onDisk = await readJson(file())
    expect(diskProfile(onDisk, 'asr', 'asr-2')).toMatchObject({ name: '公司网关', model: 'm-2', apiKey: sealed('sk-2') })
    expect((await service.loadSettings({ asr: 'asr-2' })).asrApiKey).toBe('sk-2')
  })

  it('名字太长按界面上限截断，不能把方案列表撑破', async () => {
    const view = await service.renameProfile('asr', 'asr-1', '名'.repeat(60))
    expect(view.profiles.asr[0].name).toHaveLength(40)
  })

  it('空名字报错——「没改」和「不许为空」是两件事', async () => {
    for (const raw of ['', '   ', undefined, 42]) {
      await expect(service.renameProfile('asr', 'asr-1', raw)).rejects.toThrow('方案名不能为空')
    }
    expect((await service.listProfiles()).profiles.asr[0].name).toBe('第一个')
  })

  it('删掉非默认那条：默认指向与另外两条都不动', async () => {
    const view = await service.deleteProfile('asr', 'asr-2')
    expect(view.profiles.asr.map((p) => p.id)).toEqual(['asr-1', 'asr-3'])
    // 这份文件里的 defaultProfileId 指的是一个不存在的 id，读盘时已落回第一条，删除不该动它
    expect(view.defaultProfileId.asr).toBe('asr-1')
    const onDisk = await readJson(file())
    expect(diskProfile(onDisk, 'asr', 'asr-1').apiKey).toBe(sealed('sk-1'))
    expect(await readFile(file(), 'utf-8')).not.toContain('sk-2')
  })

  it('删掉的正是当前默认时，默认落回剩下的第一条而不是删掉引用', async () => {
    await service.setDefaultProfile('asr', 'asr-1')
    const view = await service.deleteProfile('asr', 'asr-1')
    expect(view.defaultProfileId.asr).toBe('asr-2')
    expect(await service.resolveProfileId('asr')).toBe('asr-2')
    expect((await service.getASRConfig()).model).toBe('m-2')
  })

  it('只剩一条时不许删：删空了这一档就没有「当前方案」可指', async () => {
    await service.deleteProfile('asr', 'asr-2')
    await service.deleteProfile('asr', 'asr-3')
    const before = await readFile(file(), 'utf-8')
    await expect(service.deleteProfile('asr', 'asr-1')).rejects.toThrow(PROFILE_LAST_DELETE_MESSAGE)
    expect((await service.listProfiles()).profiles.asr).toHaveLength(1)
    expect(await readFile(file(), 'utf-8')).toBe(before)
  })

  it('首次运行那条默认方案也删不掉（三档都只有一条）', async () => {
    await resetDir()
    await loadInto(dir)
    await expect(service.deleteProfile('tts', DEFAULT_PROFILE_IDS.tts)).rejects.toThrow(
      PROFILE_LAST_DELETE_MESSAGE
    )
  })

  it('换默认：下一次取值就走这条，无需重启', async () => {
    const view = await service.setDefaultProfile('asr', 'asr-3')
    expect(view.defaultProfileId.asr).toBe('asr-3')
    expect((await service.getASRConfig()).model).toBe('m-3')
    // 只改这一档的指向，另两档不该跟着动
    expect(view.defaultProfileId.ai).toBe(DEFAULT_PROFILE_IDS.ai)
  })

  it('增删改对一条指不到人的方案一律报错，绝不落到第一条', async () => {
    expect(await profileRuleRejection(service.renameProfile('asr', 'asr-ghost', 'x'))).toContain(
      '转写配置里已经没有这套方案了'
    )
    await profileRuleRejection(service.deleteProfile('asr', 'asr-ghost'))
    await profileRuleRejection(service.setDefaultProfile('asr', 'asr-ghost'))
    expect(await profileRuleRejection(service.setDefaultProfile('ai', 'ai-ghost'))).toContain(
      '校对配置里已经没有这套方案了'
    )
    expect(await profileRuleRejection(service.setDefaultProfile('tts', 'tts-ghost'))).toContain(
      '配音配置里已经没有这套方案了'
    )
    // 句子里不带内部编号：出现在 toast 上只是噪声
    expect((await service.listProfiles()).profiles.asr.map((p) => p.id)).toEqual(['asr-1', 'asr-2', 'asr-3'])
  })

  it('改完重启（重灌模块）还在：增删改走的是同一个落盘出口', async () => {
    await service.renameProfile('asr', 'asr-3', '改过名')
    await service.deleteProfile('asr', 'asr-2')
    await service.setDefaultProfile('asr', 'asr-3')

    await loadInto(dir)
    const view = await service.listProfiles()
    expect(view.profiles.asr.map((p) => p.name)).toEqual(['第一个', '改过名'])
    expect(view.defaultProfileId.asr).toBe('asr-3')
    expect((await service.getASRConfig()).model).toBe('m-3')
    expect((await service.loadSettings()).asrApiKey).toBe('')
  })
})

describe('读盘出问题时，闸门对增删改同样生效', () => {
  it('settings.json 读不出来时，四条改动一个都不许落盘', async () => {
    // 增删改以前是闸门的旁路：它们也写 store，只是不经过 saveSettings。
    // 这一次都没读到内容，写下去就是把猜测盖到用户的东西上——列表比单个表单能毁掉的东西更多
    await mkdir(file())
    await loadInto(dir)
    await expect(service.createProfile('asr', '新')).rejects.toThrow(SETTINGS_WRITE_BLOCKED)
    await expect(service.renameProfile('asr', 'asr-default', '改')).rejects.toThrow(SETTINGS_WRITE_BLOCKED)
    await expect(service.setDefaultProfile('asr', 'asr-default')).rejects.toThrow(SETTINGS_WRITE_BLOCKED)
    // 删除这一条在闸门之前就先被「至少留一套」拦下：读不出来时磁盘上有几条我们并不知道，
    // 内存里那份默认 store 每档只有一条。这里要的是「它没落盘」，不是它报了哪句
    await expect(service.deleteProfile('asr', 'asr-default')).rejects.toThrow(PROFILE_LAST_DELETE_MESSAGE)
    expect(await keptNames()).toEqual(['settings.json'])
  })

  it('原件被留档过时，增删改的返回值也带着这句结论', async () => {
    // corrupt 的语义是「原件保住了、可以继续写」，所以这里允许落盘；但 storageProblem
    // 必须一路带着——界面据此决定说的是「你还没填」还是「这份没读出来」
    await writeFile(file(), '{"asrProvider":"local","aiApiKey":"v1:')
    await loadInto(dir)
    expect((await service.listProfiles()).storageProblem).toContain('没能解析')
    const view = await service.createProfile('asr', '新')
    expect(view.storageProblem).toContain('没能解析')
    expect(view.profiles.asr).toHaveLength(2)
  })
})

describe('IPC 通道（渲染层拿到的形状）', () => {
  type Wrapper = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
  let registered: Map<string, Wrapper>
  const event = {} as IpcMainInvokeEvent

  async function call(channel: string, ...args: unknown[]): Promise<unknown> {
    const wrapper = registered.get(channel)
    if (!wrapper) throw new Error(`通道 ${channel} 没注册，测试前提就不成立`)
    return wrapper(event, ...args)
  }

  /**
   * 通道注册用的是 services 那份模块实例——所以必须在 loadInto 之后 import，
   * 测试驱动的就是界面那一刻读到的同一份 cache。
   */
  async function register(): Promise<void> {
    registered = new Map()
    vi.spyOn(ipcMain, 'handle').mockImplementation(((channel: string, fn: Wrapper) => {
      registered.set(channel, fn)
    }) as never)
    const { registerSettingsHandlers: registerHandlers } = await import(
      '../electron/main/ipc/settingsHandlers'
    )
    registerHandlers()
  }

  beforeEach(async () => {
    await writeFile(
      file(),
      v2Document({
        tts: [
          { id: 'tts-default', name: '默认', apiKey: sealed('sk-tts'), model: 'tts-1' },
          { id: 'tts-b', name: 'B', apiKey: '', model: 'cosyvoice' }
        ]
      })
    )
    await loadInto(dir)
    await register()
  })

  it('五条新通道都注册了', () => {
    for (const channel of [
      'settings:listProfiles',
      'settings:createProfile',
      'settings:renameProfile',
      'settings:deleteProfile',
      'settings:setDefaultProfile'
    ]) {
      expect(registered.has(channel)).toBe(true)
    }
  })

  it('listProfiles 直接回列表本身，不套一层 {profiles,error} 信封', async () => {
    const got = (await call('settings:listProfiles')) as ProfilesView
    expect(got.profiles.tts).toHaveLength(2)
    expect(got.maxProfiles).toBe(3)
  })

  it('改动成功回 {profiles, error: null}，界面一次拿到「改完之后长什么样」', async () => {
    const got = (await call('settings:createProfile', 'tts', 'C')) as ProfilesResult
    expect(got.error).toBeNull()
    expect(got.profiles?.profiles.tts.map((p) => p.name)).toEqual(['默认', 'B', 'C'])
    expect(got.profiles?.defaultProfileId.tts).toBe('tts-default')
  })

  it('规则不成立时是一句话 + 当前列表，渲染层的 await 不会抛', async () => {
    const got = (await call('settings:deleteProfile', 'asr', DEFAULT_PROFILE_IDS.asr)) as ProfilesResult
    expect(got.error).toBe(PROFILE_LAST_DELETE_MESSAGE)
    expect(got.profiles?.profiles.asr).toHaveLength(1)

    const bad = (await call('settings:renameProfile', 'tts', 'tts-ghost', 'x')) as ProfilesResult
    expect(bad.error).toContain('已经没有这套方案')
    expect(bad.profiles?.profiles.tts.map((p) => p.id)).toEqual(['tts-default', 'tts-b'])
  })

  it('入参再怎么不象形状，通道也只回值不回异常', async () => {
    for (const raw of [undefined, null, 42, [], 'ASR']) {
      const got = (await call('settings:createProfile', raw)) as ProfilesResult
      expect(got).toBeTypeOf('object')
      expect(typeof got.error).toBe('string')
    }
  })

  it('闸门落下时把那句话原样送到界面上，而不是通用错误文案', async () => {
    // 重灌模块当「这一次启动什么都没读到」：写盘闸门是每进程一次的状态
    await rm(file(), { recursive: true, force: true })
    await mkdir(file())
    vi.resetModules()
    await register()
    const got = (await call('settings:createProfile', 'asr', '新')) as ProfilesResult
    expect(got.error).toBe(SETTINGS_WRITE_BLOCKED)
    // 列表回的是「按默认配置开始」那一份，配上 storageProblem 才说得清它不是用户的东西；
    // 这里要钉住的是没落盘（settings.json 仍是那个目录）+ 那句话没有被换成通用文案
    expect(got.profiles?.storageProblem).toContain('保存已暂时停用')
    expect(got.profiles?.profiles.asr).toHaveLength(1)
    expect(await keptNames()).toEqual(['settings.json'])
  })

  it('通道返回值里不许出现任何一把 Key 的明文', async () => {
    const got = (await call('settings:createProfile', 'tts', 'C')) as ProfilesResult
    expect(JSON.stringify(got)).not.toContain('sk-tts')
    expect(JSON.stringify(got)).not.toContain('v1:')
  })

  describe('settings:save 的档位重启判定（看的是「下一次转写用哪一条」）', () => {
    /**
     * 引擎驻留的档位只在 spawn 时按**当前默认那条**的 asrLocalModel 定下来（HF_HUB_OFFLINE
     * 也在那一刻决定），所以「要不要重启」比较的必须是默认那条的前后值。
     * 拿这次写进去的那一条去比，编辑一套没在用的方案也会重启一次引擎——正在跑的转写被截断，
     * 界面还附赠一句「新档位才会生效」，而那件事本来就不依赖这次改动。
     */
    beforeEach(async () => {
      await writeFile(
        file(),
        v2Document({
          asr: [
            { id: 'asr-default', name: '默认', apiKey: '', provider: 'local', localModel: 'base' },
            { id: 'asr-b', name: 'B', apiKey: '', provider: 'local', localModel: 'base' },
          ]
        })
      )
      await loadInto(dir)
      engine.restart.mockReset().mockResolvedValue({ ok: true })
      engine.busy.mockReset().mockReturnValue(false)
      await register()
    })

    it('改的不是当前默认那条时不重启，但改动照样落盘', async () => {
      const got = (await call('settings:save', {
        asrLocalModel: 'small',
        profileIds: { asr: 'asr-b' },
      })) as SaveResult
      expect(got.saveError).toBeNull()
      expect(got.tierRestart).toBe('not-needed')
      expect(got.error).toBeNull()
      expect(engine.restart).not.toHaveBeenCalled()
      // 「不重启」不能读成「没保存」：那条方案的档位确实写进去了
      expect(diskProfile(await readJson(file()), 'asr', 'asr-b').localModel).toBe('small')
      expect(diskProfile(await readJson(file()), 'asr', 'asr-default').localModel).toBe('base')
    })

    it('换默认那条的档位才重启，且回给界面的视图说的是被改的那条', async () => {
      const got = (await call('settings:save', { asrLocalModel: 'small' })) as SaveResult
      expect(got.tierRestart).toBe('done')
      expect(got.error).toBeNull()
      expect(engine.restart).toHaveBeenCalledTimes(1)
      expect(got.settings?.asrLocalModel).toBe('small')
    })

    it('有转写正在跑时不许动引擎，但那句话必须送到界面上', async () => {
      engine.busy.mockReturnValue(true)
      const got = (await call('settings:save', { asrLocalModel: 'small' })) as SaveResult
      expect(got.tierRestart).toBe('busy')
      expect(got.error).toContain('新档位才会生效')
      expect(engine.restart).not.toHaveBeenCalled()
      // 档位已经存下来了，只是引擎还没吃到——界面靠的就是「saveError 为 null + error 非 null」这一对
      expect(got.saveError).toBeNull()
      expect(diskProfile(await readJson(file()), 'asr', 'asr-default').localModel).toBe('small')
    })

    it('重启没成也要说出口，不能把「存下来了」当成「生效了」', async () => {
      engine.restart.mockResolvedValue({ ok: false })
      const got = (await call('settings:save', { asrLocalModel: 'small' })) as SaveResult
      expect(got.tierRestart).toBe('failed')
      expect(got.error).toContain('没能自动重启')
    })

    it('档位没动的保存一次引擎都不碰', async () => {
      const got = (await call('settings:save', { asrModel: 'whisper-1' })) as SaveResult
      expect(got.tierRestart).toBe('not-needed')
      expect(engine.restart).not.toHaveBeenCalled()
    })
  })
})
