/**
 * #407 组件按需下载的候选源：自家 Release 取不动时换 hf-mirror 那份逐字节副本。
 *
 * 这里钉的是三件事，它们错了都不崩、只会静默变慢或变危险：
 * 1. 顺序与参数——镜像那条必须带 `?download=true`（不带它拿到的是 HTML 提示页，#406 踩过），
 *    且 GitHub 排第一（发版源优先，第三方副本只是出路）；
 * 2. 换源真的会发生——第一棒失败要继续试第二棒，而不是把第一棒的错直接抛给用户；
 * 3. 换 host 不换闸门——落地前比的始终是清单钉死的 SHA2-256，镜像给一份「别的内容」必须被拒；
 * 4. 换源阈值——第一棒慢到照这个速度取不完要换源，最后一棒不许中途被换掉（换无可换只能等）；
 * 5. 换源不许把人留在原地——第二腿空着（镜像没同步过那个 tag）时，第一腿要能兜回来慢慢跑完。
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as realSleep } from 'node:timers/promises'
import { net } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EARLY_BUDGET,
  LAST_BUDGET,
  assetUrls,
  downloadToPart,
  stallReason,
} from '../electron/main/services/componentService'

type EntryArg = Parameters<typeof downloadToPart>[2]
type TaskArg = Parameters<typeof downloadToPart>[3]
type SpecArg = Parameters<typeof downloadToPart>[4]

const GITHUB = 'github.com'
const MIRROR = 'hf-mirror.com'

/** downloadToPart 只用到 spec.id（进度条归哪个组件），所以这里不搭整份 SPECS */
const spec = { id: 'vv-tts-server' } as unknown as SpecArg

function entryFor(payload: Buffer, sha256?: string): EntryArg {
  return {
    version: '1.2.2',
    tag: 'v1.2.2',
    asset: 'vv-tts-server-darwin-arm64-1.2.2',
    sha256: sha256 ?? createHash('sha256').update(payload).digest('hex'),
    bytes: payload.length,
    extractedBytes: null,
    fileCount: null,
  }
}

function newTask(): TaskArg {
  return { controller: new AbortController(), reason: '', watchers: [] }
}

/** 把一段字节装成 net.fetch 的那条响应：只需要 ok / status / body.getReader */
function responseOf(bytes: Uint8Array, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    body: {
      getReader: () => {
        let sent = false
        return {
          read: async () =>
            sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes }),
        }
      },
    },
  } as unknown as Awaited<ReturnType<typeof net.fetch>>
}

/**
 * 永远不结束的响应体：用来演「连上了但字节不来」那一种国内直连形态。
 * abort 时让 read 拒绝，这是真实 body stream 的语义——不这么写的话这一棒会永远挂着，
 * 测出来的是假造的桩不够真，而不是换源逻辑有问题。
 */
function responseThatNeverSends(
  init?: { signal?: AbortSignal }
): Awaited<ReturnType<typeof net.fetch>> {
  const signal = init?.signal
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () =>
          new Promise<never>((_resolve, reject) => {
            const abort = () => reject(new Error('body stream aborted'))
            if (signal?.aborted) abort()
            else signal?.addEventListener('abort', abort, { once: true })
          }),
      }),
    },
  } as unknown as Awaited<ReturnType<typeof net.fetch>>
}

let dir = ''
let partFile = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vv-407-'))
  partFile = join(dir, 'asset.part')
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete process.env.VV_COMPONENTS_RELEASE_BASE
  delete process.env.VV_COMPONENTS_MANIFEST_URL
  await rm(dir, { recursive: true, force: true })
})

describe('assetUrls 候选源', () => {
  const entry = { tag: 'v1.2.2', asset: 'vv-tts-server-darwin-arm64-1.2.2' }
  const PINNED = 'v1.2.2/vv-tts-server-darwin-arm64-1.2.2'

  it('自家 Release 在前、hf-mirror 在后，两边都钉在同一个 tag/资产上', () => {
    const urls = assetUrls(entry)
    expect(urls).toHaveLength(2)
    expect(new URL(urls[0]).host).toBe(GITHUB)
    expect(new URL(urls[1]).host).toBe(MIRROR)
    // 两个 host 的路径结构本来就不同（releases/download vs resolve），能比的只有尾部的
    // 「哪个 tag 的哪个资产」——它必须一致，否则第二棒取回来的是另一版的东西
    for (const url of urls) {
      expect(new URL(url).pathname.endsWith(`/${PINNED}`)).toBe(true)
    }
  })

  it('镜像那条带 ?download=true：不带它取回的是 HTML 提示页而不是文件', () => {
    const mirror = assetUrls(entry).find((url) => url.startsWith('https://hf-mirror.com'))
    expect(mirror).toBeDefined()
    expect(mirror).toContain('?download=true')
    // 自家 Release 不需要这个参数，多带反而奇怪
    expect(assetUrls(entry)[0]).not.toContain('download=')
  })

  it('自测口子只在清单也被覆盖时生效，且只认那一个源', () => {
    process.env.VV_COMPONENTS_RELEASE_BASE = 'http://127.0.0.1:8123/download'
    // 只覆盖前缀、不覆盖清单：那是生产链路，候选表不许被它改写
    expect(assetUrls(entry)).toHaveLength(2)
    process.env.VV_COMPONENTS_MANIFEST_URL = 'http://127.0.0.1:8123/manifest.json'
    const urls = assetUrls(entry)
    expect(urls).toEqual(['http://127.0.0.1:8123/download/v1.2.2/vv-tts-server-darwin-arm64-1.2.2'])
  })
})

describe('downloadToPart 换源', () => {
  it('第一个源报错时继续试第二个，取到的内容按第二个算', async () => {
    const payload = Buffer.from('engine binary bytes')
    const entry = entryFor(payload)
    const fetch = vi
      .spyOn(net, 'fetch')
      .mockImplementation(async (url) =>
        new URL(url as string).host === GITHUB
          ? responseOf(new Uint8Array(), { ok: false, status: 404 })
          : responseOf(new Uint8Array(payload))
      )

    const received = await downloadToPart(assetUrls(entry), partFile, entry, newTask(), spec)

    expect(received).toBe(payload.length)
    expect(Buffer.compare(await readFile(partFile), payload)).toBe(0)
    expect(fetch.mock.calls.map((call) => new URL(call[0] as string).host)).toEqual([GITHUB, MIRROR])
  })

  it('镜像给了一份指纹对不上的文件：换 host 换不出「清单没点过的文件」', async () => {
    const payload = Buffer.from('engine binary bytes')
    const entry = entryFor(payload)
    const fetch = vi.spyOn(net, 'fetch').mockImplementation(async () =>
      // 篡改过的那份（比如镜像给错了文件）。长度必须与清单声明的一致，否则先撞上
      // 体积那道闸门，这条测的就不是指纹了——两道闸门的判据要能分开。
      responseOf(new Uint8Array(Buffer.from('different content!!')))
    )

    await expect(downloadToPart(assetUrls(entry), partFile, entry, newTask(), spec)).rejects.toThrow(
      /指纹和钉死的那份对不上/
    )
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('字节数不足算「下载不完整」，不算成功', async () => {
    const payload = Buffer.from('0123456789')
    const entry = entryFor(payload, createHash('sha256').update(payload).digest('hex'))
    vi.spyOn(net, 'fetch').mockImplementation(async () =>
      responseOf(new Uint8Array(Buffer.from('01234')))
    )

    await expect(downloadToPart(assetUrls(entry), partFile, entry, newTask(), spec)).rejects.toThrow(
      /下载不完整/
    )
  })

  it('两个源都没取到时，错误里点名两个 host（用户能看出两条路都试过）', async () => {
    const payload = Buffer.from('x')
    const entry = entryFor(payload)
    vi.spyOn(net, 'fetch').mockRejectedValue(new Error('net::ERR_CONNECTION_TIMED_OUT'))

    await expect(downloadToPart(assetUrls(entry), partFile, entry, newTask(), spec)).rejects.toThrow(
      new RegExp(`${GITHUB}[\\s\\S]*${MIRROR}`)
    )
  })

  it('第一棒连上但字节不来：等不满快刀阈值就换源，第二棒成功即装成', async () => {
    vi.useFakeTimers()
    const payload = Buffer.from('engine binary bytes')
    const entry = entryFor(payload)
    const fetch = vi.spyOn(net, 'fetch').mockImplementation(
      async (url, init) =>
        new URL(url as string).host === GITHUB
          ? responseThatNeverSends(init as { signal?: AbortSignal })
          : responseOf(new Uint8Array(payload))
    )

    const done = downloadToPart(assetUrls(entry), partFile, entry, newTask(), spec)
    // 看门狗 3 秒阈值 + 1 秒粒度，推进到第 4 拍就会判死第一棒。
    // 假时钟只截了 timer，落盘用的 fs 回调仍要真实事件循环那一轮才走得到，所以每一拍之间
    // 真睡一次（node:timers 里的 setTimeout 没被替换）；少了这一步，第一棒的 interval 还没建好，
    // 测到的是「假时钟没推进」而不是「换源没发生」。
    for (let i = 0; i < 6; i++) {
      await realSleep(0)
      await vi.advanceTimersByTimeAsync(1_000)
    }

    await expect(done).resolves.toBe(payload.length)
    expect(fetch.mock.calls.map((call) => new URL(call[0] as string).host)).toEqual([GITHUB, MIRROR])
    expect(Buffer.compare(await readFile(partFile), payload)).toBe(0)
  })

  /**
   * #407 上线前实测出来的那条底线，单独钉一条：镜像数据集只回填过 v1.2.1，而线上清单钉的是
   * v1.0.8 —— `resolve/v1.0.8/vv-tts-server-darwin-arm64-1.0.8` 直连拿到的就是 404（2026-11-21 核过）。
   * 也就是第二腿随时可能是空的，而快刀会在 3 秒掐掉第一腿。国内直连约 21KB/s，24MB 那份按 45 分钟
   * 硬上限本来 19 分钟能下完；没有这一棒，用户拿到的就是一句「几个下载源都没取到」，比改之前更差。
   */
  it('镜像上没有清单钉的那个 tag（404）：兜回第一个源慢慢跑完，不许就此失败', async () => {
    vi.useFakeTimers()
    const payload = Buffer.from('engine binary bytes')
    const entry = entryFor(payload)
    let githubCalls = 0
    const fetch = vi.spyOn(net, 'fetch').mockImplementation(async (url, init) => {
      if (new URL(url as string).host === MIRROR) {
        return responseOf(new Uint8Array(), { ok: false, status: 404 })
      }
      githubCalls++
      // 第一棒演「连上了但字节爬不出来」，兜回来那一棒才给全量：同一份文件在同一个源上
      // 两种速度都可能出现，区别只在预算给不给它跑完的时间
      return githubCalls === 1
        ? responseThatNeverSends(init as { signal?: AbortSignal })
        : responseOf(new Uint8Array(payload))
    })

    const done = downloadToPart(assetUrls(entry), partFile, entry, newTask(), spec)
    // 快刀那一拍（3 秒阈值 + 1 秒粒度）之后还要留给换源与兜回那两棒走完；假时钟只截 timer，
    // 落盘的 fs 回调仍要真实事件循环那一轮，所以每拍之间真睡一次（理由见上面那条测试）
    for (let i = 0; i < 8; i++) {
      await realSleep(0)
      await vi.advanceTimersByTimeAsync(1_000)
    }

    await expect(done).resolves.toBe(payload.length)
    expect(fetch.mock.calls.map((call) => new URL(call[0] as string).host)).toEqual([
      GITHUB,
      MIRROR,
      GITHUB,
    ])
    expect(Buffer.compare(await readFile(partFile), payload)).toBe(0)
  })

  it('第一个源亲口回了 404：不兜回重跑，用户看到的是两条路的原话', async () => {
    const payload = Buffer.from('x')
    const entry = entryFor(payload)
    const fetch = vi.spyOn(net, 'fetch').mockImplementation(async (url) =>
      responseOf(new Uint8Array(), {
        ok: false,
        status: new URL(url as string).host === GITHUB ? 404 : 500,
      })
    )

    await expect(downloadToPart(assetUrls(entry), partFile, entry, newTask(), spec)).rejects.toThrow(
      /取不到？/
    )
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('取消是整条任务的：切源之后再点取消要立刻停，不许继续换源', async () => {
    const payload = Buffer.from('x')
    const entry = entryFor(payload)
    const task = newTask()
    const fetch = vi.spyOn(net, 'fetch').mockImplementation(async (url) => {
      task.reason = 'cancelled'
      task.controller.abort()
      return new URL(url as string).host === GITHUB
        ? responseOf(new Uint8Array(), { ok: false, status: 500 })
        : responseOf(new Uint8Array(payload))
    })

    await expect(downloadToPart(assetUrls(entry), partFile, entry, task, spec)).rejects.toThrow('已取消下载')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

/**
 * 换源阈值的算术。它整个就是「拿三个时间戳比大小」，只有把它单独测才不用跟假时钟赛跑：
 * 集成那条测的是「判死之后确实换了源」，这里测的是「什么情况下才该判死」。
 * 关键是最后一段不许带快刀——换无可换时把还在动的下载掐掉，比慢更糟。
 */
describe('stallReason 判死阈值', () => {
  const t0 = 1_000_000_000

  it('第一棒 4 秒只进来 45KB（约 15KB/s）：判死换源', () => {
    expect(stallReason(t0 + 4000, t0, t0 + 4000, 45_000, EARLY_BUDGET)).toMatch(/取不完/)
  })

  it('同样的速度落在最后一棒：不判死，换无可换就让用户等到硬上限', () => {
    expect(stallReason(t0 + 4000, t0, t0 + 4000, 45_000, LAST_BUDGET)).toBe('')
  })

  it('起步两秒、只进来 10KB：给直连一点时间，不许刚连上就换源', () => {
    expect(stallReason(t0 + 2000, t0, t0 + 2000, 10_000, EARLY_BUDGET)).toBe('')
  })

  it('三秒进来 2MB 的健康链路：快刀不许误伤', () => {
    expect(stallReason(t0 + 3000, t0, t0 + 3000, 2_000_000, EARLY_BUDGET)).toBe('')
  })

  it('字节完全停住：两条预算都按自己的 idleMs 判死（断流不是慢）', () => {
    for (const budget of [EARLY_BUDGET, LAST_BUDGET]) {
      expect(stallReason(t0 + budget.idleMs + 1000, t0, t0, 0, budget)).toMatch(/没有新字节/)
    }
    // 已经在动但停住了：断流那条优先于快刀，判据先说「断了」
    expect(stallReason(t0 + 9000, t0, t0 + 900, 500_000, EARLY_BUDGET)).toMatch(/没有新字节/)
  })

  it('两档预算的差别只在快刀那条：断流与硬上限，最后一棒都更宽', () => {
    expect(EARLY_BUDGET.floorBytes).toBeGreaterThan(0)
    expect(LAST_BUDGET.floorBytes).toBe(0)
    expect(LAST_BUDGET.idleMs).toBeGreaterThan(EARLY_BUDGET.idleMs)
    expect(LAST_BUDGET.hardMs).toBeGreaterThan(EARLY_BUDGET.hardMs)
  })
})
