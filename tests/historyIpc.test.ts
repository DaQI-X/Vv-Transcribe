/**
 * 历史记录五条通道的接线判据（#247 第③步）
 *
 * 这里测的不是 service（那份在 historyService.test.ts 里），是「界面能不能靠这几条通道办事」：
 * - **注册上了没有**：preload 的 invoke 回 Promise<any>，方法名打错一个字母、或者那个
 *   register 函数忘了进 registerAllHandlers，tsc 一声不响，界面表现是「点了那颗按钮没反应」。
 * - **读不出来时必须回 items:null**：折成 [] 就等于界面替用户记不起他跑过什么（#277 那个坑的门面版）。
 * - **非字符串的 id 不许被拿去账本里找**：那只会回一句「这条记录已经不在了」，把编程错误说成用户的错。
 * - **正文只在那一刻过桥**：跨 IPC 的稿子只落进 records/keep/，日志里只留字符数
 *   （#281 那条口径在这道门上再守一遍）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryDetail, HistoryItem } from '../electron/main/services/historyService'

const logCalls = vi.hoisted(() => vi.fn())

vi.mock('../electron/main/services/logger', () => ({
  logger: {
    error: logCalls,
    warn: logCalls,
    info: logCalls,
    debug: logCalls,
    userAction: logCalls,
    serviceError: logCalls,
  },
}))

type HistoryService = typeof import('../electron/main/services/historyService')

/** 各通道自己的返回形状：这里只取测试要断言的那几格 */
interface Reply {
  ok?: boolean
  success?: boolean
  error?: string | null
  items?: HistoryItem[] | null
}

type Wrapper = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>

let dir = ''
let channels: Map<string, Wrapper>
let service: HistoryService

const event = {} as IpcMainInvokeEvent

async function call(channel: string, ...args: unknown[]): Promise<Reply> {
  const wrapper = channels.get(channel)
  if (!wrapper) throw new Error(`通道 ${channel} 没注册，测试前提就不成立`)
  return (await wrapper(event, ...args)) as Reply
}

/** 一份干净的 userData + 全新模块：service 的 cache / writeBlocked 是模块级状态，不重灌会串味 */
async function freshImports(): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  dir = await mkdtemp(join(tmpdir(), 'vv-history-ipc-'))
  channels = new Map()
  logCalls.mockClear()
  vi.resetModules()
  vi.spyOn(ipcMain, 'handle').mockImplementation(((channel: string, fn: Wrapper) => {
    channels.set(channel, fn)
  }) as never)
  vi.spyOn(app, 'getPath').mockImplementation(
    ((name: string) => (name === 'userData' ? dir : join(dir, name))) as typeof app.getPath
  )
  service = await import('../electron/main/services/historyService')
  const { registerHistoryHandlers } = await import('../electron/main/ipc/historyHandlers')
  registerHistoryHandlers()
}

const voiceDetail = {
  kind: 'voice' as const,
  engine: 'local',
  model: 'vits-zh-ll',
  voice: '2',
  speed: 1,
  clips: 12,
  queueTotal: 12,
  trackBytes: 1024,
  trackDuration: 58.2,
  pushedCount: 0,
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

/** 假装那是配音轨：产物在主进程这边的临时目录里，界面永远拿不到这个路径 */
async function tempProduct(): Promise<string> {
  const temp = await mkdtemp(join(tmpdir(), 'transcribe-tts-'))
  const file = join(temp, 'voice-track.mp3')
  await writeFile(file, 'mp3-bytes')
  return file
}

async function record(
  id: string,
  source: string | null,
  detail: HistoryDetail = voiceDetail
): Promise<void> {
  await service.addHistoryRecord({
    id,
    name: source === null ? 'a.mp4' : '配音轨.mp3',
    profiles: { asr: null, ai: null, tts: null },
    detail,
    source,
  })
}

beforeEach(async () => {
  await freshImports()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('通道注册', () => {
  it('五条通道都在：register 函数真的把每一条交给了 ipcMain', () => {
    for (const channel of [
      'history:list',
      'history:keep',
      'history:dropCopies',
      'history:delete',
      'history:reveal',
    ]) {
      expect(channels.has(channel), `${channel} 没注册`).toBe(true)
    }
    expect(channels.size).toBe(5)
  })

  it('走一遍：记一条 → 留住 → 列表 → 显示 → 删除，界面拿到的形状一路都对', async () => {
    const product = await tempProduct()
    await service.addHistoryRecord({
      id: 'job-ipc',
      name: '配音轨.mp3',
      profiles: { asr: null, ai: null, tts: 'tts-1' },
      detail: voiceDetail,
      source: product,
    })

    expect(await call('history:keep', 'job-ipc', '第一期采访稿')).toMatchObject({ ok: true })

    const list = await call('history:list')
    expect(list.error).toBeNull()
    expect(list.items).toHaveLength(1)
    expect(list.items?.[0]).toMatchObject({ keptProduct: true, keptDraft: true, profiles: { tts: 'tts-1' } })
    // 路径一个字都没跨过来：原件位置、records 目录都不在返回值里
    expect(JSON.stringify(list)).not.toContain(product)
    expect(JSON.stringify(list)).not.toContain(join(dir, 'records'))
    // 正文也不在列表里：界面要吃稿子得用自己手上那份，账本这边只报「留住了」
    expect(JSON.stringify(list)).not.toContain('第一期采访稿')

    expect(await call('history:reveal', 'job-ipc')).toMatchObject({ success: true, error: null })
    expect(await call('history:delete', 'job-ipc')).toMatchObject({ ok: true })
    expect((await call('history:list')).items).toEqual([])
  })
})

describe('列表不许把「读不出来」演成「没跑过作业」', () => {
  it('账本拿不到时 items 是 null，配一句能弹的话', async () => {
    // 账本的位置被一个目录占了：内容拿不到，连改名留档都做不到
    await mkdir(join(dir, 'records'), { recursive: true })
    await mkdir(join(dir, 'records', 'history.json'))

    const res = await call('history:list')
    expect(res.items).toBeNull()
    expect(res.error).toContain('读不出来')
  })

  it('一条都没记过时是 []，而且没有 error——这是状态，不是故障', async () => {
    const res = await call('history:list')
    expect(res.items).toEqual([])
    expect(res.error).toBeNull()
  })
})

describe('参数收口', () => {
  it('id 不是字符串时不去账本里找，也不动盘', async () => {
    for (const bad of [undefined, null, 42, { id: 'job-ipc' }]) {
      expect(await call('history:keep', bad)).toEqual({ ok: false, error: '记录 id 必须是字符串' })
      expect(await call('history:delete', bad)).toEqual({ ok: false, error: '记录 id 必须是字符串' })
      expect(await call('history:reveal', bad)).toEqual({ success: false, error: '记录 id 必须是字符串' })
    }
    // 一次写入都没发生：连账本文件都没被创建出来
    expect((await call('history:list')).items).toEqual([])
    await expect(readFile(join(dir, 'records', 'history.json'), 'utf-8')).rejects.toThrow()
  })

  it('keep 的第二参数不是字符串就当「只留产物」——界面少给一份正文不该炸', async () => {
    const product = await tempProduct()
    await record('job-nobody', product)

    expect(await call('history:keep', 'job-nobody', undefined)).toMatchObject({ ok: true })
    expect((await call('history:list')).items?.[0]).toMatchObject({ keptProduct: true, keptDraft: false })
  })

  it('账本里没有这个 id 时说的是「已经不在了」，跟「没留住副本」分得开', async () => {
    expect(await call('history:keep', 'nope')).toEqual({ ok: false, error: '这条记录已经不在了' })
    expect(await call('history:delete', 'nope')).toEqual({ ok: false, error: '这条记录已经不在了' })
    expect(await call('history:reveal', 'nope')).toEqual({ success: false, error: '这条记录已经不在了' })

    await record('job-no-keep', null)
    expect(await call('history:reveal', 'job-no-keep')).toEqual({
      success: false,
      error: '这一条还没有留住的副本',
    })
  })
})

describe('正文不过日志', () => {
  it('「留住」交来的整份稿子只过一次桥，日志里只留字符数', async () => {
    // 转写那一类没有产物，能留的只有交来的这一份正文
    await record('job-text', null, transcribeDetail)
    const draft = '嘉宾：张三，手机 13800000000。这一段是采访稿正文。'

    expect((await call('history:keep', 'job-text', draft)).ok).toBe(true)
    const logged = JSON.stringify(logCalls.mock.calls)
    expect(logged).not.toContain('张三')
    expect(logged).not.toContain('13800000000')
    expect(logged).not.toContain('采访稿正文')
    // 盘上这一份确实在：「没进日志」不等于「没留住」
    await expect(readFile(join(dir, 'records', 'keep', 'job-text', 'draft.txt'), 'utf-8')).resolves.toContain(
      '采访稿正文'
    )
  })
})
