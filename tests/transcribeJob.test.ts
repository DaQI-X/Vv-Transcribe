/**
 * #375 的判据：整单转写从 ipc/asrHandlers.ts 抽进 services/transcribeJob.ts 之后，
 * 界面那一头拿到的东西必须与抽出之前**逐字相同**。
 *
 * 这是一次「不许改变行为」的重构，所以测的全是外部可见的那几张脸：
 * ① 进度事件的顺序、每个事件的五个键、以及 `5 + 95% × 引擎进度` 那道换算；
 * ② 历史记录那一笔的字段（含「实际用的方案」「归一后的档位」「读不出时长写 null」三条口径）；
 * ③ 失败与取消两条路的返回形状、临时目录清没清、任务有没有从账上摘掉。
 * 外加一条结构判据：作业体不认识窗口——进度是传进来的 sink，那一句 `import 'electron'` 就是
 * 「门面能不能当第二个调用方复用这层」的分水岭（#376 的 HTTP 门面与界面共用同一单作业）。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelTranscribeJob,
  hasActiveTranscription,
  startTranscribeJob,
  type TranscribeProgressEvent
} from '../electron/main/services/transcribeJob'

const TEMP_DIR = '/tmp/vv-job-test/transcribe-fake'
const SEGMENT = { startTime: 1, endTime: 2, text: '第一句' }

/**
 * order 这一串是这次重构真正要钉的东西：它把「谁先谁后」写成断言。
 * 界面那句承诺——进度到 100 落在临时目录清理之后、历史记账之前——以前只存在于代码顺序里，
 * 抽一层最容易悄悄改坏的就是它，所以让它在这里显形。
 */
const calls = vi.hoisted(() => ({
  order: [] as string[],
  extractAudio: vi.fn(),
  cleanupTemp: vi.fn(),
  dropCookies: vi.fn(),
  releaseExcept: vi.fn(),
  runTranscription: vi.fn(),
  resolveProfileId: vi.fn(),
  getASRConfig: vi.fn(),
  addHistoryRecord: vi.fn(),
}))

vi.mock('../electron/main/services/audioProcessor', () => ({
  extractAudio: calls.extractAudio,
  cleanupTemp: calls.cleanupTemp,
}))
vi.mock('../electron/main/services/urlDownloader', () => ({
  dropMediaSessionCookies: calls.dropCookies,
  releaseMediaSessionsExcept: calls.releaseExcept,
}))
vi.mock('../electron/main/services/asr/asrManager', () => ({ runTranscription: calls.runTranscription }))
vi.mock('../electron/main/services/historyService', () => ({ addHistoryRecord: calls.addHistoryRecord }))
vi.mock('../electron/main/services/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    serviceCall: vi.fn(),
    serviceError: vi.fn(),
  },
}))
/**
 * settingsService 只换掉那两只要读磁盘的。normalizeLocalModel 留真的：
 * 这一层要证的正是「历史里记的是归一之后那一档」，把它 mock 掉就等于把结论写进前提里。
 */
vi.mock('../electron/main/services/settingsService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../electron/main/services/settingsService')>()),
  resolveProfileId: calls.resolveProfileId,
  getASRConfig: calls.getASRConfig,
}))

/** 收一次进度：既留下载荷，也往 order 里落一个名字 */
function collect(events: TranscribeProgressEvent[]) {
  return (event: TranscribeProgressEvent) => {
    events.push(event)
    calls.order.push(`progress:${event.progress}`)
  }
}

beforeEach(() => {
  calls.order.length = 0
  vi.clearAllMocks()
  calls.extractAudio.mockImplementation(async () => {
    calls.order.push('extract')
    return {
      tempDir: TEMP_DIR,
      wavPath: `${TEMP_DIR}/audio.wav`,
      metadata: { duration: 12.5, channels: 1, sampleRate: 16000, hasAudio: true },
    }
  })
  calls.cleanupTemp.mockImplementation(async () => {
    calls.order.push('cleanupTemp')
  })
  calls.dropCookies.mockResolvedValue(undefined)
  calls.releaseExcept.mockReturnValue(0)
  calls.resolveProfileId.mockResolvedValue('asr-default')
  calls.getASRConfig.mockResolvedValue({ provider: 'local', apiKey: '', model: '', localModel: 'small' })
  calls.addHistoryRecord.mockImplementation(async () => {
    calls.order.push('history')
    return true
  })
  calls.runTranscription.mockImplementation(
    async (_wav: string, _cfg: unknown, opts: { onProgress: (p: unknown) => void }) => {
      calls.order.push('run')
      opts.onProgress({ percent: 2 })
      opts.onProgress({ percent: 50, segment: SEGMENT, stage: 'loading_model', model: { tier: 'small', weightsMb: 74 } })
      return { segments: [SEGMENT], provider: 'local' }
    }
  )
})

describe('进度通道：抽出作业体之后界面看到的还是同一串', () => {
  it('事件是 0 → 5 → 5+95%×引擎进度 → 100，五条都带同一个 jobId 与同样的五个键', async () => {
    const events: TranscribeProgressEvent[] = []
    const result = await startTranscribeJob('/素材/采访.mp4', {}, collect(events))
    const jobId = result.jobId

    expect(events).toStrictEqual([
      { jobId, progress: 0, segment: undefined, stage: undefined, model: undefined },
      { jobId, progress: 5, segment: undefined, stage: undefined, model: undefined },
      { jobId, progress: 6.9, segment: undefined, stage: undefined, model: undefined },
      { jobId, progress: 52.5, segment: SEGMENT, stage: 'loading_model', model: { tier: 'small', weightsMb: 74 } },
      { jobId, progress: 100, segment: undefined, stage: undefined, model: undefined },
    ])
    // 键的顺序也钉一下：载荷是往 IPC 的结构化克隆里去的，多一个键少一个键界面都看得见
    for (const event of events) {
      expect(Object.keys(event)).toEqual(['jobId', 'progress', 'segment', 'stage', 'model'])
    }
    expect(calls.order).toEqual([
      'progress:0',
      'extract',
      'progress:5',
      'run',
      'progress:6.9',
      'progress:52.5',
      'cleanupTemp',
      'progress:100',
      'history',
    ])
    expect(result).toStrictEqual({ jobId, success: true, segments: [SEGMENT], provider: 'local' })
    expect(hasActiveTranscription()).toBe(false)
  })

  it('方案 id 与语言原样传给取值与引擎，缺省时语言还是 zh', async () => {
    await startTranscribeJob('/素材/采访.mp4', { profileId: 'asr-gpt', language: 'en' }, () => {})
    expect(calls.resolveProfileId).toHaveBeenCalledWith('asr', 'asr-gpt')
    expect(calls.getASRConfig).toHaveBeenCalledWith('asr-default')
    expect(calls.runTranscription.mock.calls[0][2]).toMatchObject({ language: 'en' })

    // 第二条的缺省语言要看 calls[1]，或者直接清掉第一条——这里选清：断言只看「这一次」
    calls.runTranscription.mockClear()
    await startTranscribeJob('/素材/采访.mp4', {}, () => {})
    expect(calls.runTranscription.mock.calls[0][2]).toMatchObject({ language: 'zh' })
  })
})

describe('历史那一笔：字段口径没挪', () => {
  it('记的是实际用的方案与归一后的档位，读不出时长写 null', async () => {
    calls.getASRConfig.mockResolvedValue({ provider: 'local', apiKey: '', model: '', localModel: '认不出的档位' })
    calls.extractAudio.mockImplementation(async () => ({
      tempDir: TEMP_DIR,
      wavPath: `${TEMP_DIR}/audio.wav`,
      metadata: { duration: 0, channels: 1, sampleRate: 16000, hasAudio: true },
    }))

    const result = await startTranscribeJob('/素材/采访.mp4', { language: 'en' }, () => {})
    const record = calls.addHistoryRecord.mock.calls[0][0]

    expect(record.id).toBe(result.jobId)
    // 只留文件名：整路径进账本就是用户素材的位置信息
    expect(record.name).toBe('采访.mp4')
    expect(record.profiles).toStrictEqual({ asr: 'asr-default', ai: null, tts: null })
    expect(record.detail.kind).toBe('transcribe')
    expect(record.detail.provider).toBe('local')
    // '认不出的档位' 归一后必须是 base：这一条是 #247 定下来的口径，不是随手写的字符串
    expect(record.detail.model).toBe('base')
    expect(record.detail.language).toBe('en')
    expect(record.detail.segments).toBe(1)
    expect(record.detail.durationSec).toBeNull()
    expect(typeof record.detail.elapsedMs).toBe('number')
    expect(record.source).toBeNull()
  })

  it('云端那一档记的是 config.model 原样，不走本地档位归一', async () => {
    calls.getASRConfig.mockResolvedValue({ provider: 'cloud', apiKey: 'k', model: 'whisper-1', localModel: 'small' })
    calls.runTranscription.mockResolvedValue({ segments: [SEGMENT], provider: 'cloud' })
    await startTranscribeJob('/素材/采访.mp4', {}, () => {})
    expect(calls.addHistoryRecord.mock.calls[0][0].detail.model).toBe('whisper-1')
  })
})

describe('失败与取消：回的是值，账也摘干净', () => {
  it('引擎抛出来的一律收成 success:false，临时目录清掉、进度停在 5、历史不记', async () => {
    calls.runTranscription.mockImplementation(async () => {
      throw new Error('引擎挂了')
    })
    const events: TranscribeProgressEvent[] = []
    const result = await startTranscribeJob('/素材/采访.mp4', {}, collect(events))

    expect(result).toStrictEqual({
      jobId: expect.any(String),
      success: false,
      canceled: false,
      error: '引擎挂了',
    })
    expect(events.map((e) => e.progress)).toEqual([0, 5])
    expect(calls.cleanupTemp).toHaveBeenCalledWith(TEMP_DIR)
    expect(calls.addHistoryRecord).not.toHaveBeenCalled()
    // 「这单结束了」的记账：摘不掉就会永远卡住重启引擎那颗按钮
    expect(hasActiveTranscription()).toBe(false)
  })

  it('提取阶段就炸：那时候还没有临时目录可清，但 cookies 照删', async () => {
    calls.extractAudio.mockImplementation(async () => {
      throw new Error('这个文件没有音轨')
    })
    const result = await startTranscribeJob('/素材/采访.mp4', { mediaSessionId: 'sess-1' }, () => {})

    expect(result).toMatchObject({ success: false, canceled: false, error: '这个文件没有音轨' })
    expect(calls.cleanupTemp).not.toHaveBeenCalled()
    expect(calls.dropCookies).toHaveBeenCalledWith('sess-1')
    expect(hasActiveTranscription()).toBe(false)
  })

  it('取消那一单回的是「转写已取消」，而不是引擎那句 abort 原文', async () => {
    calls.runTranscription.mockImplementation(
      (_wav: string, _cfg: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          // abort 可能发生在引擎被调到之前，所以两态都要认
          const abort = () => reject(new Error('The operation was aborted'))
          if (opts.signal.aborted) abort()
          else opts.signal.addEventListener('abort', abort)
        })
    )

    // 作业体在第一个 await 之前是同步跑的，所以这一句返回时 jobId 已经从进度里拿到了
    let jobId = ''
    const running = startTranscribeJob('/素材/采访.mp4', {}, (event) => {
      jobId = event.jobId
    })
    expect(jobId).not.toBe('')
    expect(hasActiveTranscription()).toBe(true)

    await expect(cancelTranscribeJob(jobId)).resolves.toStrictEqual({ ok: true, error: null })
    await expect(running).resolves.toStrictEqual({
      jobId,
      success: false,
      canceled: true,
      error: '转写已取消',
    })
    expect(hasActiveTranscription()).toBe(false)
    // 取消不算故障：这句是 #358 那条日志口径的一部分
    expect(calls.addHistoryRecord).not.toHaveBeenCalled()
  })

  it('取消一个不存在的 jobId 也算 ok：那说明任务早跑完了，不是这步失败', async () => {
    await expect(cancelTranscribeJob('nope')).resolves.toStrictEqual({ ok: true, error: null })
  })
})

describe('结构判据：业务逻辑真的搬走了', () => {
  const read = (rel: string) => readFile(join(process.cwd(), rel), 'utf-8')

  /**
   * 只看代码行，注释摘掉（与 tests/formatBytes.test.ts 的 codeLines 同一口径）：
   * 「为什么不 import electron」这件事本身就是要靠注释写清楚的，判式连着注释一起扫，
   * 就等于罚这份文件不许解释自己。
   */
  const code = (source: string) =>
    source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')

  it('作业体不 import electron：门面要在另一个进程里跑同一单作业', async () => {
    const source = code(await read('electron/main/services/transcribeJob.ts'))
    expect(source).not.toMatch(/from 'electron'/)
    // 窗口也不许出现在作业体里：进度是传进来的 sink，不是它自己找窗口
    expect(source).not.toMatch(/BrowserWindow|webContents/)
  })

  it('IPC 层只剩接线：jobId、引擎调用与历史记账都不在那一侧', async () => {
    const source = code(await read('electron/main/ipc/asrHandlers.ts'))
    expect(source).not.toMatch(/randomUUID|runTranscription|addHistoryRecord|extractAudio/)
    // 往界面推那一句还是只有一处，且推的就是作业体给的那个对象（不是在这儿重新拼一份）
    expect(source.match(/webContents\.send\('asr:progress', progress\)/g)).toHaveLength(1)
  })
})
