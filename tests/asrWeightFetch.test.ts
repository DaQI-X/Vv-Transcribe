/**
 * 首转前置取件那一段（#435）。
 *
 * 这里测的是「应用自己把 Whisper 权重装好」这一整段对外可见的形状，不是下载器本身（那份在
 * componentSources / componentArchive 那些文件里）。四条真正会被改坏的东西：
 * - **进度不许倒退**：转写页那条只往前走，取件段必须整个压在引擎 `loading_model` 那 10% 之下，
 *   否则第一次真能转成功的用户会看到条子往回缩。
 * - **老用户不许被白拉一份**：判式是「两棵树任一棵到位」，只看自家目录就会让 1.2.4 之前转过的人
 *   再下一次 148/486MB（#421 的占用那行会如实报出两份，看着像 bug）。
 * - **装失败不许堵路**：指纹表过期是这里最可能发生的错，而引擎那条 hf-mirror 老路正好兜得住它；
 *   拿一次注定失败的下载把首转判死，是把优化做成了新增单点。
 * - **取消要收得干净**：停下那一趟下载，但不能为了「把引擎起回来」再让人等几秒。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logCalls = vi.hoisted(() => vi.fn())
const cached = vi.hoisted(() => ({ tiers: [] as string[] }))
const calls = vi.hoisted(() => vi.fn())

const harness = vi.hoisted(() => ({
  /** 每个用例自己摆这四条的返回 */
  stop: { ok: true } as { ok: boolean; error?: string | null },
  restart: { ok: true } as { ok: boolean; error?: string | null },
  install: { ok: true, error: null } as { ok: boolean; error: string | null; canceled?: boolean },
  /** 装件途中要不要顺手回调一次进度（形状取自 componentService 的 ComponentProgress） */
  report: null as null | { phase: string; done: number; total: number },
  /** true ＝那一趟下载挂住不返，等用例自己 abort 之后再 release */
  hold: false,
  release: null as null | (() => void),
}))

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

vi.mock('../electron/main/services/asrModelUsage', () => ({
  isModelCached: (tier: string) => cached.tiers.includes(tier),
}))

vi.mock('../electron/main/services/asrServiceManager', () => ({
  getASRServiceStatus: () => ({ ready: true, error: null }),
  stopLocalEngineOnRequest: async () => {
    calls('stop')
    return harness.stop
  },
  restartLocalEngine: async (tier: string) => {
    calls('restart', tier)
    return harness.restart
  },
  ensureLocalTier: async (tier: string) => {
    calls('ensure', tier)
    return { ok: true }
  },
}))

vi.mock('../electron/main/services/componentService', () => ({
  cancelInstall: (id: string) => {
    calls('cancel', id)
  },
  installComponent: async (_id: string, onProgress?: (p: unknown) => void) => {
    calls('install', _id)
    if (harness.report) onProgress?.(harness.report)
    if (harness.hold) {
      return new Promise((resolve) => {
        harness.release = () => resolve(harness.install)
      })
    }
    return harness.install
  },
}))

vi.mock('../electron/main/services/asr/localASR', () => ({
  LocalASRProvider: class {
    readonly name = 'local'
    readonly type = 'local' as const
    async isAvailable() {
      return true
    }
    async transcribe() {
      calls('transcribe')
      return [{ startTime: 0, endTime: 1, text: '你好' }]
    }
    cancel() {}
  },
}))

type Progress = { percent: number; stage?: string; model?: { tier: string; download?: { done: number; total: number } } }

async function runLocal(events: Progress[]) {
  const { runTranscription } = await import('../electron/main/services/asr/asrManager')
  return runTranscription('/tmp/none.wav', { provider: 'local', localModel: 'base' }, {
    onProgress: (p) => events.push(p as Progress),
  })
}

beforeEach(() => {
  calls.mockClear()
  logCalls.mockClear()
  cached.tiers = []
  harness.stop = { ok: true }
  harness.restart = { ok: true }
  harness.install = { ok: true, error: null }
  harness.report = null
  harness.hold = false
  harness.release = null
})

describe('闸门：什么时候不动那两棵树', () => {
  it('权重已在任一棵树上时不停引擎、不下件，直接转写', async () => {
    cached.tiers = ['base']
    const events: Progress[] = []
    await runLocal(events)
    expect(calls.mock.calls.map((c) => c[0])).toEqual(['ensure', 'transcribe'])
    expect(events.filter((e) => e.stage === 'downloading_model')).toHaveLength(0)
  })

  it('只缓存了另一档仍要取这一档', async () => {
    cached.tiers = ['small']
    await runLocal([])
    expect(calls.mock.calls).toContainEqual(['install', 'asr-model-base'])
  })

  it('停不下来就绝不动目录，报错用引擎给的那句', async () => {
    harness.stop = { ok: false, error: '有一单转写正在跑，等它结束再替换模型' }
    await expect(runLocal([])).rejects.toThrow('有一单转写正在跑')
    expect(calls.mock.calls.map((c) => c[0])).toEqual(['stop'])
  })
})

describe('顺序与进度：停 → 装 → 起 → 对齐 → 转写', () => {
  it('四步按这个次序，档位带进重起那一步', async () => {
    harness.report = { phase: 'download', done: 50, total: 100 }
    const events: Progress[] = []
    await runLocal(events)
    expect(calls.mock.calls.map((c) => c[0])).toEqual(['stop', 'install', 'restart', 'ensure', 'transcribe'])
    expect(calls.mock.calls[2]).toEqual(['restart', 'base'])
    expect(events.map((e) => e.stage)).toEqual(['downloading_model', 'loading_model'])
  })

  /**
   * 上界 9 是钉死的：引擎自己那条 loading_model 走 percent 10（见 localASR），
   * 取件段一旦报到 10 以上，交棒那一刻条子就会往回缩。
   */
  it('取件那一段整个压在 10 之下，交棒那条正好落在 9', async () => {
    const events: Progress[] = []
    harness.report = { phase: 'download', done: 1_000, total: 1_000 }
    await runLocal(events)
    const fetching = events.filter((e) => e.stage === 'downloading_model')
    expect(fetching.every((e) => e.percent >= 1 && e.percent < 10)).toBe(true)
    const handoff = events.find((e) => e.stage === 'loading_model')
    expect(handoff?.percent).toBe(9)
  })

  /** verify 那一次回调数的是「一件事」不是「一个字节」（{done:0,total:1}），透出去就成了「0B / 1B」 */
  it('只有校验回调时不编字节，只把条子推到段尾', async () => {
    harness.report = { phase: 'verify', done: 0, total: 1 }
    const events: Progress[] = []
    await runLocal(events)
    expect(events[0]?.model?.download).toBeUndefined()
    expect(events[0]?.percent).toBe(9)
  })

  /** 清单钉死的分母要等第一个响应头才落进来；在那之前只报已取，别给一个假百分比 */
  it('分母未知时条子停在段首，但已取的字节照报', async () => {
    harness.report = { phase: 'download', done: 12_345, total: 0 }
    const events: Progress[] = []
    await runLocal(events)
    expect(events[0]?.percent).toBe(1)
    expect(events[0]?.model?.download).toEqual({ done: 12_345, total: 0 })
  })
})

describe('装不上时把老路留着', () => {
  it('装失败但引擎起回来了：只记日志，照常转写，也不再补一条交棒进度', async () => {
    harness.install = { ok: false, error: '清单里的 sha256 对不上' }
    const events: Progress[] = []
    const result = await runLocal(events)
    expect(result.provider).toBe('local')
    expect(calls.mock.calls).toContainEqual(['transcribe'])
    expect(events.filter((e) => e.stage === 'loading_model')).toHaveLength(0)
    expect(logCalls).toHaveBeenCalled()
  })

  it('引擎起不回来时，装件那句一起给，别只让人重启应用', async () => {
    harness.install = { ok: false, error: '镜像没有这一枚文件' }
    harness.restart = { ok: false, error: '端口上坐着一个不认识本代凭证的服务' }
    await expect(runLocal([])).rejects.toThrow(
      '端口上坐着一个不认识本代凭证的服务（模型权重下载也没成：镜像没有这一枚文件）',
    )
  })
})

describe('取消', () => {
  it('取消那一趟下载：停下件、把引擎起回来、这一单以取消收口', async () => {
    cached.tiers = []
    harness.install = { ok: false, error: null, canceled: true }
    const events: Progress[] = []
    await expect(runLocal(events)).rejects.toThrow('模型权重下载已取消')
    expect(calls.mock.calls).toContainEqual(['restart', 'base'])
    expect(calls.mock.calls).not.toContainEqual(['transcribe'])
  })

  it('下载途中 abort：按组件 id 叫停那一趟，这一单以取消收口', async () => {
    harness.hold = true
    harness.install = { ok: false, error: null, canceled: true }
    const controller = new AbortController()
    const { runTranscription } = await import('../electron/main/services/asr/asrManager')
    const running = runTranscription('/tmp/none.wav', { provider: 'local', localModel: 'base' }, {
      signal: controller.signal,
    })
    // 等装件那一步真的开始（否则 abort 发生在 addEventListener 之前，那条监听根本挂不上）
    while (!calls.mock.calls.some((c) => c[0] === 'install')) await new Promise((r) => setTimeout(r, 0))
    controller.abort()
    expect(calls.mock.calls).toContainEqual(['cancel', 'asr-model-base'])
    harness.release?.()
    await expect(running).rejects.toThrow('模型权重下载已取消')
    // 起引擎那一步是后台做的，不许把取消的收尾拖在它后面
    expect(calls.mock.calls).not.toContainEqual(['transcribe'])
  })
})
