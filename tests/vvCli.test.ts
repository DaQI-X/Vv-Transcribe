/**
 * #377 CLI 那一侧的判据。分七块，每块钉的都是「换个人写就会悄悄改掉」的那几件事：
 *
 * ① **argv**：`-f` 与 `-o` 后缀冲突必须拒，不许悄悄按某一边来——那种「文件名叫 .vtt、里面是 SRT」
 *    的谎要靠打开才发现。两条子命令各一把参数，串了门的那种组合没有一种有意义。
 * ② **三种连不上 + 退出码**：「没开开关」「文件读不懂」「端口没人应答」是三种不同的事，
 *    都念成「应用没在跑」会把人引去重启一个本来就在跑的应用；码分五种（0/1/2/3/130）是给脚本用的。
 * ③ **薄**：不许 import 'electron'（#374 实测 node 模式一 import 就抛）、不许自己写时间轴
 *    （「CLI 出的文件与界面导的一致」这句承诺的结构保证就是同一次 `exportTranscript` 调用）、
 *    六档清单与导出器逐条对账。这三条扫源码，因为它们在行为上「暂时没坏」也能一直坏着。
 * ④ **启动器的路径算术**：打包实测在这件小事上翻过两次车（少算一级 / 拿 -f 探 asar 里面），所以搭假包布局真跑；
 *    再加上「入口判定」那一次（软链路径下的 vv.mjs 认不出自己是入口 → 不输出还退 0）。
 * ⑤ **一次真 socket**：门面的 handler + 真 fetch + 真落盘的凭据文件，中间不掺假响应。
 * ⑥ **check（#356）**：这一条不碰门面也不读凭据（发一次请求就算跑偏）、报告整份走 stdout、
 *    退出码只借校验报告那一个，档位文件必须过同一道 validatePreset（手改的那份不许绕过「六条写全 + 每条带出处」）。
 * ⑦ **mcp（#356）**：壳。initialize / ping / tools/list / tools/call 之外不回话，通知（没有 id）不回话，
 *    stdout 上只许有协议那一行（产物流进工具结果，不流进通道）；三把 tool 的产物与 `vv transcribe` /
 *    `vv check` / `exportTranscript` 逐字节相同，判出红不是工具失败（isError 只给「活儿没干成」）。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, access, copyFile, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({
  startJob: vi.fn(),
  cancelJob: vi.fn(),
  log: vi.fn(),
}))

/**
 * 门面 handler 只有 `createFacadeHandler` 这一样东西要用，另外那几只手都从 deps 参数进（#376 的形状）。
 * mock 掉是为了别把真引擎链（fluent-ffmpeg、python sidecar）拖进这个测试进程——
 * 路径与 tests/agentFacade.test.ts 一致，那份已经证明这套替身够 handler 跑完四条端点。
 */
vi.mock('../electron/main/services/transcribeJob', () => ({
  startTranscribeJob: stubs.startJob,
  cancelTranscribeJob: stubs.cancelJob,
}))
vi.mock('../electron/main/services/asrServiceManager', () => ({
  getASRServiceStatus: () => ({ ready: true }),
}))
vi.mock('../electron/main/services/logger', () => ({
  logger: { info: stubs.log, warn: stubs.log, error: stubs.log, debug: stubs.log, serviceCall: stubs.log, serviceError: stubs.log },
}))

import { createFacadeHandler, type FacadeDeps } from '../electron/main/services/agentFacade'
import { readAgentEndpoint, writeAgentEndpoint } from '../electron/main/services/agentEndpoint'
import { userDataDirFor } from '../electron/main/services/userDataDir'
import {
  FORMATS,
  TOOL_NAMES,
  USAGE,
  entryMatches,
  handleMcpLine,
  parseArgv,
  run,
  toolSpecs,
  type CliIo,
} from '../electron/cli/vv'
import { exportTranscript, getExportExtension } from '../src/utils/exportTranscript'
import { builtinPreset, type CheckReport, type SubtitlePreset } from '../src/utils/subtitleSpec'
import type { TranscribeJobResult } from '../electron/main/services/transcribeJob'
import type { TranscriptionSegment } from '../src/types/transcription'

const TOKEN = 'unit-test-token-0123456789abcdef'
const RAW = [
  { startTime: 0, endTime: 1.5, text: '第一句' },
  { startTime: 1.5, endTime: 3.25, text: '第二句' },
]
/** 界面那份形状：CLI 的产物必须与「拿这几个字段走一次 exportTranscript」逐字节相同 */
const UI_SEGMENTS: TranscriptionSegment[] = RAW.map((seg, i) => ({
  id: String(i + 1),
  startTime: seg.startTime,
  endTime: seg.endTime,
  text: seg.text,
  isEdited: false,
  isCorrected: false,
}))

const line = (obj: unknown): string => JSON.stringify(obj)
const RESULT_LINE = line({ type: 'result', jobId: 'job-1', success: true, segments: RAW, provider: 'local' })
const PROGRESS_LINES = [
  line({ type: 'progress', jobId: 'job-1', progress: 5, stage: 'loading_model', model: { tier: 'base', weightsMb: 14 } }),
  line({ type: 'progress', jobId: 'job-1', progress: 30, segment: RAW[0] }),
  line({ type: 'progress', jobId: 'job-1', progress: 55, segment: RAW[1] }),
  line({ type: 'progress', jobId: 'job-1', progress: 100 }),
]

// ---------------------------------------------------------------- ① argv

describe('vv parseArgv：参数形状', () => {
  it('最小闭环：一个路径就够，格式默认 srt、产物默认 stdout', () => {
    const parsed = parseArgv(['transcribe', '采访.mp4'])
    if (!parsed.ok) throw new Error(parsed.message)
    expect(parsed.args).toEqual({
      command: 'transcribe',
      file: '采访.mp4',
      out: null,
      format: 'srt',
      formatGiven: false,
      language: undefined,
      profileId: undefined,
      dataDir: undefined,
    })
  })

  it('-o 的后缀认得出档位，不必再写 -f', () => {
    for (const [name, format] of [
      ['out.vtt', 'vtt'],
      ['out.json', 'json'],
      ['out.md', 'md'],
    ] as const) {
      const parsed = parseArgv(['transcribe', 'a.mp4', '-o', name])
      expect(parsed.ok && parsed.args.format).toBe(format)
    }
  })

  /** 这条是「不许出现要靠打开才发现的谎」：两边都写还不一致，改一个都比按谁的来有用 */
  it('-f 与 -o 后缀不一致就拒，不许悄悄按某一边来', () => {
    const parsed = parseArgv(['transcribe', 'a.mp4', '-f', 'srt', '-o', 'out.vtt'])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain('-f srt')
    expect(parsed.message).toContain('.vtt')
  })

  it('-f 与 -o 后缀一致时放行；后缀不在六档里时按 -f（导出器不认识的扩展名不算冲突）', () => {
    expect(parseArgv(['transcribe', 'a.mp4', '-f', 'vtt', '-o', 'out.vtt']).ok).toBe(true)
    const loose = parseArgv(['transcribe', 'a.mp4', '-f', 'txt', '-o', 'out.text'])
    expect(loose.ok && loose.args.format).toBe('txt')
  })

  it('--flag=value 那种写法收，脚本里拼参数常用', () => {
    const parsed = parseArgv(['transcribe', 'a.mp4', '--format=md', '--out=out.md', '--language=zh'])
    expect(parsed.ok && parsed.args.format).toBe('md')
    expect(parsed.ok && parsed.args.out).toBe('out.md')
    expect(parsed.ok && parsed.args.language).toBe('zh')
  })

  it('标记缺值、不认得的标记、多余的路径、别的子命令都算「命令写错了」', () => {
    const cases: string[][] = [
      ['transcribe', 'a.mp4', '-o'],
      ['transcribe', 'a.mp4', '-f', 'xml'],
      ['transcribe', 'a.mp4', '--bogus'],
      ['transcribe', 'a.mp4', 'b.mp4'],
      ['transcribe'],
      ['download', 'a.mp4'],
      [],
    ]
    for (const argv of cases) {
      expect(parseArgv(argv).ok, argv.join(' ')).toBe(false)
    }
    const bogus = parseArgv(['transcribe', 'a.mp4', '--bogus'])
    if (bogus.ok) throw new Error('该拒的没拒')
    expect(bogus.message).toContain('--bogus')
    const sub = parseArgv(['download', 'x'])
    if (sub.ok) throw new Error('该拒的没拒')
    expect(sub.message).toContain('transcribe / check')
  })

  /** 两条子命令各一把参数：串了门没有一种有意义（check 不提交作业，transcribe 不判文件） */
  it('check 与 transcribe 各收各的参数，串了门就拒', () => {
    const cases: string[][] = [
      ['check', 'a.srt', '-o', 'b.txt'],
      ['check', 'a.srt', '-f', 'vtt'],
      ['check', 'a.srt', '--language', 'zh'],
      ['check', 'a.srt', '--profile', 'p-1'],
      ['check', 'a.srt', '--data-dir', '/tmp/x'],
      ['transcribe', 'a.mp4', '--json'],
      ['transcribe', 'a.mp4', '--fps', '25'],
      ['transcribe', 'a.mp4', '--preset', 'broadcast-cn'],
    ]
    for (const argv of cases) {
      const parsed = parseArgv(argv)
      expect(parsed.ok, argv.join(' ')).toBe(false)
      if (parsed.ok) continue
      expect(parsed.message, argv.join(' ')).toContain('不收')
    }
  })

  it('check 的最小闭环：一个路径就够，档位默认、帧率没给、产物走 stdout', () => {
    const parsed = parseArgv(['check', '采访.srt'])
    if (!parsed.ok) throw new Error(parsed.message)
    expect(parsed.args).toEqual({
      command: 'check',
      file: '采访.srt',
      out: null,
      format: 'srt',
      formatGiven: false,
      preset: undefined,
      fps: undefined,
      json: false,
    })
  })

  /** --fps 只有「确实是帧率」才有意义：23.976 这种非整数真在用（NTSC），0 / 负数 / 拼错的一律拒 */
  it('--preset 认内置名或路径，--fps 收得住非整数帧率', () => {
    expect(parseArgv(['check', 'a.srt', '--preset=netflix-cjk']).ok).toBe(true)
    expect(parseArgv(['check', 'a.srt', '--preset', './我的档位.json']).ok).toBe(true)
    expect(parseArgv(['check', 'a.srt', '--preset', '/tmp/x/档位']).ok).toBe(true)
    const bogus = parseArgv(['check', 'a.srt', '--preset', '我的档位'])
    if (bogus.ok) throw new Error('该拒的没拒：光一个名字既不是内置档、也看不出是哪份文件')
    expect(bogus.message).toContain('.json')
    for (const bad of ['0', 'abc', '25fps']) {
      expect(parseArgv(['check', 'a.srt', '--fps', bad]).ok, bad).toBe(false)
    }
    for (const good of ['25', '23.976', '29.97']) {
      const parsed = parseArgv(['check', 'a.srt', '--fps', good])
      expect(parsed.ok && parsed.args.fps).toBe(Number(good))
    }
  })

  it('-h / --help / --version 不用凑齐参数也出话', () => {
    for (const argv of [['--help'], ['-h'], ['transcribe', 'a.mp4', '--help']]) {
      const parsed = parseArgv(argv)
      expect(parsed.ok && parsed.args.command).toBe('help')
    }
    expect(parseArgv(['--version']).ok).toBe(true)
  })

  /** 这份清单是 USAGE 里那行 `-f srt|vtt|…` 的同一份真相：漏一个是「帮助里写得出、传进去报错」 */
  it('USAGE 里的六个档位名与 FORMATS 一一对上', () => {
    for (const format of FORMATS) expect(USAGE).toContain(format)
  })

  /** #387：那一行地址只在人主动看帮助时出现。它不许变成拦路提示，也不许变成一次请求 */
  it('USAGE 末尾带那一行文档地址', () => {
    expect(USAGE).toContain('https://vvscribe.com/docs#cli')
  })
})

// ---------------------------------------------------------------- ② 三种连不上 + 退出码

interface Harness {
  io: CliIo
  out: string[]
  err: string[]
  written: Map<string, string>
  calls: Array<{ url: string; init: RequestInit | undefined }>
}

/** 只实现 run() 真用到的那几个成员（status/ok/json/body.getReader）；chunks 是一帧一帧的，能把「半截行」演出来 */
function fakeResponse(opts: {
  status?: number
  json?: unknown
  /** 整行数组，内部自动补换行 */
  lines?: string[]
  /** 原始帧数组：一行拆成两帧发就走这一支 */
  chunks?: string[]
  /** 帧发完之后 read() 改抛这个：Ctrl-C 打断在读流那一带的真实形状 */
  readError?: Error
}): Response {
  const status = opts.status ?? 200
  const frames = (opts.chunks ?? (opts.lines ?? []).map((text) => `${text}\n`)).map((text) => new TextEncoder().encode(text))
  let index = 0
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => opts.json,
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= frames.length) {
            if (opts.readError) throw opts.readError
            return { done: true as const, value: undefined }
          }
          return { done: false as const, value: frames[index++] as Uint8Array }
        },
      }),
    },
  } as unknown as Response
}

const okAccept = fakeResponse({ status: 202, json: { jobId: 'job-1' } })
function okStream(lines?: string[], chunks?: string[]): Response {
  return chunks ? fakeResponse({ chunks }) : fakeResponse({ lines: lines ?? [] })
}

function makeHarness(steps: Array<Response | Error>, overrides: Partial<CliIo> = {}): Harness {
  const out: string[] = []
  const err: string[] = []
  const written = new Map<string, string>()
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  let step = 0
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(input), init })
    const next = steps[step++]
    if (next instanceof Error) return Promise.reject(next)
    if (!next) throw new Error(`测试没准备第 ${step} 个响应`)
    return Promise.resolve(next)
  }) as typeof fetch
  const io: CliIo = {
    fetch: fetchImpl,
    readEndpoint: async () => ({ status: 'ok', endpoint: { port: 41234, token: TOKEN } }),
    writeText: async (path, text) => {
      written.set(path, text)
    },
    readText: async () => {
      throw new Error('这个测试没准备文件内容（check 那几条各自用 checkHarness 给一份内存文件）')
    },
    accessFile: async () => undefined,
    stdout: (chunk) => {
      out.push(chunk)
    },
    stderr: (chunk) => {
      err.push(chunk)
    },
    cwd: '/work',
    platform: 'darwin',
    home: '/home/dq',
    env: {},
    version: () => '1.2.0-test',
    signal: new AbortController().signal,
    onJobId: () => {},
    ...overrides,
  }
  return { io, out, err, written, calls }
}

const said = (h: Harness): string => h.err.join('')

describe('vv run：三种「连不上」各说各的话', () => {
  /** #387 的口径：排障那三种失败各带一行文档地址（人已经在找办法了），但正常输出流里一处都没有 */
  it('没有 agent-api.json：点名那一格与「保存设置」，不再让人去重启一个本来就在跑的应用', async () => {
    const h = makeHarness([], { readEndpoint: async () => ({ status: 'missing' }) })
    expect(await run(['transcribe', 'a.mp4'], h.io)).toBe(3)
    expect(said(h)).toContain('agent-api.json')
    expect(said(h)).toContain('agentApi')
    // #385 起这一格在设置界面里、保存即生效：再说「重启应用」就是把人引向一步没必要的动作
    expect(said(h)).toContain('保存设置')
    expect(said(h)).not.toContain('重启应用')
    expect(said(h)).toContain('vvscribe.com/docs#cli')
  })

  it('文件在但读不懂：说「读不懂」并带上原因，不许推给「应用没在跑」', async () => {
    const h = makeHarness([], {
      readEndpoint: async () => ({ status: 'invalid', reason: 'Unexpected end of JSON input' }),
    })
    expect(await run(['transcribe', 'a.mp4'], h.io)).toBe(3)
    expect(said(h)).toContain('读不懂')
    expect(said(h)).toContain('Unexpected end of JSON input')
    expect(said(h)).not.toContain('没在跑')
    expect(said(h)).toContain('vvscribe.com/docs#cli')
  })

  it('端口没人应答：说那次运行已经结束了，而不是「开关没开」', async () => {
    const h = makeHarness([new TypeError('fetch failed')])
    expect(await run(['transcribe', 'a.mp4'], h.io)).toBe(3)
    expect(said(h)).toContain('端口 41234 上没人应答')
    expect(said(h)).not.toContain('agentApi')
    expect(said(h)).toContain('vvscribe.com/docs#cli')
  })

  it('token 对不上（401）：点出「每次运行换一个」', async () => {
    const h = makeHarness([fakeResponse({ status: 401 })])
    expect(await run(['transcribe', 'a.mp4'], h.io)).toBe(3)
    expect(said(h)).toContain('token 对不上')
    expect(said(h)).toContain('重启')
    expect(said(h)).toContain('vvscribe.com/docs#cli')
  })
})

describe('vv run：退出码', () => {
  it('参数不对 → 2；素材读不到 → 也是 2（不是「连不上应用」）', async () => {
    expect(await run(['transcribe'], makeHarness([]).io)).toBe(2)
    const h = makeHarness([], {
      accessFile: async () => {
        throw new Error('ENOENT: no such file or directory')
      },
    })
    expect(await run(['transcribe', 'gone.mp4'], h.io)).toBe(2)
    expect(said(h)).toContain('这个文件读不到')
  })

  it('提交被门面拒（400）→ 2，并把门面那句话原样递出来', async () => {
    const h = makeHarness([
      fakeResponse({ status: 400, json: { error: '不认识这些字段：flie。只收 file / language / profileId' } }),
    ])
    expect(await run(['transcribe', 'a.mp4'], h.io)).toBe(2)
    expect(said(h)).toContain('不认识这些字段：flie')
  })

  it('门面自己出错（500）→ 1，不是 2：命令没写错', async () => {
    const h = makeHarness([fakeResponse({ status: 500, json: { error: '转写作业没能在开始或结束时把作业编号交出来' } })])
    expect(await run(['transcribe', 'a.mp4'], h.io)).toBe(1)
    expect(said(h)).toContain('作业编号')
  })

  it('202 却没给 jobId → 1（这一单没被记下来，不许假装在跑）', async () => {
    const h = makeHarness([fakeResponse({ status: 202, json: {} })])
    expect(await run(['transcribe', 'a.mp4'], h.io)).toBe(1)
    expect(said(h)).toContain('jobId')
  })

  it('作业失败 / 空结果 / 没等到结果行 → 都是 1，三句话各不相同', async () => {
    // dev 实测到的形状：喂一个假 .mp4，应用那侧的 error 是人话那句 + ffprobe 的整段版本横幅。
    // CLI 的口径是一句话，所以只许把第一行落在 stderr，其余留给应用的日志。
    const failed = makeHarness([
      okAccept,
      okStream([line({
        type: 'result', jobId: 'job-1', success: false, canceled: false,
        error: '无法读取文件信息: ffprobe exited with code 1\nffprobe version n4.4.1 Copyright (c) 2007-2021\nmoov atom not found',
      })]),
    ])
    expect(await run(['transcribe', 'a.mp4'], failed.io)).toBe(1)
    expect(said(failed)).toContain('无法读取文件信息: ffprobe exited with code 1')
    expect(said(failed)).not.toContain('ffprobe version n4.4.1')

    const empty = makeHarness([okAccept, okStream([line({ type: 'result', jobId: 'job-1', success: true, segments: [], provider: 'local' })])])
    expect(await run(['transcribe', 'a.mp4'], empty.io)).toBe(1)
    expect(said(empty)).toContain('0 段')

    const truncated = makeHarness([okAccept, okStream([PROGRESS_LINES[0] as string])])
    expect(await run(['transcribe', 'a.mp4'], truncated.io)).toBe(1)
    expect(said(truncated)).toContain('没等到结果那一行')

    const gone = makeHarness([okAccept, fakeResponse({ status: 404, json: { error: '没有编号为 job-1 的作业' } })])
    expect(await run(['transcribe', 'a.mp4'], gone.io)).toBe(3)
    expect(said(gone)).toContain('门面说没有这一单')
  })

  it('跑到一半被打断 → 130，话说清是 Ctrl-C 而不是应用坏了', async () => {
    const controller = new AbortController()
    controller.abort()
    const abortErr = new Error('This operation was aborted')
    abortErr.name = 'AbortError'
    const h = makeHarness([abortErr], { signal: controller.signal })
    expect(await run(['transcribe', 'a.mp4'], h.io)).toBe(130)
    expect(said(h)).toContain('被取消了')
  })

  /**
   * Ctrl-C 有三个落点：提交那一发、建流那一发、读流那一带。前两支由 fetch 的 catch 接，
   * 第三支由读循环自己那道 catch 接——打包前 dev 实测的就是第三支，那时它退 130 却一声不响，
   * 读起来跟「应用挂了」没区别。这条钉住三个落点说的是同一句话。
   */
  it('Ctrl-C 落在读流那一带 → 同一句「被取消了」，不许不响', async () => {
    const controller = new AbortController()
    controller.abort()
    const abortErr = new Error('This operation was aborted')
    abortErr.name = 'AbortError'
    const h = makeHarness([okAccept, fakeResponse({ lines: [PROGRESS_LINES[1] as string], readError: abortErr })], { signal: controller.signal })
    expect(await run(['transcribe', 'a.mp4'], h.io)).toBe(130)
    const text = said(h)
    expect(text).toContain('被取消了（Ctrl-C）')
    expect(text).not.toContain('没等到结果那一行')
  })

  it('--help 走 stdout 且退 0；--version 印传进来的那个号', async () => {
    const help = makeHarness([])
    expect(await run(['--help'], help.io)).toBe(0)
    expect(help.out.join('')).toContain('vv transcribe')
    expect(help.out.join('')).toContain('vv check')
    expect(help.out.join('')).toContain('vv mcp')
    expect(help.err).toHaveLength(0)
    const ver = makeHarness([])
    expect(await run(['--version'], ver.io)).toBe(0)
    expect(ver.out.join('')).toBe('1.2.0-test\n')
  })
})

describe('vv run：进度、产物与管道', () => {
  it('每段一行「第 N 段出来了」，阶段各一行，不刷假百分比', async () => {
    const h = makeHarness([okAccept, okStream([...PROGRESS_LINES, RESULT_LINE])])
    expect(await run(['transcribe', 'a.mp4', '-o', 'out.srt'], h.io)).toBe(0)
    const text = said(h)
    expect(text).toContain('模型装载中（base）')
    expect(text).toContain('第 1 段出来了：30%')
    expect(text).toContain('第 2 段出来了：55%')
    expect(text).toContain('转写完成，收结果')
    // 段号连续、每段只一行：几百个进度事件刷成几百行没人读，跳号则是假段数
    expect(text.split('\n').filter((row) => row.startsWith('第 '))).toHaveLength(2)
  })

  /**
   * dev 实测到的那一条：引擎流式的最后一条 progress=100 与作业体收口那条都会到 CLI，
   * 于是 stderr 上刷出两行「转写完成，收结果」——读起来像出了两段收尾。
   * 判据钉的是「同一条消息只打一遍」，不是「只来一条 100」。
   */
  it('progress=100 来两次也只说一次「转写完成」', async () => {
    const twice = [...PROGRESS_LINES, PROGRESS_LINES[3]!, RESULT_LINE]
    const h = makeHarness([okAccept, okStream(twice)])
    expect(await run(['transcribe', 'a.mp4', '-o', 'out.srt'], h.io)).toBe(0)
    const text = said(h)
    expect(text.split('\n').filter((row) => row.startsWith('转写完成'))).toHaveLength(1)
    expect(text.split('\n').filter((row) => row.startsWith('第 '))).toHaveLength(2)
  })

  it('-o 时产物字节与界面那次 exportTranscript 相同，stdout 不沾一个字', async () => {
    const h = makeHarness([okAccept, okStream([...PROGRESS_LINES, RESULT_LINE])])
    expect(await run(['transcribe', 'a.mp4', '-o', 'out.srt'], h.io)).toBe(0)
    expect(h.out).toHaveLength(0)
    expect(h.written.get('/work/out.srt')).toBe(exportTranscript(UI_SEGMENTS, 'srt'))
  })

  it('不写 -o 时 stdout 只有产物：管道那头可能就是 .srt 文件', async () => {
    const h = makeHarness([okAccept, okStream([...PROGRESS_LINES, RESULT_LINE])])
    expect(await run(['transcribe', 'a.mp4', '-f', 'vtt'], h.io)).toBe(0)
    expect(h.out.join('')).toBe(exportTranscript(UI_SEGMENTS, 'vtt'))
    // 「已输出到 stdout」那句是给人看的，必须落在 stderr
    expect(said(h)).toContain('已输出到 stdout')
  })

  it('一行被拆成两帧也认：NDJSON 的行边界不靠运气', async () => {
    const text = `${RESULT_LINE}\n`
    const h = makeHarness([okAccept, okStream(undefined, [text.slice(0, 20), text.slice(20)])])
    expect(await run(['transcribe', 'a.mp4'], h.io)).toBe(0)
    expect(h.out.join('')).toBe(exportTranscript(UI_SEGMENTS, 'srt'))
  })

  it('相对路径按 CLI 的 cwd 展开成绝对路径再交给门面：两边 cwd 不是一个东西', async () => {
    const h = makeHarness([okAccept, okStream([RESULT_LINE])])
    await run(['transcribe', 'sub/采访.mp4'], h.io)
    const first = h.calls[0]
    if (!first?.init?.body) throw new Error('没发出请求体')
    expect(JSON.parse(String(first.init.body)).file).toBe('/work/sub/采访.mp4')
  })

  /** #376 的凭据面：跨端的只有 file/language/profileId，密钥仍走 profileId 那侧的默认方案 */
  it('POST 只带白名单字段，地址只走 127.0.0.1 字面量 + Bearer', async () => {
    const h = makeHarness([okAccept, okStream([RESULT_LINE])])
    await run(['transcribe', 'a.mp4', '--language', 'zh', '--profile', 'p-2'], h.io)
    const post = h.calls[0]
    if (!post?.init?.body) throw new Error('没发出请求体')
    expect(Object.keys(JSON.parse(String(post.init.body))).sort()).toEqual(['file', 'language', 'profileId'])
    expect(h.calls.length).toBe(2)
    for (const call of h.calls) {
      expect(call.url.startsWith('http://127.0.0.1:41234/')).toBe(true)
      const headers = call.init?.headers as Record<string, string>
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
    }
  })
})

// ---------------------------------------------------------------- ③ 薄：源码形状守卫

/** 与 tests/formatBytes.test.ts 同一招：注释行去掉，只留可能真的在跑的那几行 */
function codeLines(file: string, comment: RegExp): string {
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((row) => !comment.test(row))
    .join('\n')
}

describe('vv 有多薄：三条硬约束扫源码', () => {
  const cli = codeLines(join(process.cwd(), 'electron/cli/vv.ts'), /^\s*(\/\/|\*|\/\*)/)

  it('不 import electron：node 模式下 require("electron") 直接抛（#374 实测）', () => {
    expect(cli).not.toMatch(/from ['"]electron['"]/)
    expect(cli).not.toMatch(/require\(['"]electron['"]\)/)
  })

  /** 时间轴那一行只能出自 exportTranscript；CLI 里再写一遍，「两边一致」就变成两条各自演化的代码 */
  it('不自己写 SRT 时间轴，产物一定走 exportTranscript', () => {
    expect(cli).not.toMatch(/-->/)
    expect(cli).not.toMatch(/\d{2}:\d{2}:\d{2}/)
    expect(cli).toMatch(/exportTranscript\(/)
  })

  /** 六档清单在 CLI 里是第二次出现，这条把它钉在导出器那份 case 上 */
  it('FORMATS 与 exportTranscript 的 case 逐条对上，且扩展名各不重复', () => {
    const exporter = codeLines(join(process.cwd(), 'src/utils/exportTranscript.ts'), /^\s*(\/\/|\*|\/\*)/)
    const cases = [...exporter.matchAll(/^\s*case '([a-z]+)':/gm)].map((m) => m[1] as string)
    expect(cases.sort()).toEqual([...FORMATS].sort())
    const exts = FORMATS.map((format) => getExportExtension(format))
    expect(new Set(exts).size).toBe(FORMATS.length)
  })

  it('启动器先解 $0 的符号链接再取 dirname：Homebrew 的 cask binary 是个 link', () => {
    // 注释里就写着「dirname」这两个字（那句解释正是为它写的），所以扫之前先剥掉 # 行
    const launcher = codeLines(join(process.cwd(), 'bin/vv'), /^\s*#/)
    expect(launcher).toMatch(/while \[ -L "\$self" \]/)
    expect(launcher).toMatch(/ELECTRON_RUN_AS_NODE=1/)
    expect(launcher.indexOf('dirname')).toBeGreaterThan(launcher.indexOf('while [ -L'))
  })
})

// ---------------------------------------------------------------- ④ 启动器的路径算术

/**
 * bin/vv 只剩一件活：从「自己在包里的位置」算出那份 Electron 和 asar 里的 CLI 产物在哪。
 * 打包实测就是在这件小事上翻了两次车——一次把 Resources 当成 Contents（少算一级），
 * 一次拿 `-f` 去探 asar 里面的文件（真 fs 看不见罐内）；两次的表现都是明明装好了却退 127。
 * 上面那条扫源码的只能证明「那几行字还在」，证不出算出来的路径对，所以这里搭一份假包布局真跑。
 *
 * Windows 那一支的入口该是 .cmd/.ps1（还没写，#378 记着这笔债），在 win 上跑这堆 sh 只会假红，故整节跳过。
 */
const POSIX = process.platform !== 'win32'

/** 替身「Electron」：不起 GUI，只把收到的 ELECTRON_RUN_AS_NODE、自己的路径和头两个参数原样念回来 */
const STUB_RUNNER = [
  '#!/bin/sh',
  `printf 'RUNNER=%s\\nNODE=%s\\nARG1=%s\\nARG2=%s\\n' "$0" "\${ELECTRON_RUN_AS_NODE:-}" "$1" "$2"`,
].join('\n')

const launcherDirs: string[] = []

/**
 * packaged = …/Fake.app/Contents/{MacOS,Resources/bin}，app.asar 用普通文件当替身（启动器只问它在不在，
 * 进罐子是 Electron 的事）；repo = 仓库根 + devDependencies 那份 electron，也就是 dev 验收走的那一支。
 * 两份布局里放的 bin/vv 都是仓库这一份拷过去的，所以判的是真脚本。
 */
async function layOut(kind: 'packaged' | 'repo', opts: { jar?: boolean } = {}): Promise<string> {
  const sandbox = await mkdtemp(join(tmpdir(), 'vv-launcher-'))
  launcherDirs.push(sandbox)
  const contents = join(sandbox, 'Fake.app', 'Contents')
  const vv = kind === 'packaged' ? join(contents, 'Resources', 'bin', 'vv') : join(sandbox, 'bin', 'vv')
  await mkdir(dirname(vv), { recursive: true })
  await copyFile(join(process.cwd(), 'bin/vv'), vv)
  if (kind === 'packaged') {
    await mkdir(join(contents, 'MacOS'), { recursive: true })
    await writeFile(join(contents, 'MacOS', 'Vv Transcribe'), STUB_RUNNER, { mode: 0o755 })
    if (opts.jar !== false) await writeFile(join(contents, 'Resources', 'app.asar'), '不是真 asar', 'utf-8')
  } else {
    await mkdir(join(sandbox, 'node_modules', '.bin'), { recursive: true })
    await mkdir(join(sandbox, 'dist-electron', 'cli'), { recursive: true })
    await writeFile(join(sandbox, 'node_modules', '.bin', 'electron'), STUB_RUNNER, { mode: 0o755 })
    await writeFile(join(sandbox, 'dist-electron', 'cli', 'vv.mjs'), 'export {}', 'utf-8')
  }
  return vv
}

/** 用 /bin/sh 起那份真脚本；路径只对尾巴，因为 cd -P 会把 /var 解成 /private/var，前缀是环境不是算术 */
function spawnLauncher(vv: string, args: string[]) {
  const res = spawnSync('/bin/sh', [vv, ...args], { encoding: 'utf-8' })
  const stdout = res.stdout ?? ''
  return {
    code: res.status,
    stderr: res.stderr ?? '',
    said(key: string) {
      const line = stdout.split('\n').find((row) => row.startsWith(`${key}=`))
      expect(line, `替身 Electron 没念回 ${key}；stdout=${JSON.stringify(stdout)} stderr=${res.stderr}`).toBeDefined()
      return line as string
    },
  }
}

describe('bin/vv 的路径算术：假包布局真跑一遍', () => {
  afterAll(async () => {
    for (const dir of launcherDirs) await rm(dir, { recursive: true, force: true })
  })

  /** 第一次翻车：拿 Resources 当 Contents，于是去找 Resources/MacOS/Vv Transcribe，报「找不到运行时」退 127 */
  it.skipIf(!POSIX)('打包版：bin 往上两级才是 Contents，entry 落在 asar 里面', async () => {
    const res = spawnLauncher(await layOut('packaged'), ['--version'])
    expect(res.code, res.stderr).toBe(0)
    expect(res.said('RUNNER')).toMatch(/Fake\.app\/Contents\/MacOS\/Vv Transcribe$/)
    expect(res.said('NODE')).toBe('NODE=1')
    expect(res.said('ARG1')).toMatch(/Fake\.app\/Contents\/Resources\/app\.asar\/dist-electron\/cli\/vv\.mjs$/)
    expect(res.said('ARG2')).toBe('ARG2=--version')
  })

  /** 第二次翻车：守卫拿 -f 探 asar 里面的路径，真 fs 看不见罐内 → 明明能跑也说 127。反过来罐子真没了得说话 */
  it.skipIf(!POSIX)('打包版少了 app.asar：一句「找不到运行时」+ 127，别把锅留给 Electron 的模块找不到', async () => {
    const res = spawnLauncher(await layOut('packaged', { jar: false }), ['--version'])
    expect(res.code).toBe(127)
    expect(res.stderr).toContain('找不到运行时')
  })

  it.skipIf(!POSIX)('仓库版（dev 验收那一条）：runner 用 devDependencies 那份 electron，entry 用构建产物', async () => {
    const res = spawnLauncher(await layOut('repo'), ['transcribe', '采访.mp4', '-o', '采访.srt'])
    expect(res.code, res.stderr).toBe(0)
    expect(res.said('RUNNER')).toMatch(/\/node_modules\/\.bin\/electron$/)
    expect(res.said('NODE')).toBe('NODE=1')
    expect(res.said('ARG1')).toMatch(/\/dist-electron\/cli\/vv\.mjs$/)
    // 参数得原样传下去，业务话术只在 vv.mjs 里写一遍
    expect(res.said('ARG2')).toBe('ARG2=transcribe')
  })

  /** #374 那条说法这次不靠读注释了：链到别处再跑，找到的还是同一罐 asar */
  it.skipIf(!POSIX)('经符号链接调用（Homebrew cask 那种）：解完链接仍指向包里的 asar', async () => {
    const vv = await layOut('packaged')
    const link = join(dirname(vv), 'vv-linked')
    await symlink(vv, link)
    const res = spawnLauncher(link, ['--version'])
    expect(res.code, res.stderr).toBe(0)
    expect(res.said('ARG1')).toMatch(/Fake\.app\/Contents\/Resources\/app\.asar\/dist-electron\/cli\/vv\.mjs$/)
  })
})

/**
 * 启动器解的是自己的链接，可它交给 Electron 的那个 entry 路径不一定还能对上 `import.meta.url`——
 * 打包形态实测就栽在这儿：拿 /tmp/…（macOS 上 /tmp 是 /private/tmp 的软链）去起 vv.mjs，
 * ESM 那边永远是 realpath 过的那一份，两边比不出相等，于是那个文件「不报错、不输出、退 0」。
 * 一个装完什么也没干的 CLI 比一句报错难查得多，所以这一层判定单独钉。
 */
const entryDirs: string[] = []

describe('vv 的入口判定：软链路径也算入口', () => {
  afterAll(async () => {
    for (const dir of entryDirs) await rm(dir, { recursive: true, force: true })
  })

  it('打包版那条本来就在字面上对得上（应用名带空格也一样）', () => {
    const self = '/Applications/Vv Transcribe.app/Contents/Resources/app.asar/dist-electron/cli/vv.mjs'
    expect(entryMatches(self, self)).toBe(true)
  })

  it.skipIf(!POSIX)('argv 那一路过的是软链：realpath 兜一层，别把它判成「不是入口」', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'vv-entry-'))
    entryDirs.push(sandbox)
    const real = join(sandbox, 'real', 'vv.mjs')
    await mkdir(dirname(real), { recursive: true })
    await writeFile(real, 'export {}', 'utf-8')
    const link = join(sandbox, 'vv-link.mjs')
    await symlink(real, link)
    expect(realpathSync(link)).not.toBe(link) // 前提：这条路径真是软链，不然下一条没测到东西
    // 左边的 link 就是 argv[1] 那一路来的，右边是 Node 交给 import.meta.url 的那一份
    expect(entryMatches(link, realpathSync(link))).toBe(true)
  })

  it('argv 空着 / 文件根本不存在：退 false 就够，不许把异常抛出去', () => {
    expect(entryMatches(undefined, '/x/vv.mjs')).toBe(false)
    expect(entryMatches('/no/such/vv.mjs', '/x/vv.mjs')).toBe(false)
  })
})

// ---------------------------------------------------------------- ⑤ 真 socket 契约

const dirs = { root: '' }

describe('vv ↔ 门面：一次真 HTTP 往返', () => {
  afterAll(async () => {
    if (dirs.root) await rm(dirs.root, { recursive: true, force: true })
  })

  it('真 fetch + 真凭据文件：落盘那份字节与界面导出一致；token 过期就退 3', async () => {
    dirs.root = await mkdtemp(join(tmpdir(), 'vv-cli-contract-'))
    const source = join(dirs.root, '采访.mp4')
    await writeFile(source, 'fake media bytes', 'utf-8')

    /**
     * 这份目录是 CLI 默认会去找的那一个（`userDataDirFor` 按 home 拼出来的），
     * 门面在真应用里写的是 `app.getPath('userData')`——两边同一个算法才有这一跑。
     * 这里故意不传 --data-dir，测的就是「默认那条路能走通」。
     */
    const formulaDir = userDataDirFor(process.platform, dirs.root, {})
    await mkdir(formulaDir, { recursive: true })

    const job: TranscribeJobResult = { jobId: 'job-1', success: true, segments: RAW, provider: 'local' }
    const deps: FacadeDeps = {
      token: TOKEN,
      version: '1.2.0-test',
      engineReady: () => true,
      startJob: async (_filePath, _options, onProgress) => {
        onProgress({ jobId: 'job-1', progress: 5, stage: 'loading_model', model: { tier: 'base', weightsMb: 14 } })
        onProgress({ jobId: 'job-1', progress: 30, segment: RAW[0] })
        onProgress({ jobId: 'job-1', progress: 55, segment: RAW[1] })
        return job
      },
      cancelJob: async () => ({ ok: true, error: null }),
    }
    const handler = createFacadeHandler(deps)
    const server = createServer((req, res) => handler(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const target = join(dirs.root, '采访.srt')

    const err: string[] = []
    const io: CliIo = {
      fetch,
      readEndpoint: readAgentEndpoint,
      writeText: async (path, text) => writeFile(path, text, 'utf-8'),
      readText: (path) => readFile(path, 'utf-8'),
      accessFile: (path) => access(path),
      // 真 fetch 之外不掺假：这一支唯一假装的东西是那台「应用」，而它是真监听
      stdout: () => {
        throw new Error('给了 -o 就不该往 stdout 写')
      },
      stderr: (chunk) => {
        err.push(chunk)
      },
      cwd: dirs.root,
      platform: process.platform,
      home: dirs.root,
      env: {},
      version: () => '1.2.0-test',
      signal: new AbortController().signal,
      onJobId: () => {},
    }

    try {
      await writeAgentEndpoint(formulaDir, { port, token: TOKEN })
      const code = await run(['transcribe', source, '-o', target], io)
      expect(code, err.join(' | ')).toBe(0)
      expect(readFileSync(target, 'utf-8')).toBe(exportTranscript(UI_SEGMENTS, 'srt'))
      expect(err.join('')).toContain('第 2 段出来了')

      // 换一份目录、用 --data-dir 指过去：连的是哪一份实例全靠这一条，起了第二个 userData 目录（比如
      // `--user-data-dir` 隔离出来的那份）时，凭据就在那一边，而不在默认目录里
      const otherDir = join(dirs.root, 'dev-style')
      await mkdir(otherDir, { recursive: true })
      await writeAgentEndpoint(otherDir, { port, token: TOKEN })
      const viaFlag: string[] = []
      const code2 = await run(['transcribe', source, '--data-dir', otherDir, '-o', join(dirs.root, 'b.srt')], {
        ...io,
        stderr: (chunk) => viaFlag.push(chunk),
      })
      expect(code2, viaFlag.join(' | ')).toBe(0)

      // 同一趟，凭据换成上一次运行留下的那个：门面的 401 得走到 3，而不是被当成「作业失败」
      await writeAgentEndpoint(formulaDir, { port, token: 'stale-token-from-last-run' })
      const stale: string[] = []
      expect(
        await run(['transcribe', source, '-o', join(dirs.root, 'x.srt')], {
          ...io,
          stderr: (chunk) => stale.push(chunk),
        })
      ).toBe(3)
      expect(stale.join('')).toContain('token 对不上')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

// ---------------------------------------------------------------- ⑥ check（#356）

/** 两条都合规（vv-default 与 broadcast-cn 都不越线）的干净稿：落点全在整秒上，帧格那条给了 --fps 也不出提示 */
const CLEAN_SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,000',
  '第一句台词',
  '',
  '2',
  '00:00:04,000 --> 00:00:06,000',
  '第二句台词',
  '',
].join('\n')

/** 结束比开始还早：播放器对这一条的处理各家不同，总之不是「照原样上屏」 */
const FLIPPED_SRT = ['1', '00:00:05,000 --> 00:00:03,000', '这一条时间倒挂了', ''].join('\n')

/**
 * check 只读文件，所以这里给一张内存文件表，路径按尾巴匹配（harness 的 cwd 是 /work，
 * 于是 `check 采访.srt` 展开成 /work/采访.srt，命中的是键 '采访.srt'）。
 * accessFile 一起按这张表判：读不到的文件在 CLI 里要说得出「这个文件读不到」。
 */
function checkHarness(files: Record<string, string>, overrides: Partial<CliIo> = {}): Harness {
  const has = (path: string): boolean =>
    Object.keys(files).some((name) => path === name || path.endsWith(`/${name}`))
  return makeHarness([], {
    readText: async (path) => {
      const hit = Object.keys(files).find((name) => path === name || path.endsWith(`/${name}`))
      if (hit === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
      return files[hit] as string
    },
    accessFile: async (path) => {
      if (!has(path)) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
    },
    ...overrides,
  })
}

/** 一份能装载的档位（从内置那份拷出来改），用来证明「--preset 指的文件真的过了同一道闸」 */
function presetCopy(): SubtitlePreset {
  const loaded = builtinPreset('broadcast-cn')
  if (!loaded.ok) throw new Error(`内置档位自己装载不了：${loaded.errors.join('；')}`)
  return structuredClone(loaded.preset)
}

describe('vv check：本地判一份文件，不碰门面', () => {
  it('一份干净的 SRT：报告整份走 stdout、stderr 一个字都不沾、退 0', async () => {
    const h = checkHarness({ '采访.srt': CLEAN_SRT })
    expect(await run(['check', '采访.srt'], h.io)).toBe(0)
    expect(h.out.join('')).toContain('2 条字幕')
    expect(h.out.join('')).toContain('本应用默认档')
    expect(h.err).toHaveLength(0)
  })

  /** #356 的硬约束：check 不接 HTTP。发一次请求就算跑偏——它得在应用没开时也能跑 */
  it('判一份文件不发一个请求、不读凭据', async () => {
    const h = checkHarness(
      { '采访.srt': CLEAN_SRT },
      {
        fetch: (() => {
          throw new Error('check 不许发请求')
        }) as typeof fetch,
        readEndpoint: async () => {
          throw new Error('check 不许读凭据')
        },
      },
    )
    expect(await run(['check', '采访.srt', '--preset', 'broadcast-cn'], h.io)).toBe(0)
    expect(h.calls).toHaveLength(0)
  })

  it('时间倒挂＝错误级：退 1，并把文件里那一行原文念回来', async () => {
    const h = checkHarness({ 'bad.srt': FLIPPED_SRT })
    expect(await run(['check', 'bad.srt'], h.io)).toBe(1)
    const text = h.out.join('')
    expect(text).toContain('错误')
    expect(text).toContain('00:00:05,000 --> 00:00:03,000')
    expect(text).toContain('有错误，这一趟拦路（退出码 1）')
  })

  /** 「不是字幕的一份文本」和「一份有问题的字幕」是两种事，但都归错误级：不能假装判过 */
  it('喂进去的根本不是字幕：照样给结论并退 1', async () => {
    const h = checkHarness({ 'note.txt': '这只是一段笔记，没有时间行\n' })
    expect(await run(['check', 'note.txt'], h.io)).toBe(1)
    expect(h.out.join('')).toContain('没有一行是时间戳')
  })

  it('文件不在 → 2 并说「这个文件读不到」，不许拖到判定里出个空报告', async () => {
    const h = checkHarness({ '采访.srt': CLEAN_SRT })
    expect(await run(['check', '没有这个.srt'], h.io)).toBe(2)
    expect(said(h)).toContain('这个文件读不到')
    expect(h.out).toHaveLength(0)
  })

  it('--json 出的是报告自己：阈值连各自的出处一起给，stdout 仍然只有这一份', async () => {
    const h = checkHarness({ '采访.srt': CLEAN_SRT })
    expect(await run(['check', '采访.srt', '--preset', 'broadcast-cn', '--json'], h.io)).toBe(0)
    const report = JSON.parse(h.out.join('')) as CheckReport
    expect(report.preset.id).toBe('broadcast-cn')
    expect(report.exitCode).toBe(0)
    expect(report.summary.error).toBe(0)
    // agent 那一侧要能自己查依据，所以出处不能只活在给人看的那份排版里
    expect(report.preset.rules.charsPerLine.cite.length).toBeGreaterThan(0)
    expect(report.preset.rules.charsPerLine.source.length).toBeGreaterThan(0)
    expect(h.err).toHaveLength(0)
  })

  it('--preset 指的文件读不到 → 2，并给出内置那三个名字作为出路', async () => {
    const h = checkHarness({ '采访.srt': CLEAN_SRT })
    expect(await run(['check', '采访.srt', '--preset', './我的档位.json'], h.io)).toBe(2)
    expect(said(h)).toContain('档位文件读不了')
    expect(said(h)).toContain('broadcast-cn')
  })

  /** 这条是「手改那份 JSON 不许绕过纪律」在 CLI 那侧的落点：少一条规则就装载不了，而不是生成一份少判一条的报告 */
  it('自己那份档位少写一条规则就拒掉，并点名缺哪条', async () => {
    const broken = presetCopy()
    delete (broken.rules as Record<string, unknown>).readingSpeed
    const h = checkHarness({ '采访.srt': CLEAN_SRT, '缺一条.json': JSON.stringify(broken) })
    expect(await run(['check', '采访.srt', '--preset', '缺一条.json'], h.io)).toBe(2)
    expect(said(h)).toContain('少了「readingSpeed」')
    expect(said(h)).toContain('别整条删掉')
    expect(h.out).toHaveLength(0)
  })

  it('自己那份档位能装载时，报告里的档位就是它（不是内置那三个之一）', async () => {
    const mine = presetCopy()
    mine.id = 'my-kids'
    mine.title = '少儿节目档'
    mine.rules.charsPerLine.max = 14
    const h = checkHarness({ '采访.srt': CLEAN_SRT, '我的档位.json': JSON.stringify(mine) })
    expect(await run(['check', '采访.srt', '--preset', '我的档位.json'], h.io)).toBe(0)
    expect(h.out.join('')).toContain('少儿节目档（my-kids）')
    expect(h.out.join('')).toContain('上限 14 字')
  })

  /** SRT 里没有帧率：不给 --fps 这条只能挂在「未判」上，给了它才真跑（帧率可以是 23.976 那种非整数） */
  it('帧格那条：不给 --fps 就写在「未判」里，给了就跑起来', async () => {
    const off = checkHarness({ '采访.srt': CLEAN_SRT })
    expect(await run(['check', '采访.srt', '--preset', 'broadcast-cn'], off.io)).toBe(0)
    expect(off.out.join('')).toContain('没给 --fps')
    expect(off.out.join('')).not.toContain('帧率 25 fps')

    const on = checkHarness({ '采访.srt': CLEAN_SRT })
    expect(await run(['check', '采访.srt', '--preset', 'broadcast-cn', '--fps', '25'], on.io)).toBe(0)
    expect(on.out.join('')).toContain('帧率 25 fps')
    expect(on.out.join('')).not.toContain('没给 --fps')
  })

  it('默认那档（vv-default）只出提示不拦路：同一份越线稿退 0', async () => {
    // 每行 20 字：超了 broadcast-cn 的 15 字，但在 vv-default 那档是 info
    const long = ['1', '00:00:01,000 --> 00:00:04,000', '这一行台词有二十个字左右所以超了广电那一档', ''].join('\n')
    const strict = checkHarness({ 'a.srt': long })
    expect(await run(['check', 'a.srt', '--preset', 'broadcast-cn'], strict.io)).toBe(1)
    const loose = checkHarness({ 'a.srt': long })
    expect(await run(['check', 'a.srt'], loose.io)).toBe(0)
    expect(loose.out.join('')).toContain('提示')
  })

  /** 报告里印的是用户敲的那个路径（不是展开后的绝对路径）：这一份是要贴回工单/邮件的 */
  it('报告抬头念的是命令行里那个路径', async () => {
    const h = checkHarness({ '采访.srt': CLEAN_SRT })
    expect(await run(['check', '采访.srt', '--json'], h.io)).toBe(0)
    const text = h.out.join('')
    expect(text.startsWith('{\n')).toBe(true)
    const h2 = checkHarness({ '采访.srt': CLEAN_SRT })
    expect(await run(['check', '采访.srt'], h2.io)).toBe(0)
    expect(h2.out.join('').split('\n')[0]).toBe('校验 采访.srt：SRT，2 条字幕')
  })
})

// ---------------------------------------------------------------- ⑦ mcp（#356）

type RpcReply = {
  jsonrpc: string
  id: string | number | null
  result?: {
    protocolVersion?: string
    serverInfo?: { name: string; version: string }
    capabilities?: Record<string, unknown>
    tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[]
    content?: { type: string; text: string }[]
    isError?: boolean
  }
  error?: { code: number; message: string }
}

const rpc = (method: string, params?: unknown, id: number | string = 1): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })

/** 一条请求进、解析过的回话出；通知走到这条就该炸（它不该有回话） */
async function ask(h: Harness, text: string): Promise<RpcReply> {
  const reply = await handleMcpLine(text, { io: h.io })
  if (reply === null) throw new Error(`这条该有回话：${text}`)
  expect(reply.includes('\n'), '一行回话里不许有换行：那会把客户端的读行器切成两半').toBe(false)
  return JSON.parse(reply) as RpcReply
}

const toolBody = (r: RpcReply): string => (r.result?.content ?? []).map((c) => c.text).join('')

describe('vv mcp：三把 tool 的壳', () => {
  it('mcp 那条 argv 只留 --data-dir：它一把文件都不收，参数全在 tools/call 里', () => {
    const plain = parseArgv(['mcp'])
    if (!plain.ok) throw new Error(plain.message)
    expect(plain.args.command).toBe('mcp')
    const withDir = parseArgv(['mcp', '--data-dir', '/tmp/应用数据'])
    if (!withDir.ok) throw new Error(withDir.message)
    expect(withDir.args.dataDir).toBe('/tmp/应用数据')
    for (const argv of [['mcp', 'a.srt'], ['mcp', '--preset', 'broadcast-cn'], ['mcp', '-f', 'vtt'], ['mcp', '--json']]) {
      expect(parseArgv(argv).ok, argv.join(' ')).toBe(false)
    }
  })

  /** 客户端报的版本支持就原样回，不支持就回自己最新那一版；serverInfo 的版本号是传进来的那个 */
  it('initialize：认得客户端的版本，回话里有那三把 tool 的能力', async () => {
    const h = checkHarness({})
    const known = await ask(h, rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {} }))
    expect(known.result?.protocolVersion).toBe('2025-03-26')
    const unknown = await ask(h, rpc('initialize', { protocolVersion: '2999-01-01' }, 2))
    expect(unknown.result?.protocolVersion).toBe('2025-06-18')
    expect(unknown.result?.serverInfo).toEqual({ name: 'vv', version: '1.2.0-test' })
    expect(Object.keys(unknown.result?.capabilities ?? {})).toEqual(['tools'])
  })

  /** 通知没有 id，按协议不许回话：回了客户端会当成串位，整条链接就断了 */
  it('通知不回话，ping 与 tools/list 回', async () => {
    const h = checkHarness({})
    expect(await handleMcpLine('{"jsonrpc":"2.0","method":"notifications/initialized"}', { io: h.io })).toBeNull()
    expect(await handleMcpLine('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{}}', { io: h.io })).toBeNull()
    expect((await ask(h, rpc('ping'))).result).toEqual({})
    const listed = await ask(h, rpc('tools/list'))
    expect(listed.result?.tools).toEqual(toolSpecs())
    expect((listed.result?.tools ?? []).map((t) => t.name)).toEqual([...TOOL_NAMES])
    for (const tool of listed.result?.tools ?? []) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20)
      expect(Array.isArray(tool.inputSchema.required), tool.name).toBe(true)
    }
  })

  it('坏 JSON、批量、没 method、不认得的方法：四种都是回话里说清，而不是把服务弄挂', async () => {
    const h = checkHarness({})
    expect((await ask(h, '{ 这不是 JSON')).error?.code).toBe(-32700)
    expect((await ask(h, '[{"jsonrpc":"2.0","id":1,"method":"ping"}]')).error?.code).toBe(-32600)
    expect((await ask(h, '{"jsonrpc":"2.0","id":7}')).error?.code).toBe(-32600)
    const nope = await ask(h, rpc('tools/list2'))
    expect(nope.error?.code).toBe(-32601)
    expect(nope.error?.message).toContain('tools/call')
    expect((await ask(h, rpc('tools/call', { arguments: {} }))).error?.code).toBe(-32602)
    const noTool = await ask(h, rpc('tools/call', { name: 'translate', arguments: {} }))
    expect(noTool.error?.message).toContain('transcribe / check / export')
  })

  /** 壳里不自己拼 SRT：export 那把的产物必须与界面那一次 exportTranscript 逐字节相同 */
  it('export：与界面导出逐字节相同；坏的那一段点名到第几项', async () => {
    const h = checkHarness({})
    const reply = await ask(h, rpc('tools/call', { name: 'export', arguments: { segments: RAW, format: 'srt' } }))
    expect(toolBody(reply)).toBe(exportTranscript(UI_SEGMENTS, 'srt'))
    expect(reply.result?.isError).toBeUndefined()
    const badRow = await ask(
      h,
      rpc('tools/call', { name: 'export', arguments: { segments: [{ startTime: 0, endTime: 1, text: '好' }, { startTime: 0, text: '缺了结束' }] } }),
    )
    expect(badRow.error?.code).toBe(-32602)
    expect(badRow.error?.message).toContain('第 2 项')
    const empty = await ask(h, rpc('tools/call', { name: 'export', arguments: { segments: [] } }))
    expect(empty.error?.message).toContain('空数组')
    const badFormat = await ask(h, rpc('tools/call', { name: 'export', arguments: { segments: RAW, format: 'xml' } }))
    expect(badFormat.error?.message).toContain('srt / vtt')
  })

  /**
   * 两条硬约束合在一条测里：transcribe 那把**只**把活交给 run()（所以真发两发请求、读一次凭据），
   * 而 check 那把**一件都不**发给网络。反过来说，谁哪天在 mcp 段里直接写 fetch()，这两条都会红。
   */
  it('transcribe 转给门面（两发请求）；check 一发都不发，回来的是整份报告', async () => {
    const t = makeHarness([okAccept, okStream([RESULT_LINE])])
    const transcribed = await ask(t, rpc('tools/call', { name: 'transcribe', arguments: { file: '/素材/a.mp4' } }))
    expect(toolBody(transcribed)).toBe(exportTranscript(UI_SEGMENTS, 'srt'))
    expect(t.calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:41234/jobs/transcribe',
      'http://127.0.0.1:41234/jobs/job-1',
    ])

    const c = checkHarness({ '采访.srt': CLEAN_SRT })
    const checked = await ask(c, rpc('tools/call', { name: 'check', arguments: { file: '采访.srt' } }))
    const report = JSON.parse(toolBody(checked)) as CheckReport
    expect(report.preset.id).toBe('vv-default')
    expect(report.exitCode).toBe(0)
    expect(c.calls).toHaveLength(0)
    // 客户端那头的 stdout 只可能由 runMcp 写：工具产物一律走回话，漏进通道就等于把协议打断
    expect(c.out).toHaveLength(0)
  })

  /** 判出红是一份判完了的报告，不是这一把失败了：isError 一置，客户端就不把正文给模型，那 300 条就白判了 */
  it('check 判出 error 级：不是 isError，红在报告的 exitCode 里；报告一条不少', async () => {
    const h = checkHarness({ 'bad.srt': FLIPPED_SRT })
    const reply = await ask(h, rpc('tools/call', { name: 'check', arguments: { file: 'bad.srt', preset: 'broadcast-cn' } }))
    expect(reply.result?.isError).toBeUndefined()
    const report = JSON.parse(toolBody(reply)) as CheckReport
    expect(report.exitCode).toBe(1)
    expect(report.findings.some((f) => f.level === 'error')).toBe(true)
  })

  it('应用没开：那句「没有 agent-api.json」原样进结果并标 isError，不报成参数不对', async () => {
    const h = makeHarness([], { readEndpoint: async () => ({ status: 'missing' }) })
    const reply = await ask(h, rpc('tools/call', { name: 'transcribe', arguments: { file: '/素材/a.mp4' } }))
    expect(reply.error).toBeUndefined()
    expect(reply.result?.isError).toBe(true)
    expect(toolBody(reply)).toContain('agentApi')
  })

  it('档位名与 fps 在壳这层就拒，并把命令行那句话原样递出来', async () => {
    const h = checkHarness({ '采访.srt': CLEAN_SRT })
    const preset = await ask(h, rpc('tools/call', { name: 'check', arguments: { file: '采访.srt', preset: 'nope' } }))
    expect(preset.result?.isError).toBe(true)
    expect(toolBody(preset)).toContain('内置档位只有')
    const fps = await ask(h, rpc('tools/call', { name: 'check', arguments: { file: '采访.srt', fps: 0 } }))
    expect(fps.error?.message).toContain('大于 0')
  })

  /**
   * mcp 这一段离「自己实现一遍」最近：三把 tool 各自伸手就能拿到 fetch、凭据和导出器。
   * 扫源码是因为行为测不出「今天还没坏、但已经绕开 run()」——绕开一次，门面那套 token 与
   * 凭据规则就在 CLI 里长了第二份，而 #356 对外承诺的只有「与终端同一个结论」那一句。
   */
  it('mcp 段只转给那两条子命令：这一段里没有 fetch、没有端口字面量、没有自己拼的时间轴', () => {
    const raw = readFileSync(join(process.cwd(), 'electron/cli/vv.ts'), 'utf-8')
    const from = raw.indexOf('// ——— mcp：三把 tool 的壳')
    const to = raw.indexOf('/** 一行 NDJSON；半截或不是 JSON 就报一句', from)
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    const body = raw
      .slice(from, to)
      .split('\n')
      .filter((row) => !/^\s*(\/\/|\*|\/\*)/.test(row))
      .join('\n')
    expect(body).not.toMatch(/fetch\(/)
    expect(body).not.toMatch(/127\.0\.0\.1|agent-api|Bearer/)
    expect(body.match(/-->/)).toBeNull()
    expect(body.match(/await throughRun\(/g)?.length).toBe(2)
    expect(body).toMatch(/exportTranscript\(/)
  })
})

