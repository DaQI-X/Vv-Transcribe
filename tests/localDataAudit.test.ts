/**
 * 「本机数据与缓存」那张八项清单与它的删除出口（#416 落地，进 1.2.6）。
 *
 * 这一层是「用户勾一下就会删真实文件」的那一层，所以判式全在真盘上跑：`walk` / `removeTree` /
 * 两棵树的回收都拿临时目录造真文件，**不 mock node:fs**——把文件系统换掉等于把「删到哪」这件事
 * 写进前提里，那正是这条链路唯一要证的东西。兄弟模块只换掉两类：问别人「在不在用」的闸门
 * （配音批次、本地引擎、正在播放的临时目录）与「按需组件」面板的出口（行值与删除回话），
 * 因为那些状态各有自己的归属测试（#439 那四台机器在 componentRowState.test.ts）。
 *
 * 钉的机器，按「删错了代价有多大」排：
 * 1. 默认只勾四项纯派生物。组件/历史/设置默认不勾——一键全清会带走 API Key 与历史，
 *    这就是「清空所有本地数据」不能做成一颗按钮的理由，判式必须有人守着。
 * 2. 未知 id **整批拒绝且一个字节都不动**。白名单就是 SPECS 那份；这条拦的是「界面传什么都
 *    能删到别的路径」，所以断言落在真盘上：拒绝之后 logs 与 settings.json 都还在。
 * 3. 正在配音时只有片段缓存那一项被拒，其余照删——勾了六项不该因为一项白删五项。
 *    被拒那项不给 `freed`：虚报「释放了多大」比漏报更坏。
 * 4. 组件那一项的 `freed` 是「清完再量一遍」的差值。一行转写权重的 `bytes` 是两棵树去重后的
 *    并集（#439），拿各行相加会把其实还在盘上的那份报成已释放；`outsideOnly` 那句拒绝是说明，
 *    不进 `failed`。
 * 5. `hub/` 那层的共享 blob：`.refs` 行行都点名我们那两档才回收；混进别家仓库、或压根没有
 *    `.refs`，一律留下，并在 note 里报还剩多少 MB（本机实测那枚 461MB 就住在这一层）。
 * 6. 引擎还在跑时整棵 HF 树不碰，note 说清「停引擎后再清一次」。
 * 7. 临时媒体里正在被会话占着的那一个跳过：清单不数它，清理也不删它。
 * 8. 清完之后目录壳留着：logger 建目录只跑第一次，整层删掉等于把这一轮之后的日志静默扔掉。
 *    （这条不是推演出来的，是设置页真点了一次「清空选中的 1 项」之后在磁盘上看到的。）
 *
 * ⚠️ hub 那棵树必须落在 `realpath` 之后的目录上。`reclaimSharedBlobs` 拿快照软链解析出的真身与
 * `hubCacheDir()/blobs` 比前缀，而 macOS 的 `tmpdir()` 本身就是 `/var → /private/var` 的软链——
 * 不先 realpath，前缀永远对不上，整层回收会**静默跳过**（第 5 台机器是这条判式唯一的守门人，
 * 别让它因为路径没对上而演成「什么都没删所以通过」）。
 */
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 组件面板那几行的替身：这一层只读 id/title/bytes/installed，删除回话按 outsideOnly/busy 分岔 */
interface FakeRow {
  id: string
  title: string
  bytes: number
  installed: boolean
  outsideOnly?: boolean
  busy?: string
}

const state = vi.hoisted(() => ({
  /** 替身用的临时媒体前缀：真那枚是 `transcribe-`，测试换掉才不会扫到本机正在用的会话目录 */
  mediaPrefix: 'vv-test-media-',
  synthesis: false,
  engineRunning: false,
  activeMedia: [] as string[],
  rows: [] as FakeRow[],
  removed: [] as string[],
}))

vi.mock('../electron/main/services/ttsService', () => ({
  hasActiveTTSSynthesis: () => state.synthesis,
}))
vi.mock('../electron/main/services/asrServiceManager', () => ({
  isLocalEngineRunning: () => state.engineRunning,
}))
vi.mock('../electron/main/services/urlDownloader', () => ({
  MEDIA_TEMP_PREFIX: state.mediaPrefix,
  activeMediaTempDirs: () => state.activeMedia,
}))
vi.mock('../electron/main/services/componentService', () => ({
  listComponents: async () =>
    state.rows.map((row) => ({ id: row.id, title: row.title, bytes: row.bytes, installed: row.installed })),
  removeComponent: async (id: string) => {
    const row = state.rows.find((r) => r.id === id)
    if (!row) return { ok: false, error: `没有 ${id} 这个组件` }
    if (row.outsideOnly) {
      return { ok: false, outsideOnly: true, error: `${row.title} 在组件目录里没有副本，这一行只能删应用自己下载的那一份` }
    }
    if (row.busy) return { ok: false, error: row.busy }
    row.installed = false
    state.removed.push(id)
    return { ok: true, error: null }
  },
}))
vi.mock('../electron/main/services/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    serviceCall: vi.fn(),
    serviceError: vi.fn(),
    userAction: vi.fn(),
  },
}))

import { auditLocalData, clearLocalData } from '../electron/main/services/localDataAudit'
import { asrEngineRepoDirs } from '../electron/main/services/asrModelUsage'
import {
  dictionaryDir,
  logsDir,
  settingsFile,
  ttsClipCacheDir,
  userDataPath,
  userDataRoot,
} from '../electron/main/services/userDataStore'

let hub = ''
/** 本轮造的临时媒体目录，收尾自己清掉（别在 /tmp 里留一堆） */
const madeMedia: string[] = []

/** 写一枚恰好 `bytes` 字节的文件：断言里的数都是自己算出来的，不是估的 */
async function put(path: string, bytes: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, Buffer.alloc(bytes, 'a'))
}

/** beforeEach 量一次空盘，供「顺序与默认勾选」那条读；其余用例各自现量，别拿这份当现状 */
let emptyAudit = await auditLocalData()

beforeEach(async () => {
  state.synthesis = false
  state.engineRunning = false
  state.activeMedia = []
  state.rows = []
  state.removed = []
  // 引擎旧路那棵树：hub 必须先 realpath，理由见文件头那条 ⚠️
  hub = await realpath(await mkdtemp(join(tmpdir(), 'vv-hub-')))
  process.env.HF_HUB_CACHE = hub
  delete process.env.HUGGINGFACE_HUB_CACHE
  delete process.env.HF_HOME
  // userData 是 tests/setup.ts 给这个 worker 的临时目录，每条用例从空盘开始，别拿上一条的货当现状
  await rm(userDataRoot(), { recursive: true, force: true })
  emptyAudit = await auditLocalData()
})

afterEach(async () => {
  delete process.env.HF_HUB_CACHE
  await rm(userDataRoot(), { recursive: true, force: true })
  await rm(hub, { recursive: true, force: true })
  for (const dir of madeMedia.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('清单口径：谁默认勾上、每个数从哪来', () => {
  it('八项的顺序、分组与默认勾选：只有纯派生物默认勾（#416 不做「一键全清」的理由）', async () => {
    expect(emptyAudit.items.map((i) => i.id)).toEqual([
      'clips',
      'media',
      'logs',
      'dictionary',
      'components',
      'ytdlp',
      'records',
      'settings',
    ])
    expect(emptyAudit.items.filter((i) => i.defaultOn).map((i) => i.id)).toEqual([
      'clips',
      'media',
      'logs',
      'dictionary',
    ])
    expect(emptyAudit.items.map((i) => i.group)).toEqual([
      'cache',
      'cache',
      'cache',
      'cache',
      'component',
      'component',
      'personal',
      'personal',
    ])
    // 后两段（要重新下的 / 找不回来的）天生不该被默认勾上——界面传什么都不该把它们演成「已勾」
    expect(emptyAudit.items.filter((i) => i.group !== 'cache').every((i) => !i.defaultOn)).toBe(true)
  })

  it('每项目录都量对：cacheBytes 只合计勾上的，组件那一项取面板同一个数（#438 同源）', async () => {
    await put(join(ttsClipCacheDir(), 'aa.mp3'), 1000)
    // 元数据那枚 .json 不计数：这是 clipCacheStats 自己的口径，混进来说「几段」会虚
    await put(join(ttsClipCacheDir(), 'aa.json'), 60)
    await put(join(logsDir(), 'app.log'), 2000)
    await put(join(dictionaryDir(), 'dict.json'), 500)
    await put(settingsFile(), 100)
    const recordBytes = 40
    await put(userDataPath('components', 'installed.json'), recordBytes)
    state.rows = [{ id: 'asr-model-small', title: '本地转写模型（small）', bytes: 483_546_902, installed: true }]

    const a = await auditLocalData()
    expect(a.items.find((i) => i.id === 'clips')).toMatchObject({ bytes: 1000, files: 1 })
    expect(a.items.find((i) => i.id === 'logs')?.bytes).toBe(2000)
    expect(a.items.find((i) => i.id === 'dictionary')?.bytes).toBe(500)
    expect(a.items.find((i) => i.id === 'settings')?.bytes).toBe(100)
    // 组件那一项 = 面板每行 bytes 之和 + 那份记账；不另走一遍目录，否则同屏又是两个数
    expect(a.items.find((i) => i.id === 'components')).toMatchObject({
      bytes: 483_546_902 + recordBytes,
      files: 1,
    })
    expect(a.cacheBytes).toBe(1000 + 2000 + 500)
    expect(a.totalBytes).toBe(1000 + 2000 + 500 + (483_546_902 + recordBytes) + 100)
    expect(a.error).toBeNull()
  })
})

describe('删除出口：白名单、闸门、以及 freed 那把尺', () => {
  it('出现清单里不认识的 id：整批拒绝，真盘上一个字节都不动', async () => {
    await put(join(logsDir(), 'app.log'), 2000)
    await put(settingsFile(), 100)
    const out = await clearLocalData(['logs', '../../../../tmp'])
    expect(out.ok).toBe(false)
    expect(out.error).toContain('不认识的清理项')
    expect([out.cleared, out.failed, out.freed]).toEqual([[], [], 0])
    // 拒绝发生在任何一项跑之前，不是「先把认识的那几项删了」
    await expect(access(join(logsDir(), 'app.log'))).resolves.toBeUndefined()
    await expect(access(settingsFile())).resolves.toBeUndefined()
  })

  it('什么都没勾时拒绝：空勾选不许被读成「全清」', async () => {
    const out = await clearLocalData([])
    expect([out.ok, out.freed, out.error]).toEqual([false, 0, '没有勾选任何要清理的项目'])
  })

  /**
   * 真渲染时点出来的（2026-11-27，隔离 user-data-dir 点「清空选中的 1 项」）：清完 logs 那档，
   * 目录整层没了，而 logger 的 mkdir 只在第一次写时跑（logger.ts:54 的 `initialized` 闸门），
   * 于是这一轮之后的每行日志都撞 ENOENT、只进 console——界面那句「删掉之后应用会重新写」是假的，
   * 丢的又是排查唯一依赖的东西。这条钉的是「壳留着」，而不是「文件删干净」——后者别处已断言。
   */
  it('清完把目录壳留着：删掉整层的话 logger 不会重建，之后的日志静默全丢', async () => {
    await put(join(logsDir(), 'app.log'), 2000)
    await put(join(logsDir(), 'app.1.log'), 1000)
    const out = await clearLocalData(['logs'])
    expect([out.ok, out.freed]).toEqual([true, 3000])
    await expect(access(logsDir())).resolves.toBeUndefined()
    await expect(access(join(logsDir(), 'app.log'))).rejects.toThrow()
    // 壳在，appendFile 就能把文件长回来（logger.ts:159）——这句是那句界面文案的真正含义
    await writeFile(join(logsDir(), 'app.log'), 'after')
    await expect(access(join(logsDir(), 'app.log'))).resolves.toBeUndefined()
  })

  it('正在配音：只拒片段缓存那一项，其余照删，被拒那项不进 freed', async () => {
    state.synthesis = true
    await put(join(ttsClipCacheDir(), 'aa.mp3'), 1000)
    await put(join(logsDir(), 'app.log'), 2000)
    await put(join(dictionaryDir(), 'dict.json'), 500)
    const out = await clearLocalData(['clips', 'logs', 'dictionary'])
    expect(out.cleared).toEqual(['logs', 'dictionary'])
    expect(out.failed.map((f) => f.id)).toEqual(['clips'])
    expect(out.failed[0].error).toContain('正在配音')
    expect(out.ok).toBe(false)
    expect(out.freed).toBe(2000 + 500)
    await expect(access(join(ttsClipCacheDir(), 'aa.mp3'))).resolves.toBeUndefined()
  })

  it('勾上「设置与 API Key」才动它：本体、.bak 与 corrupt 留档一起算一起删', async () => {
    await put(settingsFile(), 100)
    await put(`${settingsFile()}.bak`, 90)
    await put(join(userDataRoot(), 'settings.json.corrupt-2026-11-27T00-00-00'), 80)
    const a = await auditLocalData()
    expect(a.items.find((i) => i.id === 'settings')?.bytes).toBe(100 + 90 + 80)
    const out = await clearLocalData(['settings'])
    expect(out.cleared).toEqual(['settings'])
    expect(out.freed).toBe(100 + 90 + 80)
    await expect(access(settingsFile())).rejects.toThrow()
    await expect(access(join(userDataRoot(), 'settings.json.corrupt-2026-11-27T00-00-00'))).rejects.toThrow()
  })

  it('临时媒体：正在被会话占着的那一个跳过——清单不数它，清理也不删它', async () => {
    const busy = await mkdtemp(join(tmpdir(), state.mediaPrefix))
    const idle = await mkdtemp(join(tmpdir(), state.mediaPrefix))
    madeMedia.push(busy, idle)
    await put(join(busy, 'audio.wav'), 1000)
    await put(join(idle, 'audio.wav'), 700)
    state.activeMedia = [busy]
    const a = await auditLocalData()
    expect(a.items.find((i) => i.id === 'media')?.bytes).toBe(700)
    const out = await clearLocalData(['media'])
    expect([out.cleared, out.freed]).toEqual([['media'], 700])
    await expect(access(join(busy, 'audio.wav'))).resolves.toBeUndefined()
    await expect(access(join(idle, 'audio.wav'))).rejects.toThrow()
  })
})

describe('按需组件那一项：并集不许算两次（#439 的下游）', () => {
  it('freed 是清完再量的差值；outsideOnly 那句拒绝是说明不是故障', async () => {
    state.engineRunning = true
    const recordBytes = 40
    await put(userDataPath('components', 'installed.json'), recordBytes)
    state.rows = [
      { id: 'tts-model-kokoro', title: '本地配音模型 Kokoro', bytes: 1000, installed: true },
      { id: 'asr-model-small', title: '本地转写模型（small）', bytes: 2_000_000, installed: true, outsideOnly: true },
    ]
    const out = await clearLocalData(['components'])
    expect(out.cleared).toEqual(['components'])
    expect(out.failed).toEqual([])
    // 相加会得到 1000+2_000_000+recordBytes，而那 2MB 其实一秒都没离开磁盘
    expect(out.freed).toBe(1000 + recordBytes)
    expect(out.note).toContain('本地转写引擎还在跑')
    expect(state.removed).toEqual(['tts-model-kokoro'])
  })

  it('一行真被占住：原话点名那一行，其余照删，被占那行自然不进 freed', async () => {
    state.engineRunning = true
    state.rows = [
      { id: 'tts-engine', title: '本地配音引擎', bytes: 1000, installed: true, busy: '本地配音引擎正在运行，先停它再删除' },
      { id: 'tts-model-kokoro', title: '本地配音模型 Kokoro', bytes: 700, installed: true },
    ]
    const out = await clearLocalData(['components'])
    expect(out.ok).toBe(false)
    expect(out.failed.map((f) => f.id)).toEqual(['components'])
    expect(out.failed[0].error).toContain('本地配音引擎正在运行')
    expect(state.removed).toEqual(['tts-model-kokoro'])
    expect(out.freed).toBe(700)
  })

  it('引擎还在跑：整棵 HF 缓存不碰，勾了组件也删不到它', async () => {
    state.engineRunning = true
    const repo = asrEngineRepoDirs()[1]
    await put(join(repo, 'snapshots', 'deadbeef', 'model.bin'), 1200)
    state.rows = [{ id: 'asr-model-small', title: '本地转写模型（small）', bytes: 1200, installed: true, outsideOnly: true }]
    const out = await clearLocalData(['components'])
    expect(out.failed).toEqual([])
    expect(out.note).toContain('停引擎后再清一次')
    await expect(access(join(repo, 'snapshots', 'deadbeef', 'model.bin'))).resolves.toBeUndefined()
  })

  it('共享 blob 只回收「行行都点名我们那两档」的那枚：混进别家仓库或没有 .refs 一律留下并报剩余 MB', async () => {
    const blobA = join(hub, 'blobs', 'aa', 'a'.repeat(64))
    const blobB = join(hub, 'blobs', 'bb', 'b'.repeat(64))
    const blobC = join(hub, 'blobs', 'cc', 'c'.repeat(64))
    await put(blobA, 3_000_000)
    await put(blobB, 2_500_000)
    await put(blobC, 1_000_000)
    await writeFile(`${blobA}.refs`, `models--Systran--faster-whisper-small/blobs/${'a'.repeat(64)}\n`, 'utf-8')
    await writeFile(
      `${blobB}.refs`,
      `models--Systran--faster-whisper-small/blobs/${'b'.repeat(64)}\nmodels--csukuangfj--sherpa-onnx-paraformer-zh/blobs/${'b'.repeat(64)}\n`,
      'utf-8'
    )
    // 三枚都要从快照软链解析得出来，否则它们根本进不了回收那一圈——那样这三条分支就是没测
    // （住在自己 blobs 层的那些随整目录删掉，不是这一层要证的）
    const small = asrEngineRepoDirs()[1]
    const base = asrEngineRepoDirs()[0]
    const smallSnap = join(small, 'snapshots', 'deadbeef')
    const baseSnap = join(base, 'snapshots', 'cafebabe')
    await mkdir(smallSnap, { recursive: true })
    await mkdir(baseSnap, { recursive: true })
    await symlink(blobA, join(smallSnap, 'model.bin'))
    await symlink(blobB, join(smallSnap, 'vocabulary.txt'))
    await symlink(blobC, join(baseSnap, 'model.bin'))
    await put(join(smallSnap, 'config.json'), 20)
    // 本机此刻真就站着别家的模型（三份 sherpa 配音模型），它们那一棵树必须整棵活着
    await put(join(hub, 'models--csukuangfj--sherpa-onnx-paraformer-zh', 'model.bin'), 500)
    state.rows = [
      { id: 'asr-model-small', title: '本地转写模型（small）', bytes: 3_000_000, installed: true, outsideOnly: true },
    ]

    const out = await clearLocalData(['components'])
    expect(out.cleared).toEqual(['components'])
    // 回收掉的 3MB 只落日志：freed 由「清完再量」统算，两笔各加一遍就是虚账
    expect(out.freed).toBe(0)
    await expect(access(blobA)).rejects.toThrow()
    await expect(access(`${blobA}.refs`)).rejects.toThrow()
    await expect(access(blobB)).resolves.toBeUndefined()
    await expect(access(blobC)).resolves.toBeUndefined()
    // 留下的那两枚要报出来（2.5MB + 1.0MB），否则用户以为清干净了；数出自 formatBytes 那一把尺
    expect(out.note).toContain('3.5MB')
    // 两档的仓库目录整个清掉，但 hub 这一层不是我们的：别家那三份配音模型一根手指都不许碰
    await expect(access(small)).rejects.toThrow()
    await expect(access(base)).rejects.toThrow()
    await expect(access(join(hub, 'models--csukuangfj--sherpa-onnx-paraformer-zh', 'model.bin'))).resolves.toBeUndefined()
  })
})
