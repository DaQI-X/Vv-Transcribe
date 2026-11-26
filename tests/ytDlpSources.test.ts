/**
 * yt-dlp 应用内更新的候选源（#413 落地的第 D 项）。
 *
 * 钉的是四件事，它们错了都不崩、只会静默变慢或变危险：
 * 1. 顺序——官方原件必须在第一腿，第三方加速前缀只在官方被速率判死后才上场；
 * 2. 每条候选拼的是同一个「版本号/资产名」，否则后面那棒取回来的是另一版的东西；
 * 3. 换 host 换不掉闸门——落地前比的始终是清单钉死的 SHA2-256；
 * 4. 加候选不许把人留在原地：加速前缀哪天关站，官方那一棒要能兜回来慢慢跑完。
 *
 * 阈值与判式不在这里重抄一遍：断言读的是 componentService 导出的同一份常量（#407）。
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as realSleep } from 'node:timers/promises'
import { net } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadToPartFile, releaseUrls } from '../electron/main/services/ytDlpUpdate'

type EntryArg = Parameters<typeof downloadToPartFile>[2]

const GITHUB = 'github.com'
const FAST = 'ghfast.top'
const PROXY = 'gh-proxy.com'
const PINNED = '2026.10.21/yt-dlp_macos'

function entryFor(payload: Buffer, sha256?: string): EntryArg {
  return {
    version: '2026.10.21',
    asset: 'yt-dlp_macos',
    sha256: sha256 ?? createHash('sha256').update(payload).digest('hex'),
    bytes: payload.length,
  }
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

/** 演「连上了但字节不来」那一棒：abort 时让 read 拒绝，这是真实 body stream 的语义 */
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
  dir = await mkdtemp(join(tmpdir(), 'vv-ytdlp-src-'))
  partFile = join(dir, 'yt-dlp.part')
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('releaseUrls 候选顺序', () => {
  it('官方在前、加速前缀按上场顺序在后，每条指向同一个版本号与资产名', () => {
    const urls = releaseUrls({ version: '2026.10.21', asset: 'yt-dlp_macos' })
    expect(urls).toHaveLength(3)
    expect(new URL(urls[0]).host).toBe(GITHUB)
    expect(new URL(urls[1]).pathname.endsWith(`/${PINNED}`)).toBe(true)
    // 加速前缀是「整条官方地址被前缀包住」，不是另拼一份路径：换的只有 host
    expect(urls[1]).toBe(`https://${FAST}/${urls[0]}`)
    // 新那枚排最后一棒：它只在前面都不行时才上场，且拿的是不设快刀的耐心预算
    expect(urls[2]).toBe(`https://${PROXY}/${urls[0]}`)
  })
})

describe('downloadToPartFile 换源', () => {
  it('官方那一棒取不动时换加速前缀，取到的内容按第二棒算', async () => {
    const payload = Buffer.from('yt-dlp universal binary')
    const entry = entryFor(payload)
    const fetch = vi
      .spyOn(net, 'fetch')
      .mockImplementation(async (url) =>
        new URL(url as string).host === GITHUB
          ? responseOf(new Uint8Array(), { ok: false, status: 500 })
          : responseOf(new Uint8Array(payload))
      )

    const from = await downloadToPartFile(releaseUrls(entry), partFile, entry)

    expect(new URL(from).host).toBe(FAST)
    expect(Buffer.compare(await readFile(partFile), payload)).toBe(0)
    expect(fetch.mock.calls.map((call) => new URL(call[0] as string).host)).toEqual([GITHUB, FAST])
  })

  it('加速前缀给了一份指纹对不上的文件：换 host 换不出「清单没点过的文件」', async () => {
    const payload = Buffer.from('yt-dlp universal binary')
    const entry = entryFor(payload)
    vi.spyOn(net, 'fetch').mockImplementation(async () =>
      // 长度必须与清单声明的一致，否则先撞上体积那道闸门，这条测的就不是指纹了
      responseOf(new Uint8Array(Buffer.from('different content!!!!!!')))
    )

    await expect(downloadToPartFile(releaseUrls(entry), partFile, entry)).rejects.toThrow(
      /指纹和更新清单对不上/
    )
  })

  it('每一棒都是指纹问题：那句「挂加速」不许出现（换网络不会让它对上）', async () => {
    const payload = Buffer.from('yt-dlp universal binary')
    const entry = entryFor(payload)
    const fetch = vi.spyOn(net, 'fetch').mockImplementation(async () =>
      responseOf(new Uint8Array(Buffer.from('different content!!!!!!')))
    )

    await expect(downloadToPartFile(releaseUrls(entry), partFile, entry)).rejects.toThrow(
      /换网络不会让它对上/
    )
    // 次数＝候选条数，没有第四趟：官方已经把整份文件交出来过了，拒的是内容不是链路，
    // 兜回那一棒只会拿到同一份对不上的文件（这条判据就是 delivered 那个集合的全部用途）
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('官方亲口回了 404：不兜回重跑，用户看到的是三条路的原话', async () => {
    const payload = Buffer.from('x')
    const entry = entryFor(payload)
    const fetch = vi.spyOn(net, 'fetch').mockImplementation(async (url) =>
      responseOf(new Uint8Array(), {
        ok: false,
        status: new URL(url as string).host === GITHUB ? 404 : 500,
      })
    )

    await expect(downloadToPartFile(releaseUrls(entry), partFile, entry)).rejects.toThrow(/取不到？/)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  /**
   * 第三枚前缀不是摆设：只有官方与第一枚都取不到时它才上场，而它上场之后就不该再有第四趟
   * （成功那一棒直接 return，兜回官方那条判据轮不到）。
   */
  it('前两棒都没取到：第三棒上场，取到即算成，不再兜回官方', async () => {
    const payload = Buffer.from('yt-dlp universal binary')
    const entry = entryFor(payload)
    const fetch = vi.spyOn(net, 'fetch').mockImplementation(async (url) => {
      const host = new URL(url as string).host
      return host === PROXY
        ? responseOf(new Uint8Array(payload))
        : responseOf(new Uint8Array(), { ok: false, status: 500 })
    })

    const from = await downloadToPartFile(releaseUrls(entry), partFile, entry)

    expect(new URL(from).host).toBe(PROXY)
    expect(fetch.mock.calls.map((call) => new URL(call[0] as string).host)).toEqual([
      GITHUB,
      FAST,
      PROXY,
    ])
    expect(Buffer.compare(await readFile(partFile), payload)).toBe(0)
  })

  it('官方连上但字节爬不出来：等不满快刀阈值就换源，第二棒成功即算成', async () => {
    vi.useFakeTimers()
    const payload = Buffer.from('yt-dlp universal binary')
    const entry = entryFor(payload)
    const fetch = vi.spyOn(net, 'fetch').mockImplementation(
      async (url, init) =>
        new URL(url as string).host === GITHUB
          ? responseThatNeverSends(init as { signal?: AbortSignal })
          : responseOf(new Uint8Array(payload))
    )

    const done = downloadToPartFile(releaseUrls(entry), partFile, entry)
    // 假时钟只截 timer，落盘的 fs 回调仍要真实事件循环那一轮才走得到，所以每拍之间真睡一次
    for (let i = 0; i < 6; i++) {
      await realSleep(0)
      await vi.advanceTimersByTimeAsync(1_000)
    }

    await expect(done).resolves.toContain(FAST)
    expect(fetch.mock.calls.map((call) => new URL(call[0] as string).host)).toEqual([GITHUB, FAST])
    expect(Buffer.compare(await readFile(partFile), payload)).toBe(0)
  })

  /**
   * 这条是 #407 那条底线在 yt-dlp 侧的翻版：公开加速前缀不是我们的服务，它随时可能关站或改行为，
   * 而快刀已经在 3 秒掐断了官方那一棒。少了兜回这一棒，「本来慢慢能下完」就变成一句报错，
   * 比加候选之前更差。两枚前缀一起挂不是假设——#423 摸底那天，四个公开前缀里就有四个直连不通。
   */
  it('两枚加速前缀都挂了（网络错误）：兜回官方那一棒跑到底，不许就此失败', async () => {
    vi.useFakeTimers()
    const payload = Buffer.from('yt-dlp universal binary')
    const entry = entryFor(payload)
    let githubAttempts = 0
    const fetch = vi.spyOn(net, 'fetch').mockImplementation(async (url, init) => {
      if (new URL(url as string).host !== GITHUB) throw new Error('net::ERR_CONNECTION_CLOSED')
      githubAttempts++
      // 第一棒演「连上了但字节爬不出来」，兜回来那一棒才给全量：区别只在预算给不给它跑完的时间
      return githubAttempts === 1
        ? responseThatNeverSends(init as { signal?: AbortSignal })
        : responseOf(new Uint8Array(payload))
    })

    const done = downloadToPartFile(releaseUrls(entry), partFile, entry)
    for (let i = 0; i < 8; i++) {
      await realSleep(0)
      await vi.advanceTimersByTimeAsync(1_000)
    }

    await expect(done).resolves.toContain(GITHUB)
    expect(fetch.mock.calls.map((call) => new URL(call[0] as string).host)).toEqual([
      GITHUB,
      FAST,
      PROXY,
      GITHUB,
    ])
    expect(Buffer.compare(await readFile(partFile), payload)).toBe(0)
  })

  /**
   * 两棒都只漏字节时的措辞。判死原因必须传到用户眼前：看门狗 abort 之后流上抛回来的只是
   * 「流被中断」，直接包成「请求没通到对端」就等于把「3 秒只进来 351KB」这条真判据丢掉，
   * 用户看到的是一句像断网、实际是速率太慢的话。
   */
  it('每一棒都被速率判死：错误里说的是「取不完」，不是「请求没通到对端」', async () => {
    vi.useFakeTimers()
    const payload = Buffer.from('yt-dlp universal binary')
    const entry = entryFor(payload)
    const fetch = vi
      .spyOn(net, 'fetch')
      .mockImplementation(async (_url, init) => responseThatNeverSends(init as { signal?: AbortSignal }))

    // 一建好 promise 就挂上 catch：假时钟还要跑上百拍，中途没人接的拒绝会被 vitest 记成未处理异常
    let failure = ''
    const done = downloadToPartFile(releaseUrls(entry), partFile, entry).catch((reason: unknown) => {
      failure = (reason as Error).message
    })
    // 前两棒按快刀 3 秒判死，最后一棒与兜回那一棒按 LAST 的 60 秒断流判死，
    // 四趟加起来要 130 秒左右，所以得推进到第 170 拍才收得齐
    for (let i = 0; i < 170; i++) {
      await realSleep(0)
      await vi.advanceTimersByTimeAsync(1_000)
    }

    await done
    expect(failure).toMatch(/照这个速度取不完/)
    expect(failure).not.toMatch(/请求没通到对端/)
    expect(fetch).toHaveBeenCalledTimes(4)
  })
})
