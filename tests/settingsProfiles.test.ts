/**
 * 1.0.9 多配置的判据测试（#222 重写版：方案只剩云端凭据）。
 *
 * 这一层要钉的规矩按「错了代价多大」排：
 * ① 两条**方向相反**的回落。干活那条路（getter / loadSettings / 不带 id 的 saveSettings）
 *    按「该档当前默认方案」落——界面传回来的 id 可能刚被另一扇窗删掉，此刻打断用户正在跑的
 *    那次转写，比用他选着的那套跑完更糟。增删改与「显式指定了 id 的保存」指不到人则是
 *    **操作本身不成立**，必须报错：静默落到默认那条，等于当着用户的面把他没碰过的另一套改了。
 * ② 「当前使用」那条指不到人时，转写落**空串**而不是替用户挑第一条——下一次转写花在哪家
 *    网关是按这条计的，替他决定等于替他花钱。校对/配音这一轮还兜第一条，理由在
 *    settingsService 的 REPOINT_DEFAULT_WHEN_MISSING 上，那两档改完这个分支就该删。
 * ③ 0 条方案是合法状态（新口径的「还没建过云端方案」）：凭据投成空值、resolveProfileId 回
 *    空串、列表回空数组，而模式/档位/语言这些**全局段**照旧从文档根上出来——所以本地转写
 *    根本不受有没有方案影响。带着凭据的保存在 0 条时只报错、不代建：保存里偷偷建一条，
 *    「删掉最后一条」就看起来像没生效。
 * ④ 字段归属：方案里只有凭据三项，「用本地还是云端」「本地档位」「转写语言」是全局段。
 *    这条同时管两个方向——换 id 不许改动全局段，改全局段也不许写进任何一条方案。
 * 其余几条是产品口径：每档最多 3 套只在写入侧生效（读取侧剪列表就是「读成功、写成功、
 * 东西没了」）、新建以界面此刻的输入为准、第一条自动是当前使用、复制一套时密钥原样搬运
 * （重新封一次会把「能不能解密」变成「换过机器」）、以及密钥绝不因为「把方案列表发给界面」
 * 而跟着出去。
 * 「测试连接」那组测回落按哪一条取 Key 与地址：测出来的结论必须与真干活用的是同一套配置，
 * 否则「自检绿了、点开始配音却走了另一家」就是界面亲口撒的谎。
 */
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROFILE_CREATE_FIRST_MESSAGE,
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

/**
 * 「测试连接」真发网络请求，测试里换成一只只记参数的假探针。
 * 要钉的是回落读的是**哪一条方案**的 Key 与地址，而这件事唯一外部可见的结果
 * 就是探针最后收到的那一份参数——不看返回值，因为返回值是那句结论，不是这次要核的规矩。
 */
const probe = vi.hoisted(() => {
  // 参数写进签名里，测试才拿得到「探针收到的是什么」：vi.fn(() => …) 推出来的调用参数是空元组
  const ok = async (_values: Record<string, string>) => ({
    level: 'pass' as const,
    title: '假探针',
    message: '没发真请求',
  })
  return { asr: vi.fn(ok), ai: vi.fn(ok), tts: vi.fn(ok) }
})
vi.mock('../electron/main/services/connectionTestService', () => ({
  testASRConfig: probe.asr,
  testAIConfig: probe.ai,
  testTTSConfig: probe.tts,
}))

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

/**
 * 一份 v2 文档：三档的方案列表、每档默认指向，以及**平铺在根上的全局段**都能整体替换。
 * 全局段那第三参是新口径的关键形状——asrProvider / ttsEngine 这些躺在根上，
 * 不在任何一条方案里，所以这一份 helper 必须能表达「根上有值」这件事。
 * 三条默认方案里只躺 v2 那张表的方案字段（配音那档是地址 / Key / 模型 / 音色），
 * 已经挪去全局段的键不放进来——放了它，每个用例都等于顺带测一次中途形状的救援。
 */
function v2Document(
  profiles: Partial<Record<keyof SettingsProfiles, Array<Record<string, unknown>>>> = {},
  defaultProfileId: Partial<DefaultProfileId> = {},
  globals: Record<string, unknown> = {}
): string {
  return JSON.stringify(
    {
      schemaVersion: 2,
      ...globals,
      profiles: {
        asr: [{ id: 'asr-default', name: '默认', apiKey: '', model: 'asr-default-model' }],
        ai: [{ id: 'ai-default', name: '默认', apiKey: '', model: 'gpt-4o' }],
        tts: [{ id: 'tts-default', name: '默认', apiKey: '', model: 'tts-1', voice: 'alloy' }],
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
   * 三档多条：默认那条都叫「默认」，另一条带可辨认的值。
   * asr 那三条只有凭据三项；模式/档位/语言在全局段那份里（第三参），所以「换一条方案」
   * 与「换档位」两件事在这里是互相独立的——那正是这一轮重写的产品口径。
   */
  const twoEach = () =>
    v2Document(
      {
        asr: [
          { id: 'asr-default', name: '默认', apiKey: sealed('sk-asr-default'), apiBase: 'https://asr-default.example', model: 'm-default' },
          { id: 'asr-second', name: '第二套', apiKey: sealed('sk-asr-second'), apiBase: 'https://asr-second.example', model: 'm-second' },
          { id: 'asr-third', name: '第三套', apiKey: '', apiBase: '', model: 'm-third' }
        ],
        ai: [
          { id: 'ai-default', name: '默认', apiKey: sealed('sk-ai-default'), apiBase: 'https://ai-default.example', model: 'gpt-default' },
          { id: 'ai-second', name: '第二套', apiKey: sealed('sk-ai-second'), apiBase: 'https://ai-second.example', model: 'gpt-second' }
        ],
        tts: [
          { id: 'tts-default', name: '默认', apiKey: '', model: 'tts-default', voice: 'alloy', apiBase: 'https://tts-default.example' },
          { id: 'tts-second', name: '第二套', apiKey: '', model: 'tts-second', voice: '', apiBase: '' }
        ]
      },
      { asr: 'asr-default', ai: 'ai-default', tts: 'tts-default' },
      { asrProvider: 'cloud', asrLocalModel: 'base', asrLanguage: 'zh' }
    )

  beforeEach(async () => {
    await writeFile(file(), twoEach())
    await loadInto(dir)
  })

  it('不传 id 与该档当前默认方案取值（干活那条路的缺省）', async () => {
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

  it('getter 带 id 时取到的是那一条的凭据', async () => {
    expect((await service.getASRConfig('asr-second')).model).toBe('m-second')
    expect((await service.getASRConfig('asr-second')).apiKey).toBe('sk-asr-second')
    expect((await service.getASRConfig('asr-second')).apiBase).toBe('https://asr-second.example')
    expect(await service.resolveProfileId('asr', 'asr-second')).toBe('asr-second')
    expect((await service.getAIConfig('ai-second')).apiBase).toBe('https://ai-second.example')
  })

  it('模式 / 档位 / 语言是全局段：按哪条方案取都不会改它们', async () => {
    for (const id of ['asr-default', 'asr-second', 'asr-third', 'asr-ghost']) {
      const config = await service.getASRConfig(id)
      expect(config.provider).toBe('cloud')
      expect(config.localModel).toBe('base')
    }
    expect((await service.loadSettings({ asr: 'asr-third' })).asrLanguage).toBe('zh')
  })

  it('反证：改全局段是让三条方案一起变，不是改到某一条身上', async () => {
    await service.saveSettings({ asrLocalModel: 'small' })
    expect((await service.getASRConfig('asr-default')).localModel).toBe('small')
    expect((await service.getASRConfig('asr-second')).localModel).toBe('small')
    // 而且这次保存一个字都没写进方案列表里
    const onDisk = await readJson(file())
    expect(onDisk.asrLocalModel).toBe('small')
    for (const id of ['asr-default', 'asr-second', 'asr-third']) {
      expect('localModel' in diskProfile(onDisk, 'asr', id)).toBe(false)
    }
  })

  it('方案里躺着表外的键（开发中途那版形状）：值升回全局段，方案里那份不再算这条网关的参数', async () => {
    // CAPABILITY_FIELDS 把 provider / localModel / language 退回全局段之后，方案里那份是
    // 中途那版形状的残留。直接扔掉等于「读成功、写成功、东西没了」——那是用户填过的档位，
    // 所以读盘先把它们升回文档根（表在 settingsSchema 的 PROFILE_FIELDS_MOVED_TO_GLOBALS），
    // 升上来就是全局段：按哪条方案取都同一个值，而不是每条各自带一份
    await writeFile(
      file(),
      v2Document(
        {
          asr: [
            { id: 'asr-x', name: 'X', apiKey: '', model: 'm-x', provider: 'cloud', localModel: 'small', language: 'en' },
            { id: 'asr-y', name: 'Y', apiKey: '', model: 'm-y' }
          ]
        },
        { asr: 'asr-x' }
      )
    )
    await loadInto(dir)
    expect((await service.getASRConfig('asr-x')).provider).toBe('cloud')
    expect((await service.getASRConfig('asr-x')).localModel).toBe('small')
    // 换一条方案，档位与语言跟着换是上一版拆错的地方
    expect((await service.getASRConfig('asr-y')).localModel).toBe('small')
    expect((await service.loadSettings({ asr: 'asr-y' })).asrLanguage).toBe('en')
    // 凭据照各自那条投，投给界面的方案形状里也没有那三项
    expect((await service.getASRConfig('asr-y')).model).toBe('m-y')
    const view = await service.listProfiles()
    // asrVendor 是 1.1.1 新认的厂商书签：老方案里没有，投出来是空串（界面按 OpenAI 兼容显示）
    // asrAppId 是 1.1.2 讯飞那一档要的三把凭据里唯一不算密文的一把（另两把走状态位）
    // 转写这一档没有资源编号那一格：收它的只有豆包转写，而豆包转写本版不接（理由见
    // electron/main/services/asr/asrVendor.ts 抬头）；配音那一档有，见 tts 那几条断言
    expect(Object.keys(view.profiles.asr[0].values).sort()).toEqual([
      'asrApiBase',
      'asrAppId',
      'asrModel',
      'asrVendor',
    ])
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

describe('这一档 0 条方案时（新口径的「还没建过云端方案」）', () => {
  beforeEach(async () => {
    await writeFile(file(), v2Document({ asr: [] }, { asr: '' }, { asrProvider: 'cloud' }))
    await loadInto(dir)
  })

  it('凭据投成空值，模式与档位照样从全局段出来：本地转写不受影响', async () => {
    const settings = await service.loadSettings()
    expect(settings.asrModel).toBe('')
    expect(settings.asrApiBase).toBe('')
    expect(settings.asrApiKey).toBe('')
    const config = await service.getASRConfig()
    expect(config.provider).toBe('cloud')
    expect(config.localModel).toBe('base')
    // 「没填」与「读不出来」是两件事：这一档没有方案，密钥状态就是 none
    expect((await service.getSettingsView()).asrKeyStatus).toBe('none')
  })

  it('resolveProfileId 回空串——「现在没有正在使用的方案」是一个真状态', async () => {
    expect(await service.resolveProfileId('asr')).toBe('')
    expect(await service.resolveProfileId('asr', 'asr-ghost')).toBe('')
    // 另两档不受牵连：各自的默认那条还在
    expect(await service.resolveProfileId('ai')).toBe(DEFAULT_PROFILE_IDS.ai)
  })

  it('列表回空数组 + 空默认指针 + 上限，界面据此决定给「新建一套」还是给列表', async () => {
    const view = await service.listProfiles()
    expect(view.profiles.asr).toEqual([])
    expect(view.defaultProfileId.asr).toBe('')
    expect(view.maxProfiles).toBe(MAX_PROFILES_PER_CAPABILITY)
    expect(view.storageProblem).toBeNull()
  })

  it('首次运行（磁盘上根本没文件）：三档都 0 条，界面给的是那颗「新建API接入」', async () => {
    await resetDir()
    await loadInto(dir)
    const view = await service.listProfiles()
    expect(view.profiles).toEqual({ asr: [], ai: [], tts: [] })
    expect(view.defaultProfileId).toEqual({ asr: '', ai: '', tts: '' })
    // 三档空列表不许把零配置那条路堵死：全局段照 DEFAULT_SETTINGS 起步，本地转写照样投得出档位，
    // 校对在没有任何方案时投出的是「没填」+ 端点兜底，而不是一条凭空出现的空方案
    expect((await service.getASRConfig()).provider).toBe('local')
    expect((await service.getASRConfig()).localModel).toBe('base')
    expect((await service.getAIConfig()).apiKey).toBe('')
    expect((await service.getAIConfig()).apiBase).toBe('https://api.openai.com')
    // 只读不该在磁盘上留下任何文件
    expect(await keptNames()).toEqual([])
  })
})

describe('保存：全局段、落到哪一条、以及「先新建一套」', () => {
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

  it('不带 profileIds 就写默认那条', async () => {
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
    // 判据用「整份文件字节不变」，不用「目录里只有 settings.json」：这份 v2 fixture 在第一次读盘时
    // 会被迁移改写（并留一份 .bak）。那次写属于读路径，跟这次被拒的保存无关，所以先用一次只读
    // 把它趟出来，再拿之后的字节当基准——拿文件清单当证据会把迁移那一次算成这次保存的。
    await service.loadSettings()
    const before = await readFile(file(), 'utf-8')
    expect(
      await profileRuleRejection(service.saveSettings({ asrModel: 'nope', profileIds: { asr: 'asr-ghost' } }))
    ).toContain('已经没有这套方案')
    expect(await readFile(file(), 'utf-8')).toContain('keep-me')
    expect(diskProfile(await readJson(file()), 'asr', 'asr-default').model).toBe('keep-me')
    expect(await readFile(file(), 'utf-8')).toBe(before)
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

  it('非凭据那三项写进文档根，一条方案都不碰', async () => {
    await service.saveSettings({ asrProvider: 'cloud', asrLocalModel: 'small', asrLanguage: 'en' })
    const onDisk = await readJson(file())
    expect(onDisk).toMatchObject({ asrProvider: 'cloud', asrLocalModel: 'small', asrLanguage: 'en' })
    for (const id of ['asr-default', 'asr-work']) {
      const profile = diskProfile(onDisk, 'asr', id)
      expect(Object.keys(profile).filter((key) => ['provider', 'localModel', 'language'].includes(key))).toEqual([])
    }
    // 改模式/档位不该把「当前使用」那条顶掉
    expect(onDisk.defaultProfileId).toEqual({ ...DEFAULT_PROFILE_IDS })
  })

  it('「是否默认」那颗开关跟着保存落盘：翻到哪条，下一次取值就走那条', async () => {
    await service.saveSettings({ defaultProfileIds: { asr: 'asr-work' } })
    expect((await service.listProfiles()).defaultProfileId.asr).toBe('asr-work')
    expect((await service.getASRConfig()).model).toBe('other')
    // 指针换了，字段一个都没跟着改：这条补丁只带 defaultProfileIds
    expect(diskProfile(await readJson(file()), 'asr', 'asr-default').model).toBe('keep-me')
  })

  it('开关给空串＝明确「这一档现在没有当前使用」，不落回第一条', async () => {
    await service.saveSettings({ defaultProfileIds: { asr: '' } })
    const onDisk = await readJson(file())
    expect(onDisk.defaultProfileId).toMatchObject({ asr: '' })
    expect(await service.resolveProfileId('asr')).toBe('')
    expect((await service.getASRConfig()).model).toBe('')
  })

  it('开关给一个指不到人的 id 时报错，整个保存一个字都没落盘', async () => {
    // 同上一条：先一次只读把 v2→v3 的迁移写趟掉，之后的字节才是「这次保存之前磁盘上的样子」
    await service.loadSettings()
    const before = await readFile(file(), 'utf-8')
    expect(
      await profileRuleRejection(
        service.saveSettings({ asrModel: 'half-written', defaultProfileIds: { asr: 'asr-ghost' } })
      )
    ).toContain('已经没有这套方案')
    expect(diskProfile(await readJson(file()), 'asr', 'asr-default').model).toBe('keep-me')
    expect(await readFile(file(), 'utf-8')).toBe(before)
  })

  it('这一档 0 条方案却带着凭据来保存：报「先新建API接入」，磁盘一个字不动', async () => {
    await service.deleteProfile('asr', 'asr-work')
    await service.deleteProfile('asr', 'asr-default')
    const before = await readFile(file(), 'utf-8')
    expect(await profileRuleRejection(service.saveSettings({ asrModel: 'whisper-1' }))).toBe(
      PROFILE_CREATE_FIRST_MESSAGE
    )
    expect((await service.listProfiles()).profiles.asr).toEqual([])
    expect(await readFile(file(), 'utf-8')).toBe(before)
  })

  it('0 条方案时只改全局段的保存照样落盘（保存没坏，只是没地方放凭据）', async () => {
    await service.deleteProfile('asr', 'asr-work')
    await service.deleteProfile('asr', 'asr-default')
    await service.saveSettings({ asrProvider: 'local', asrLocalModel: 'small' })
    const onDisk = await readJson(file())
    expect(onDisk).toMatchObject({ asrProvider: 'local', asrLocalModel: 'small' })
    expect(diskProfiles(onDisk).asr).toEqual([])
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

  it('values 的键名就是界面上那套扁平名，且不包含密钥', async () => {
    const view = await service.listProfiles()
    // 三档都只剩「这家网关的参数」（Key 走状态位）：模式 / 档位 / 语言 / 引擎是全局段，不在方案里
    // tts 也从 v3 起不再带音色——用户事先不知道模型支持哪些音色，那是这一批怎么选的问题
    // 1.1.1 起 tts 多带一个「厂商」书签：它决定这次发的请求长什么样，所以是方案的一部分，不是全局偏好
    // asr 同一格叫 asrVendor 而不是 asrProvider：后者是「去不去云端」，一个名字不能同时说两件事
    // 1.1.2 起 tts 再多一格资源编号：只有豆包收（X-Api-Resource-Id），另三家不看这一项。
    // 它不是密钥，按明文留在方案里；键名不以 ApiKey/ApiSecret 结尾，所以下面那条
    // 「密钥的键名都不许出现」仍然成立。
    // 转写那一档没有这一格：收它的只有豆包转写，而豆包转写本版不接（理由见 asr/asrVendor.ts 抬头）
    // 1.1.2 起 asr 多一格 asrAppId：讯飞的签名要 AppID + APIKey + APISecret 三把，
    // 其中只有 AppID 不是密文（它同时是列表行上认人的那个标题），所以它进 values，另两把走状态位
    expect(Object.keys(view.profiles.asr[0].values).sort()).toEqual([
      'asrApiBase',
      'asrAppId',
      'asrModel',
      'asrVendor',
    ])
    expect(Object.keys(view.profiles.ai[0].values).sort()).toEqual(['aiApiBase', 'aiModel', 'aiProvider'])
    expect(view.profiles.ai[1].values.aiModel).toBe('gpt-b')
    expect(Object.keys(view.profiles.tts[0].values).sort()).toEqual([
      'ttsApiBase',
      'ttsModel',
      'ttsProvider',
      'ttsResourceId',
    ])
    // 连密钥的**键名**都不许出现：表单把这一份直接盖到自己身上，
    // 多出 asrApiKey 就会把用户刚粘进输入框的那把 Key 冲成空串。
    // 1.1.2 起密文有两种后缀（讯飞那把叫 asrApiSecret），判式跟着收两种
    for (const cap of ['asr', 'ai', 'tts'] as const) {
      for (const profile of view.profiles[cap]) {
        expect(Object.keys(profile.values).filter((key) => /Api(Key|Secret)$/.test(key))).toEqual([])
      }
    }
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
        asr: [
          { id: 'asr-default', name: '默认', apiKey: sealed('sk-src'), apiBase: 'https://src.example', model: 'src-model' }
        ]
      })
    )
    await loadInto(dir)
  })

  it('values 说了算：界面此刻填的那三项变成一条新方案', async () => {
    const view = await service.createProfile('asr', {
      values: { asrApiBase: 'https://new.example', asrModel: 'whisper-1', asrApiKey: 'sk-new' }
    })
    const created = await onlyExtra('asr', ['asr-default'])
    expect(created.id).toMatch(/^asr-[0-9a-f]{8}$/)
    expect(created.apiBase).toBe('https://new.example')
    expect(created.model).toBe('whisper-1')
    // Key 当场封好，磁盘上不许出现明文
    expect(created.apiKey).toBe(sealed('sk-new'))
    expect(await readFile(file(), 'utf-8')).not.toContain('sk-new')
    expect(view.profiles.asr[1].keyStatus).toBe('encrypted')
  })

  it('没给 values 才照当前那条复制，密钥原样搬运（不重新封一次）', async () => {
    const view = await service.createProfile('asr', { name: '工作' })
    const created = await onlyExtra('asr', ['asr-default'])
    expect(created.model).toBe('src-model')
    expect(created.apiBase).toBe('https://src.example')
    expect(created.apiKey).toBe(sealed('sk-src'))
    // 磁盘上不许出现明文，也不许因为「复制」多出一份解不开的东西
    expect(await readFile(file(), 'utf-8')).not.toContain('sk-src')
    expect((await service.loadSettings({ asr: view.profiles.asr[1].id })).asrApiKey).toBe('sk-src')
  })

  it('values 里 Key 给空串＝真的空（界面允许「缺 Key」），不沿用上一家的那把', async () => {
    await service.createProfile('asr', { values: { asrApiBase: 'https://self-host.example', asrApiKey: '' } })
    const created = await onlyExtra('asr', ['asr-default'])
    expect(created.apiKey).toBe('')
    expect(created.apiBase).toBe('https://self-host.example')
    // 自建网关那条常常不要 Key：界面上它得是「缺 Key」，而不是躺着上一家的密钥
    expect((await service.loadSettings({ asr: String(created.id) })).asrApiKey).toBe('')
  })

  it('fromProfileId 传空串＝真·空白一套：字段回默认值且不带上一套的 Key', async () => {
    await service.createProfile('asr', { name: '空白', fromProfileId: '' })
    const created = await onlyExtra('asr', ['asr-default'])
    expect(created.apiKey).toBe('')
    expect(created.model).toBe('')
    expect(created.apiBase).toBe('')
    // 全局段那三项从此就不在方案里了：空白一套不会带着上一家的语言/档位
    expect('provider' in created).toBe(false)
  })

  it('照着一条不存在的方案复制要报错，而不是凭空给一条空白', async () => {
    expect(
      await profileRuleRejection(service.createProfile('asr', { name: '二', fromProfileId: 'asr-ghost' }))
    ).toContain('已经没有这套方案')
  })

  it('第一条自动是当前使用；之后的几条只在开关明确开着时才改指针', async () => {
    const second = await service.createProfile('asr', { values: { asrModel: 'm-2' } })
    // 已经有默认那条了，新建第二条不动指针：下一次转写用的还是原来那套
    expect(second.defaultProfileId.asr).toBe('asr-default')
    expect((await service.getASRConfig()).model).toBe('src-model')

    const third = await service.createProfile('asr', { values: { asrModel: 'm-3' }, setDefault: true })
    expect(third.defaultProfileId.asr).toBe(third.profiles.asr[2].id)
    expect((await service.getASRConfig()).model).toBe('m-3')
  })

  it('名字：给了用给的，没给落模型名，再没有才「方案 N」', async () => {
    const named = await service.createProfile('asr', { name: '  公司网关  ', values: { asrModel: 'm-a' } })
    expect(named.profiles.asr[1].name).toBe('公司网关')
    const byModel = await service.createProfile('asr', { values: { asrModel: 'whisper-1' } })
    expect(byModel.profiles.asr[2].name).toBe('whisper-1')
    const blank = await service.createProfile('ai', { fromProfileId: '' })
    expect(blank.profiles.ai[1].name).toBe('方案 1')
  })

  it('第 4 条被拦，界面上那句与这里同一句；磁盘一个字没动', async () => {
    await service.createProfile('asr', { name: '二' })
    await service.createProfile('asr', { name: '三' })
    const before = await readFile(file(), 'utf-8')
    await expect(service.createProfile('asr', { name: '四' })).rejects.toThrow(PROFILE_LIMIT_MESSAGE)
    expect((await service.listProfiles()).profiles.asr).toHaveLength(MAX_PROFILES_PER_CAPABILITY)
    expect(await readFile(file(), 'utf-8')).toBe(before)
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
    await expect(service.createProfile('asr', { name: '六' })).rejects.toThrow(PROFILE_LIMIT_MESSAGE)
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
      v2Document(
        {
          asr: [
            { id: 'asr-1', name: '第一个', apiKey: sealed('sk-1'), model: 'm-1' },
            { id: 'asr-2', name: '第二个', apiKey: sealed('sk-2'), model: 'm-2' },
            { id: 'asr-3', name: '第三个', apiKey: '', model: 'm-3' }
          ]
        },
        { asr: 'asr-1' }
      )
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
    expect(view.defaultProfileId.asr).toBe('asr-1')
    const onDisk = await readJson(file())
    expect(diskProfile(onDisk, 'asr', 'asr-1').apiKey).toBe(sealed('sk-1'))
    expect(await readFile(file(), 'utf-8')).not.toContain('sk-2')
  })

  it('删掉的正是当前使用那条时，转写落空串而不是替用户挑第一条', async () => {
    const view = await service.deleteProfile('asr', 'asr-1')
    // 下一次转写花在哪家网关是按这条计的；悄悄换成列表排第一的那条等于替他决定
    expect(view.defaultProfileId.asr).toBe('')
    expect(await service.resolveProfileId('asr')).toBe('')
    expect((await service.getASRConfig()).model).toBe('')
    // 另外两条与它们的 Key 都不动
    expect(view.profiles.asr.map((p) => p.id)).toEqual(['asr-2', 'asr-3'])
    expect((await service.loadSettings({ asr: 'asr-2' })).asrApiKey).toBe('sk-2')
  })

  it('删到最后一条也放行：这一档从此是 0 配置，磁盘上真的空了', async () => {
    await service.deleteProfile('asr', 'asr-2')
    const oneLeft = await service.deleteProfile('asr', 'asr-3')
    expect(oneLeft.profiles.asr.map((p) => p.id)).toEqual(['asr-1'])
    expect(oneLeft.defaultProfileId.asr).toBe('asr-1')

    // 最后这条正是「当前使用」：删完既不拦人，也不替用户挑一条
    const view = await service.deleteProfile('asr', 'asr-1')
    expect(view.profiles.asr).toEqual([])
    expect(view.defaultProfileId.asr).toBe('')
    expect(diskProfiles(await readJson(file())).asr).toEqual([])
    // 删空之后这一次转写的凭据就是「没填」，而不是随手抓住被删掉那条
    expect((await service.loadSettings()).asrModel).toBe('')
    expect(await service.resolveProfileId('asr')).toBe('')
  })

  it('删空再新建：第一条自动成为当前使用，界面不用再找开关', async () => {
    for (const id of ['asr-1', 'asr-2', 'asr-3']) await service.deleteProfile('asr', id)
    const view = await service.createProfile('asr', { values: { asrModel: 'first-again', asrApiKey: 'sk-1' } })
    expect(view.defaultProfileId.asr).toBe(view.profiles.asr[0].id)
    expect((await service.getASRConfig()).model).toBe('first-again')
    expect((await service.getASRConfig()).localModel).toBe('base')
  })

  it('换默认：下一次取值就走这条，无需重启', async () => {
    const view = await service.setDefaultProfile('asr', 'asr-3')
    expect(view.defaultProfileId.asr).toBe('asr-3')
    expect((await service.getASRConfig()).model).toBe('m-3')
    // 只改这一档的指向，另两档不该跟着动
    expect(view.defaultProfileId.ai).toBe(DEFAULT_PROFILE_IDS.ai)
  })

  it('三档同口径：id 指不到人一律落空串，不替用户挑第一条', async () => {
    await writeFile(
      file(),
      v2Document({
        ai: [
          { id: 'ai-a', name: 'A', apiKey: '', model: 'gpt-a' },
          { id: 'ai-b', name: 'B', apiKey: '', model: 'gpt-b' }
        ]
      }, { ai: 'ai-ghost' })
    )
    await loadInto(dir)
    // 校对/配音以前在这里兜第一条，是因为那两档的取值还没有「没选」这个状态；
    // 换成同一个列表口径之后，兜底就成了唯一的分叉——落第一条等于用排第一的那家网关
    // 替用户做了决定，而下一次花的钱按那条计价
    expect((await service.listProfiles()).defaultProfileId.ai).toBe('')
    expect(await service.resolveProfileId('ai')).toBe('')
    expect((await service.getAIConfig()).apiKey).toBe('')
    await service.deleteProfile('ai', 'ai-a')
    expect((await service.listProfiles()).defaultProfileId.ai).toBe('')
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
    await expect(service.createProfile('asr', { name: '新' })).rejects.toThrow(SETTINGS_WRITE_BLOCKED)
    await expect(service.renameProfile('tts', DEFAULT_PROFILE_IDS.tts, '改')).rejects.toThrow(
      SETTINGS_WRITE_BLOCKED
    )
    await expect(service.setDefaultProfile('tts', DEFAULT_PROFILE_IDS.tts)).rejects.toThrow(
      SETTINGS_WRITE_BLOCKED
    )
    // 闸门先看，再看「这条方案在不在」：读失败时内存里是默认 store（三档都空），
    // 界面手里每个 id 都「指不到人」——先报规矩那句等于让用户去找一把自己没删过的方案
    await expect(service.deleteProfile('tts', DEFAULT_PROFILE_IDS.tts)).rejects.toThrow(SETTINGS_WRITE_BLOCKED)
    await expect(service.deleteProfile('asr', 'asr-default')).rejects.toThrow(SETTINGS_WRITE_BLOCKED)
    expect(await keptNames()).toEqual(['settings.json'])
  })

  it('原件被留档过时，增删改的返回值也带着这句结论', async () => {
    // corrupt 的语义是「原件保住了、可以继续写」，所以这里允许落盘；但 storageProblem
    // 必须一路带着——界面据此决定说的是「你还没填」还是「这份没读出来」
    await writeFile(file(), '{"asrProvider":"local","aiApiKey":"v1:')
    await loadInto(dir)
    expect((await service.listProfiles()).storageProblem).toContain('没能解析')
    const view = await service.createProfile('asr', { name: '新' })
    expect(view.storageProblem).toContain('没能解析')
    // 默认 store 的转写档是 0 条，新建完就是 1 条——这条同时证明「0 起步」不是读盘失败给的假象
    expect(view.profiles.asr).toHaveLength(1)
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
        asr: [{ id: 'asr-default', name: '默认', apiKey: sealed('sk-asr'), model: 'whisper-1' }],
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
    const got = (await call('settings:createProfile', 'tts', { name: 'C' })) as ProfilesResult
    expect(got.error).toBeNull()
    expect(got.profiles?.profiles.tts.map((p) => p.name)).toEqual(['默认', 'B', 'C'])
    expect(got.profiles?.defaultProfileId.tts).toBe('tts-default')
  })

  it('新建把界面此刻的输入整份带过去：values 与 setDefault 都吃到', async () => {
    const got = (await call('settings:createProfile', 'asr', {
      values: { asrApiBase: 'https://gate.example', asrModel: 'gate-model', asrApiKey: 'sk-from-form' },
      setDefault: true,
    })) as ProfilesResult
    expect(got.error).toBeNull()
    expect(got.profiles?.defaultProfileId.asr).toBe(got.profiles?.profiles.asr[1].id)
    expect(got.profiles?.profiles.asr[1].values).toMatchObject({
      asrApiBase: 'https://gate.example',
      asrModel: 'gate-model'
    })
    // 跨 IPC 回来的只有状态位，Key 的明文和密文都不许出现
    expect(JSON.stringify(got)).not.toContain('sk-from-form')
    expect(JSON.stringify(got)).not.toContain('v1:')
    expect(got.profiles?.profiles.asr[1].keyStatus).toBe('encrypted')
  })

  /**
   * 这条通道以前收的是位置参数（capability, name, fromProfileId）。漏改一处调用不会崩，
   * 只会把名字静默吞掉——所以这里钉住「第二参只认对象」：字符串一律当「没给」。
   */
  it('第二参给字符串（旧的位置参数形状）不会被当成方案名', async () => {
    const got = (await call('settings:createProfile', 'tts', 'C') as ProfilesResult)
    expect(got.error).toBeNull()
    // 名字落的是复制过来的模型名，而不是那根被丢掉的字符串
    expect(got.profiles?.profiles.tts.map((p) => p.name)).toEqual(['默认', 'B', 'tts-1'])
  })

  it('规则不成立时是一句话 + 当前列表，渲染层的 await 不会抛', async () => {
    const got = (await call('settings:deleteProfile', 'asr', 'asr-ghost')) as ProfilesResult
    expect(got.error).toContain('已经没有这套方案')
    expect(got.profiles?.profiles.asr).toHaveLength(1)

    const bad = (await call('settings:renameProfile', 'tts', 'tts-ghost', 'x')) as ProfilesResult
    expect(bad.error).toContain('已经没有这套方案')
    expect(bad.profiles?.profiles.tts.map((p) => p.id)).toEqual(['tts-default', 'tts-b'])
  })

  it('删掉这一档最后一条也回成功，列表就此空掉（0 配置是合法结局）', async () => {
    const got = (await call('settings:deleteProfile', 'asr', 'asr-default')) as ProfilesResult
    expect(got.error).toBeNull()
    expect(got.profiles?.profiles.asr).toEqual([])
    expect(got.profiles?.defaultProfileId.asr).toBe('')
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
    const got = (await call('settings:createProfile', 'asr', { name: '新' })) as ProfilesResult
    expect(got.error).toBe(SETTINGS_WRITE_BLOCKED)
    // 列表回的是「按默认配置开始」那一份，配上 storageProblem 才说得清它不是用户的东西；
    // 这里要钉住的是没落盘（settings.json 仍是那个目录）+ 那句话没有被换成通用文案
    expect(got.profiles?.storageProblem).toContain('保存已暂时停用')
    expect(got.profiles?.profiles.asr).toHaveLength(0)
    expect(await keptNames()).toEqual(['settings.json'])
  })

  it('通道返回值里不许出现任何一把 Key 的明文', async () => {
    const got = (await call('settings:createProfile', 'tts', { name: 'C' })) as ProfilesResult
    expect(JSON.stringify(got)).not.toContain('sk-tts')
    expect(JSON.stringify(got)).not.toContain('v1:')
  })

  describe('settings:testConnection 的回落读哪一条方案', () => {
    /** 探针最后一次收到的那一份参数＝这次回落最终用了什么；mockReset 会把实现也清掉，所以每次重挂 */
    const probed = (kind: 'asr' | 'ai' | 'tts') => {
      const fn = kind === 'asr' ? probe.asr : kind === 'ai' ? probe.ai : probe.tts
      expect(fn).toHaveBeenCalled()
      return fn.mock.calls[fn.mock.calls.length - 1][0] as Record<string, string>
    }

    beforeEach(async () => {
      await writeFile(
        file(),
        v2Document({
          ai: [
            {
              id: 'ai-default',
              name: '默认',
              apiKey: sealed('sk-默认'),
              apiBase: 'https://a.example',
              model: 'gpt-a'
            },
            {
              id: 'ai-b',
              name: 'B',
              apiKey: sealed('sk-B'),
              apiBase: 'https://b.example',
              model: 'gpt-b'
            }
          ],
          tts: [
            { id: 'tts-default', name: '默认', apiKey: '', apiBase: '', model: 'tts-1' },
            { id: 'tts-b', name: 'B', apiKey: '', apiBase: '', model: 'tts-2' }
          ]
        })
      )
      await loadInto(dir)
      for (const fn of [probe.asr, probe.ai, probe.tts]) {
        fn.mockReset().mockResolvedValue({ level: 'pass', title: '假探针', message: '没发真请求' })
      }
      await register()
    })

    /** 表单里 Key 留空＝拿已保存的那把去测，这一条从第②步就有；这里核的是「哪一条的」 */
    it('Key 留空时回落取这次发来的那条方案，不取该档默认那条', async () => {
      await call(
        'settings:testConnection',
        'ai',
        { apiBase: 'https://b.example', apiKey: '', model: 'gpt-b' },
        'ai-b'
      )
      expect(probed('ai')).toMatchObject({ apiKey: 'sk-B' })
    })

    it('不带 id 时按该档默认那条回落；带了却指不到人时同样落回默认（与真干活同一口径）', async () => {
      await call('settings:testConnection', 'ai', { apiBase: 'https://a.example', apiKey: '', model: 'gpt-a' })
      expect(probed('ai')).toMatchObject({ apiKey: 'sk-默认' })

      await call(
        'settings:testConnection',
        'ai',
        { apiBase: 'https://a.example', apiKey: '', model: 'gpt-a' },
        'ai-ghost'
      )
      expect(probed('ai')).toMatchObject({ apiKey: 'sk-默认' })
    })

    /**
     * 配音的地址与 Key 留空时沿用「校对那套」，而这一套**固定是校对档当前默认那条**——
     * 因为真配音时 getTTSConfig 也只做 `loadSettings({tts: id})`，界面正在编辑的校对方案
     * 不参与。测试要是跟着界面把校对换成 B 套，就会出现「自检按 B 家网关绿了、
     * 点开始配音却走 A 家」，那正是这条链路一路在躲的分歧（见 settingsService 里 getTTSConfig 的注释）。
     */
    it('配音的回落走校对默认那条，不走界面正在编辑的校对方案', async () => {
      await call(
        'settings:testConnection',
        'tts',
        { engine: 'cloud', apiBase: '', apiKey: '', model: 'tts-2', voice: 'alice' },
        'tts-b'
      )
      expect(probed('tts')).toMatchObject({ apiKey: 'sk-默认', apiBase: 'https://a.example' })
    })

    /** 第三参只收一个字符串。形状不对就当没带：这条通道不接受「三档各指一条」 */
    it('把三档 id 一起塞进第三参不会被吃进去', async () => {
      await call(
        'settings:testConnection',
        'tts',
        { engine: 'cloud', apiBase: '', apiKey: '', model: 'tts-2', voice: 'alice' },
        { tts: 'tts-b', ai: 'ai-b' }
      )
      expect(probed('tts')).toMatchObject({ apiKey: 'sk-默认', apiBase: 'https://a.example' })
    })

    /** 本地配音档不看地址与 Key：跟着回落等于把没填校对配置的人拦在门外（#220/#227） */
    it('本地配音档不参与回落，Key 留空照样开测', async () => {
      await call(
        'settings:testConnection',
        'tts',
        { engine: 'local', apiBase: '', apiKey: '', model: '', localEngine: 'vits', voice: '0' },
        'tts-b'
      )
      expect(probed('tts')).toMatchObject({ apiKey: '', apiBase: '' })
    })

    it('那条方案的 Key 在这台机器上解不开时，报的是「读不出」而不是「还没填」', async () => {
      await writeFile(
        file(),
        v2Document({
          ai: [
            { id: 'ai-default', name: '默认', apiKey: '', apiBase: 'https://a.example', model: 'gpt-a' },
            {
              id: 'ai-b',
              name: 'B',
              // 解不开的形式：前缀对、内容不是那段假加密能认的（setup.ts 只认 fake: 前缀）
              apiKey: 'v1:' + Buffer.from('不是这台机器封的', 'utf-8').toString('base64'),
              apiBase: 'https://b.example',
              model: 'gpt-b'
            }
          ]
        })
      )
      await loadInto(dir)
      probe.ai.mockReset().mockResolvedValue({ level: 'pass', title: '假探针', message: '没发真请求' })
      await register()

      const got = (await call(
        'settings:testConnection',
        'ai',
        { apiBase: 'https://b.example', apiKey: '', model: 'gpt-b' },
        'ai-b'
      )) as { level: string; title: string; message: string }
      expect(got.level).toBe('fail')
      expect(got.message).toContain('读不出')
      expect(probe.ai).not.toHaveBeenCalled()
    })
  })

  describe('settings:save 的档位重启判定（档位是全局段，与方案无关）', () => {
    /**
     * 引擎驻留的档位只在 spawn 时定下来（HF_HUB_OFFLINE 也在那一刻决定），所以「要不要重启」
     * 比较的是**全局段**那一份 asrLocalModel 的前后值。
     * 重写之前它是方案字段，于是「编辑一条没在用的方案」也会牵动引擎——正在跑的转写被截断，
     * 界面还附赠一句「新档位才会生效」。现在这项退回全局段，那条误伤必须测出来：
     * 改方案凭据一律不动引擎，改档位必动。
     */
    beforeEach(async () => {
      await writeFile(
        file(),
        v2Document(
          {
            asr: [
              { id: 'asr-default', name: '默认', apiKey: '', model: 'm-default' },
              { id: 'asr-b', name: 'B', apiKey: '', model: 'm-b' },
            ]
          },
          { asr: 'asr-default' },
          { asrLocalModel: 'base' }
        )
      )
      await loadInto(dir)
      engine.restart.mockReset().mockResolvedValue({ ok: true })
      engine.busy.mockReset().mockReturnValue(false)
      await register()
    })

    it('改档位就重启，回给界面的视图说的是刚写进去的那一份', async () => {
      const got = (await call('settings:save', { asrLocalModel: 'small' })) as SaveResult
      expect(got.tierRestart).toBe('done')
      expect(got.error).toBeNull()
      expect(engine.restart).toHaveBeenCalledTimes(1)
      expect(got.settings?.asrLocalModel).toBe('small')
      expect((await readJson(file())).asrLocalModel).toBe('small')
    })

    it('编辑方案的凭据不牵动引擎——哪怕改的就是当前使用那条', async () => {
      const got = (await call('settings:save', {
        asrModel: 'whisper-1',
        profileIds: { asr: 'asr-default' },
      })) as SaveResult
      expect(got.saveError).toBeNull()
      expect(got.tierRestart).toBe('not-needed')
      expect(engine.restart).not.toHaveBeenCalled()
      expect(diskProfile(await readJson(file()), 'asr', 'asr-default').model).toBe('whisper-1')
    })

    it('非默认那条也一样不重启，且改动照样落盘', async () => {
      const got = (await call('settings:save', {
        asrModel: 'edited-in-place',
        profileIds: { asr: 'asr-b' },
      })) as SaveResult
      expect(got.tierRestart).toBe('not-needed')
      expect(got.error).toBeNull()
      expect(engine.restart).not.toHaveBeenCalled()
      const onDisk = await readJson(file())
      expect(diskProfile(onDisk, 'asr', 'asr-b').model).toBe('edited-in-place')
      expect(diskProfile(onDisk, 'asr', 'asr-default').model).toBe('m-default')
    })

    it('有转写正在跑时不许动引擎，但那句话必须送到界面上', async () => {
      engine.busy.mockReturnValue(true)
      const got = (await call('settings:save', { asrLocalModel: 'small' })) as SaveResult
      expect(got.tierRestart).toBe('busy')
      expect(got.error).toContain('新档位才会生效')
      expect(engine.restart).not.toHaveBeenCalled()
      // 档位已经存下来了，只是引擎还没吃到——界面靠的就是「saveError 为 null + error 非 null」这一对
      expect(got.saveError).toBeNull()
      expect((await readJson(file())).asrLocalModel).toBe('small')
    })

    it('重启没成也要说出口，不能把「存下来了」当成「生效了」', async () => {
      engine.restart.mockResolvedValue({ ok: false })
      const got = (await call('settings:save', { asrLocalModel: 'small' })) as SaveResult
      expect(got.tierRestart).toBe('failed')
      expect(got.error).toContain('没能自动重启')
    })

    it('档位没动的保存一次引擎都不碰', async () => {
      const got = (await call('settings:save', { asrApiBase: 'https://same.example' })) as SaveResult
      expect(got.tierRestart).toBe('not-needed')
      expect(engine.restart).not.toHaveBeenCalled()
    })

    it('档位写坏成表外的值时按 base 收口，前后一样就不重启', async () => {
      await writeFile(file(), v2Document({}, {}, { asrLocalModel: 'tiny' }))
      await loadInto(dir)
      engine.restart.mockReset().mockResolvedValue({ ok: true })
      await register()
      const got = (await call('settings:save', { asrLocalModel: 'base' })) as SaveResult
      expect(got.tierRestart).toBe('not-needed')
      expect(engine.restart).not.toHaveBeenCalled()
    })
  })

  describe('settings:save 那句失败的话按来源分两种形状', () => {
    it('方案的规矩没守住：送到界面的是那句出路，不是「清出磁盘空间」', async () => {
      // 这一档一条方案都没有而补丁带着凭据——出路是那一栏那颗「新建API接入」，磁盘好得很。
      // 第⑧步起三档的凭据都只从弹窗进来、由弹窗自己落盘，界面正常操作走不到这条闸门；
      // 这里直连 IPC 钉的是主进程侧的不变量：绕过弹窗往 settings:save 塞凭据也得先建一条。
      // 第⑤步那轮 CDP 实测到的是另一回事：删掉最后一条方案后只改「转写语言」点保存，
      // 界面回的是「设置没能写入（…）。…清出磁盘空间或修好目录权限后再存一次」，
      // 让人去查一个没坏的磁盘。`profilesErrorMessage` 早就原样透出这一类，save 这条漏了一层。
      await writeFile(file(), v2Document({ asr: [], ai: [], tts: [] }, { asr: '', ai: '', tts: '' }))
      await loadInto(dir)
      await register()
      const got = (await call('settings:save', { aiApiBase: 'https://gate.example' })) as SaveResult
      expect(got.saveError).toBe(PROFILE_CREATE_FIRST_MESSAGE)
      expect(got.saveError).not.toContain('磁盘')
    })

    it('真是写不进去：errno 那句和「你填的还在界面上」两句都得留着', async () => {
      // 上一条不许把这整类一起吞掉——把目录收成只读，rename 必失败，
      // 那时「不用重填」是唯一能安慰到人、也唯一说对了的话。
      // 这一条跑完 stderr 会多出两句 `[Logger] Failed to write log`：同一只读目录里 logs/ 也建不出来，
      // 正是「日志写不进去，但那句 saveError 照样送到界面」的证据，不是测试坏了
      await chmod(dir, 0o500)
      try {
        const got = (await call('settings:save', { asrApiBase: 'https://gate.example' })) as SaveResult
        expect(got.saveError).toContain('设置没能写入')
        expect(got.saveError).toContain('不用重填')
      } finally {
        await chmod(dir, 0o700)
      }
    })
  })
})
