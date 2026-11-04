/**
 * 历史记录这一层的契约（#247 第①步）。
 * 测的不是「函数返回什么」，而是四条以后很容易被人顺手改掉的口径：
 * - 记账**只落元信息**，正文一刻都不在盘上（「全文按需」这条承诺的全部内容）
 * - 留住的副本必须落在 records/keep 下面，也绝不能把路径报给界面
 * - 读不出来的账本不许被盖掉，也不许演成「你还没跑过作业」（#277 那个丢 Key 的坑换一份文件就会重长一次）
 * - 修剪只动「什么都没留住」的行——自动删掉用户点名要留的文件不是卫生，是事故
 */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryItem } from '../electron/main/services/historyService'

type History = typeof import('../electron/main/services/historyService')

let dir = ''
let history: History
/** 用例里造的「临时目录产物」，跑完自己收掉，别在 /tmp 底下堆 transcribe- 目录 */
let temps: string[] = []

const recordsDir = () => join(dir, 'records')
const docFile = () => join(recordsDir(), 'history.json')

/** 一份干净的 userData + 全新模块：cache / writeBlocked 都是模块级状态，不重灌会串味 */
async function resetInto(): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  dir = await mkdtemp(join(tmpdir(), 'vv-history-'))
  temps = []
  vi.resetModules()
  vi.spyOn(app, 'getPath').mockImplementation(
    ((name: string) => (name === 'userData' ? dir : join(dir, name))) as typeof app.getPath
  )
  history = await import('../electron/main/services/historyService')
}

const noProfiles = () => ({ asr: null, ai: null, tts: null })

/**
 * 大多数用例只要列表那一份内容。「拿不到」这一格在这里直接红：
 * 它意味着这本账我们读不动，而用例接下来断言的「几条／什么顺序」都是没根据的。
 */
async function listed(): Promise<HistoryItem[]> {
  const res = await history.listHistory()
  expect(res.error).toBeNull()
  return res.items ?? []
}

async function doc(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(docFile(), 'utf-8')) as Record<string, unknown>
}

/** records 这一层下面有哪些名字（含子目录名）：用来证「没写正文」「没留空壳」 */
async function names(): Promise<string[]> {
  try {
    return (await readdir(recordsDir())).sort()
  } catch {
    return []
  }
}

async function keepNames(id: string): Promise<string[]> {
  try {
    return (await readdir(join(recordsDir(), 'keep', id))).sort()
  } catch {
    return []
  }
}

/** 假装那是配音轨：落在 `transcribe-` 前缀的临时目录里，正是 24 小时清扫的靶子 */
async function tempProduct(name = 'voice-track.mp3', content = 'mp3-bytes'): Promise<string> {
  const temp = await mkdtemp(join(tmpdir(), 'transcribe-tts-'))
  temps.push(temp)
  const file = join(temp, name)
  await writeFile(file, content)
  return file
}

/** 直接把一本账写到盘上，比跑两百次记账快得多（上限那条用例需要） */
async function seedDoc(rows: unknown[]): Promise<void> {
  await mkdir(recordsDir(), { recursive: true })
  await writeFile(docFile(), JSON.stringify({ schemaVersion: 1, records: rows }))
}

function row(id: string, kept: { product: string | null; draft: string | null } = { product: null, draft: null }) {
  return {
    id,
    at: '2026-11-04T00:00:00.000Z',
    name: `${id}.mp4`,
    profiles: { asr: null, ai: null, tts: null },
    detail: { kind: 'transcribe', provider: 'local', model: 'base', language: 'zh', segments: 1, durationSec: null, elapsedMs: null },
    source: null,
    kept,
  }
}

const transcribeDetail = {
  kind: 'transcribe' as const,
  provider: 'local',
  model: 'base',
  language: 'zh',
  segments: 12,
  durationSec: 61.5,
  elapsedMs: 64_000,
}

const voiceDetail = {
  kind: 'voice' as const,
  engine: 'local',
  model: 'vits-zh-ll',
  voice: '2',
  speed: 1,
  clips: 12,
  queueTotal: 12,
  trackBytes: 24_438_304,
  trackDuration: 58.2,
  pushedCount: 3,
}

const downloadDetail = {
  kind: 'download' as const,
  mediaKind: 'video',
  durationSec: 541.72,
  height: 640,
  sizeBytes: 35_487_236,
}

async function add(input: Parameters<History['addHistoryRecord']>[0]): Promise<boolean> {
  return history.addHistoryRecord(input)
}

beforeEach(async () => {
  await resetInto()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  for (const temp of temps) await rm(temp, { recursive: true, force: true })
})

describe('记账：只落元信息', () => {
  it('记一条转写，磁盘上是带 schemaVersion 的一份账本', async () => {
    const ok = await add({
      id: 'job-1',
      at: '2026-11-04T01:00:00.000Z',
      name: '采访第3期.mp4',
      profiles: { asr: 'asr-a', ai: null, tts: null },
      detail: transcribeDetail,
    })
    expect(ok).toBe(true)

    const disk = await doc()
    expect(disk.schemaVersion).toBe(history.HISTORY_SCHEMA_VERSION)
    expect((disk.records as unknown[]).length).toBe(1)

    const items = await listed()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'job-1',
      kind: 'transcribe',
      name: '采访第3期.mp4',
      keptProduct: false,
      keptDraft: false,
      // 转写这一类没有产物，「能不能留住」不能报成 true
      productAvailable: false,
      profiles: { asr: 'asr-a', ai: null, tts: null },
    })
  })

  it('records 下面除了一本账什么都没有——正文不进盘，路径也不出主进程', async () => {
    const product = await tempProduct()
    await add({ id: 'job-2', name: '稿子.txt', profiles: noProfiles(), detail: voiceDetail, source: product })

    expect(await names()).toEqual(['history.json'])
    // 界面向记录要 id，不拿路径：这一列一旦带上 filePath，渲染层就会开始拼自己的写盘位置
    const items = await listed()
    expect(JSON.stringify(items)).not.toContain(product)
  })

  it('下载那一类不读任何设置，三个方案 id 全空也算记成', async () => {
    const product = await tempProduct('采访.mp4', 'video-bytes')
    await add({ id: 'dl-1', name: '采访第3期.mp4', profiles: noProfiles(), detail: downloadDetail, source: product })
    const [item] = await listed()
    expect(item.profiles).toEqual({ asr: null, ai: null, tts: null })
    expect(item.kind).toBe('download')
  })

  it('同一个作业 id 再记一次算更新，账本里只留一行', async () => {
    await add({ id: 'job-3', at: '2026-11-04T01:00:00.000Z', name: 'a.mp4', profiles: noProfiles(), detail: transcribeDetail })
    await add({
      id: 'job-3',
      at: '2026-11-04T02:00:00.000Z',
      name: 'a.mp4',
      profiles: noProfiles(),
      detail: { ...transcribeDetail, segments: 30 },
    })
    const items = await listed()
    expect(items).toHaveLength(1)
    expect((items[0].detail as { segments: number }).segments).toBe(30)
  })

  it('同一个 id 再记一次，上一行留住的副本要照搬过来', async () => {
    // 勾是用户点的名，引用一掉 keep/<id>/ 下面就只剩一份没人认领的东西，
    // 界面上还显示成「没留住」——用户以为是自己取消的
    const product = await tempProduct()
    await add({ id: 'job-keep2', name: '配音轨.mp3', profiles: noProfiles(), detail: voiceDetail, source: product })
    await history.keepHistory('job-keep2')

    await add({
      id: 'job-keep2',
      at: '2026-11-04T03:00:00.000Z',
      name: '配音轨.mp3',
      profiles: noProfiles(),
      detail: { ...voiceDetail, clips: 20, queueTotal: 20 },
    })

    const items = await listed()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ keptProduct: true, productAvailable: true })
    expect(await keepNames('job-keep2')).toEqual(['voice-track.mp3'])
    // 搬的是那两份引用，不是整行照抄：这一行讲的还是「最新那一次跑成什么样」
    expect((items[0].detail as { clips: number }).clips).toBe(20)
  })

  it('时间倒序：刚跑完那条排在界面第一行', async () => {
    for (const at of ['2026-11-01T00:00:00.000Z', '2026-11-03T00:00:00.000Z', '2026-11-02T00:00:00.000Z']) {
      await add({ at, name: `${at}.mp4`, profiles: noProfiles(), detail: transcribeDetail })
    }
    const items = await listed()
    expect(items.map((item) => item.at)).toEqual([
      '2026-11-03T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
    ])
  })
})

describe('留住（勾了才留）', () => {
  it('留住产物：副本落进 records/keep/<id>/，文件名跟原件走', async () => {
    const product = await tempProduct()
    await add({ id: 'job-keep', name: '配音轨.mp3', profiles: noProfiles(), detail: voiceDetail, source: product })
    expect((await history.keepHistory('job-keep')).ok).toBe(true)

    expect(await keepNames('job-keep')).toEqual(['voice-track.mp3'])
    const [item] = await listed()
    expect(item).toMatchObject({ keptProduct: true, productAvailable: true })
  })

  it('一次勾把产物和稿子一起留下', async () => {
    const product = await tempProduct()
    await add({ id: 'job-both', name: '配音轨.mp3', profiles: noProfiles(), detail: voiceDetail, source: product })
    expect((await history.keepHistory('job-both', '第一期采访稿\n第二行')).ok).toBe(true)

    expect(await keepNames('job-both')).toEqual(['draft.txt', 'voice-track.mp3'])
    const [item] = await listed()
    expect(item).toMatchObject({ keptProduct: true, keptDraft: true })
    // 正文只在这一刻过桥，落盘之后它就是 keep/<id>/draft.txt 这一份，账本里仍然只有那两个文件名
    expect(await readFile(join(recordsDir(), 'keep', 'job-both', 'draft.txt'), 'utf-8')).toContain('第二行')
  })

  it('原件已经被 24 小时清扫收走：报「只能重跑」，并且一个文件都不留', async () => {
    const product = await tempProduct()
    await add({ id: 'job-gone', name: '配音轨.mp3', profiles: noProfiles(), detail: voiceDetail, source: product })
    await rm(join(product, '..'), { recursive: true, force: true })

    const res = await history.keepHistory('job-gone')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('只能重跑')
    expect(await names()).toEqual(['history.json'])
  })

  it('转写那一类没有产物，但只要交来正文就留得住稿子', async () => {
    await add({ id: 'job-txt', name: 'a.mp4', profiles: noProfiles(), detail: transcribeDetail })
    // 只要产物、没有正文：那得是一句实话，而不是「已留住」
    const nothing = await history.keepHistory('job-txt')
    expect(nothing.ok).toBe(false)
    expect(nothing.error).toContain('没有可以留住的东西')

    expect((await history.keepHistory('job-txt', '第一期\n第二行')).ok).toBe(true)
    expect(await keepNames('job-txt')).toEqual(['draft.txt'])
  })

  it('空稿子留不下任何东西——留一个空文件比不留更让人误解', async () => {
    await add({ id: 'job-blank', name: 'a.mp4', profiles: noProfiles(), detail: transcribeDetail })
    expect((await history.keepHistory('job-blank', '   \n  ')).ok).toBe(false)
    expect(await names()).toEqual(['history.json'])
  })

  it('原件没了但稿子留得住：这一半要落盘，那一句原因也要说', async () => {
    const product = await tempProduct()
    await add({ id: 'job-half', name: '配音轨.mp3', profiles: noProfiles(), detail: voiceDetail, source: product })
    await rm(join(product, '..'), { recursive: true, force: true })

    const res = await history.keepHistory('job-half', '改过的稿子')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('只能重跑')
    // 已经拿到手的那一半不因另一半没跟上而丢掉：界面重读列表时那一勾是亮的
    expect(await keepNames('job-half')).toEqual(['draft.txt'])
    const [item] = await listed()
    expect(item).toMatchObject({ keptDraft: true, keptProduct: false })
  })

  it('已经留过的产物不搬第二次：再勾一次只补稿子', async () => {
    const product = await tempProduct()
    await add({ id: 'job-twice', name: '配音轨.mp3', profiles: noProfiles(), detail: voiceDetail, source: product })
    await history.keepHistory('job-twice')
    // 原件这时候被清掉了；上一行的副本还在，第二次勾不该因为它报一句「原件没了」
    await rm(join(product, '..'), { recursive: true, force: true })

    expect((await history.keepHistory('job-twice', '稿子')).ok).toBe(true)
    expect(await keepNames('job-twice')).toEqual(['draft.txt', 'voice-track.mp3'])
  })

  it('反悔：副本删干净、记录本身还在', async () => {
    const product = await tempProduct()
    await add({ id: 'job-drop', name: '配音轨.mp3', profiles: noProfiles(), detail: voiceDetail, source: product })
    await history.keepHistory('job-drop', '稿子')

    expect((await history.dropHistoryCopies('job-drop')).ok).toBe(true)
    // keep/<id> 整层收掉，不在 records/keep 下面留一堆空壳
    expect(await readdir(join(recordsDir(), 'keep'))).toEqual([])
    const items = await listed()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ keptProduct: false, keptDraft: false })
  })

  it('单条删除连留住的文件一起没——只摘一行会把音轨晾在盘上没人认领', async () => {
    const product = await tempProduct()
    await add({ id: 'job-del', name: '配音轨.mp3', profiles: noProfiles(), detail: voiceDetail, source: product })
    await history.keepHistory('job-del')

    expect((await history.deleteHistoryRecord('job-del')).ok).toBe(true)
    // keep 那一层下面不再有任何一条的目录（空的一层本身留着，它不是用户的文件）
    expect(await readdir(join(recordsDir(), 'keep'))).toEqual([])
    expect(await listed()).toEqual([])
  })

  it('Windows 那套非法字符洗得掉，同一本账在两台机器上拼得出同一个路径', async () => {
    const odd = await tempProduct('采访:第3期?最终版.mp3', 'bytes')
    await add({ id: 'job-odd', name: odd, profiles: noProfiles(), detail: voiceDetail, source: odd })

    expect((await history.keepHistory('job-odd')).ok).toBe(true)
    expect(await keepNames('job-odd')).toEqual(['采访_第3期_最终版.mp3'])
  })

  it('id 被手改成路径穿越的形状，也不许写出 records/keep 以外', async () => {
    const product = await tempProduct()
    await add({ id: '../../escape', name: '配音轨.mp3', profiles: noProfiles(), detail: voiceDetail, source: product })

    expect((await history.keepHistory('../../escape')).ok).toBe(true)
    expect(await readdir(join(recordsDir(), 'keep'))).toEqual(['.._.._escape'])
  })
})

describe('「在文件夹里显示」解路径', () => {
  it('留住的产物解得出位置，它就落在 records/keep 这一层下面', async () => {
    const product = await tempProduct()
    await add({ id: 'job-show', name: '配音轨.mp3', profiles: noProfiles(), detail: voiceDetail, source: product })
    await history.keepHistory('job-show')

    const res = await history.resolveHistoryKeptFile('job-show')
    expect(res.error).toBeNull()
    expect(res.path).toBe(join(recordsDir(), 'keep', 'job-show', 'voice-track.mp3'))
  })

  it('只留了稿子时显示的是 draft.txt——那份用户点名要留的东西同样得有入口', async () => {
    await add({ id: 'job-only-draft', name: 'a.mp4', profiles: noProfiles(), detail: transcribeDetail })
    await history.keepHistory('job-only-draft', '采访稿正文')

    const res = await history.resolveHistoryKeptFile('job-only-draft')
    expect(res.path).toBe(join(recordsDir(), 'keep', 'job-only-draft', 'draft.txt'))
  })

  it('没勾过那一颗：说的是「还没有留住的副本」，而不是给一个空路径让人猜', async () => {
    const product = await tempProduct()
    await add({ id: 'job-never', name: '配音轨.mp3', profiles: noProfiles(), detail: voiceDetail, source: product })

    const res = await history.resolveHistoryKeptFile('job-never')
    expect(res.path).toBeNull()
    expect(res.error).toContain('没有留住的副本')
  })

  it('副本在我们之外被人删掉：说「已经不在盘上」，不许回一份点了没反应的路径', async () => {
    const product = await tempProduct()
    await add({ id: 'job-gone2', name: '配音轨.mp3', profiles: noProfiles(), detail: voiceDetail, source: product })
    await history.keepHistory('job-gone2')
    await rm(join(recordsDir(), 'keep', 'job-gone2'), { recursive: true, force: true })

    const res = await history.resolveHistoryKeptFile('job-gone2')
    expect(res.path).toBeNull()
    expect(res.error).toContain('不在盘上')
  })

  it('账本里没有这一条：那句实话要跟「没留住」分得开——界面给的动作完全不同', async () => {
    const res = await history.resolveHistoryKeptFile('no-such-job')
    expect(res.path).toBeNull()
    expect(res.error).toContain('已经不在了')
  })
})

describe('上限与修剪', () => {
  it('超上限从记账顺序的尾部剪到上限为止', async () => {
    // 账本顺序＝记账顺序（新记录永远插在头上），所以尾部就是最老的那一笔
    await seedDoc(
      Array.from({ length: history.MAX_RECORDS + 3 }, (_unused, i) => row(`job-${i}`)).map((r, i) => ({
        ...r,
        at: `2026-11-04T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      }))
    )
    await add({ id: 'fresh', name: 'new.mp4', profiles: noProfiles(), detail: transcribeDetail })

    const items = await listed()
    expect(items.length).toBe(history.MAX_RECORDS)
    expect(items.some((item) => item.id === 'fresh')).toBe(true)
    expect(items.some((item) => item.id === 'job-0')).toBe(true)
    expect(items.some((item) => item.id === `job-${history.MAX_RECORDS + 2}`)).toBe(false)
  })

  it('留住了东西的行不参与修剪，哪怕账本已经超上限', async () => {
    const keptRows = Array.from({ length: history.MAX_RECORDS + 2 }, (_unused, i) =>
      row(`job-${i}`, { product: null, draft: 'draft.txt' })
    )
    await seedDoc(keptRows)
    await add({ id: 'fresh', name: 'new.mp4', profiles: noProfiles(), detail: transcribeDetail })

    // 一条都没剪：自动删掉用户点名要留的文件，比账本长一点严重得多
    const items = await listed()
    expect(items.length).toBe(history.MAX_RECORDS + 3)
    expect(items.filter((item) => item.keptDraft).length).toBe(history.MAX_RECORDS + 2)
  })

  it('看不懂的行既不显示也不剪：我们不认识它，就不知道它有没有带着什么', async () => {
    const junk = Array.from({ length: history.MAX_RECORDS + 2 }, (_unused, i) => ({ fromFuture: i }))
    await seedDoc(junk)
    await add({ id: 'fresh', name: 'new.mp4', profiles: noProfiles(), detail: transcribeDetail })

    expect(await listed()).toHaveLength(1)
    expect(((await doc()).records as unknown[]).length).toBe(history.MAX_RECORDS + 3)
  })
})

describe('坏盘：读不出来不等于可以盖', () => {
  it('半截 JSON：改名留档再从空账本继续，那份坏的还在同一个目录里', async () => {
    await mkdir(recordsDir(), { recursive: true })
    await writeFile(docFile(), '{"schemaVersion":1,"records":[{"id"')
    expect(await listed()).toEqual([])

    await add({ id: 'after-corrupt', name: 'a.mp4', profiles: noProfiles(), detail: transcribeDetail })
    expect(((await doc()).records as unknown[]).length).toBe(1)
    expect((await names()).some((name) => name.startsWith('history.json.corrupt-'))).toBe(true)
  })

  it('连内容都拿不到（它是个目录）：写盘拦住，不去盖那个位置', async () => {
    await mkdir(recordsDir(), { recursive: true })
    await mkdir(docFile())
    expect(await add({ name: 'a.mp4', profiles: noProfiles(), detail: transcribeDetail })).toBe(false)

    const info = await stat(docFile())
    expect(info.isDirectory()).toBe(true)
    // 这一格必须是 null 而不是 []：[] 在界面上长成「你还没跑过作业」，
    // 那是把「我们读不动」演成「用户什么都没做过」——和 #277 里那句「用户还没填 Key」同一个形状
    const res = await history.listHistory()
    expect(res.items).toBeNull()
    expect(res.error).toContain('读不出来')
  })

  it('比这一版新的账本：不改名、不改写', async () => {
    const newer = history.HISTORY_SCHEMA_VERSION + 3
    await mkdir(recordsDir(), { recursive: true })
    await writeFile(docFile(), JSON.stringify({ schemaVersion: newer, records: [{ id: 'x' }] }))

    expect(await add({ name: 'a.mp4', profiles: noProfiles(), detail: transcribeDetail })).toBe(false)
    expect(await readFile(docFile(), 'utf-8')).toContain(`"schemaVersion":${newer}`)
    expect(await names()).toEqual(['history.json'])
  })

  it('解得开但 records 不是列表：那本账改名留档，别当成空账本写回去', async () => {
    await mkdir(recordsDir(), { recursive: true })
    await writeFile(docFile(), JSON.stringify({ schemaVersion: 1, records: 'not-a-list' }))
    expect(await add({ id: 'mine', name: 'a.mp4', profiles: noProfiles(), detail: transcribeDetail })).toBe(true)

    expect(((await doc()).records as unknown[]).map((r) => (r as { id: string }).id)).toEqual(['mine'])
    expect((await names()).some((name) => name.startsWith('history.json.corrupt-'))).toBe(true)
  })

  it('第一次用时那本账还不存在：这不是故障，不弹错也不留改名副本', async () => {
    const res = await history.listHistory()
    expect(res.items).toEqual([])
    expect(res.error).toBeNull()
    expect(await names()).toEqual([])
  })
})
