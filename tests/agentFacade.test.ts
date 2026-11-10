/**
 * #376 门面那一层的判据。分四块，每块钉的都是「换个人写就会悄悄改掉」的那几件事：
 *
 * ① **开关**：`normalizeAgentApi` 的失败方向必须是「不监听」（这一项认不出来的代价是多开一个端口，
 *    而多开一个端口不会有人来报告）；`agentApi` / `authStatus` 这类字段名不许撞 `logRedact` 那张表，
 *    否则「到底有没有 token」这句唯一的诊断会被整值隐掉。
 * ② **目录公式**：主进程用 `app.getPath`、CLI 在 ELECTRON_RUN_AS_NODE 里只能用自己的公式
 *    （#374 实测那条 `require('electron')` 会抛）。两边算出不同的目录，症状是
 *    「开关明明打开了却连不上」，所以这份公式必须是纯函数、且被钉住。
 * ③ **端点契约**：四个端点的状态码、NDJSON 的行序、以及「除 /health 外都要 Bearer」。
 * ④ **落盘**：0600、随运行结束消失、写不下去就不监听。外加一条「token 明文进不了日志」的行为判据
 *    （把真启动跑一遍，再把所有 logger 调用序列化后找那个串）。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../electron/main/services/settingsService'

const calls = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  startJob: vi.fn(),
  cancelJob: vi.fn(),
  engineReady: vi.fn(),
  log: vi.fn(),
}))

/**
 * 真启动那几测的 userData：每个用例一份 mkdtemp，`agentEndpoint` 因此**不 mock**——
 * 这一层最要命的三件事（0600、随运行结束消失、写不下去就不监听）只有在真磁盘上才算测过。
 */
const dirs = vi.hoisted(() => ({ userData: '/tmp/vv-facade-test' }))

vi.mock('../electron/main/services/settingsService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../electron/main/services/settingsService')>()),
  loadSettings: calls.loadSettings,
}))
vi.mock('../electron/main/services/userDataStore', () => ({
  userDataRoot: () => dirs.userData,
  logsDir: () => join(dirs.userData, 'logs'),
}))
vi.mock('../electron/main/services/asrServiceManager', () => ({
  getASRServiceStatus: () => ({ ready: calls.engineReady() }),
}))
vi.mock('../electron/main/services/transcribeJob', () => ({
  startTranscribeJob: calls.startJob,
  cancelTranscribeJob: calls.cancelJob,
}))
vi.mock('../electron/main/services/logger', () => ({
  logger: {
    info: calls.log,
    warn: calls.log,
    error: calls.log,
    debug: calls.log,
    serviceCall: calls.log,
    serviceError: calls.log,
  },
}))

import {
  AGENT_ENDPOINT_FILE_NAME,
  agentEndpointFile,
  clearAgentEndpoint,
  readAgentEndpoint,
  writeAgentEndpoint,
} from '../electron/main/services/agentEndpoint'
import {
  createFacadeHandler,
  startAgentFacade,
  stopAgentFacade,
  type FacadeDeps,
  type FacadeRequest,
  type FacadeResponse,
} from '../electron/main/services/agentFacade'
import { normalizeAgentApi } from '../electron/main/services/settingsService'
import { isSensitiveKey } from '../electron/main/services/logRedact'
import { APP_DATA_DIR_NAME, userDataDirFor } from '../electron/main/services/userDataDir'
import type { TranscribeJobResult, TranscribeProgressEvent, TranscribeProgressSink } from '../electron/main/services/transcribeJob'

const TOKEN = 'unit-test-token-0123456789abcdef'
const SEGMENT = { startTime: 1, endTime: 2, text: '第一句' }

/** 假 req 只实现 handler 用到的那几个成员；`on` 那两个重载由一次 cast 收口 */
function makeReq(opts: {
  method: string
  url: string
  authorization?: string | string[] | null
}): { req: FacadeRequest; fire: (event: 'data' | 'end', arg?: unknown) => void } {
  const handlers = new Map<string, ((arg?: unknown) => void)[]>()
  const req: Record<string, unknown> = {
    method: opts.method,
    url: opts.url,
    headers: opts.authorization === null ? {} : { authorization: opts.authorization ?? undefined },
    on: (event: string, listener: (arg?: unknown) => void) => {
      const list = handlers.get(event) ?? []
      list.push(listener)
      handlers.set(event, list)
    },
  }
  return {
    req: req as unknown as FacadeRequest,
    fire: (event, arg) => {
      for (const listener of handlers.get(event) ?? []) listener(arg)
    },
  }
}

class FakeRes {
  status = 0
  headers: Record<string, string> = {}
  private chunks: string[] = []
  ended = false
  readonly listeners = new Map<string, () => void>()

  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status
    this.headers = headers
  }
  write(chunk: string): void {
    this.chunks.push(chunk)
  }
  end(chunk?: string): void {
    if (chunk !== undefined) this.chunks.push(chunk)
    this.ended = true
  }
  on(event: string, listener: () => void): void {
    this.listeners.set(event, listener)
  }

  get text(): string {
    return this.chunks.join('')
  }
  get json(): Record<string, unknown> {
    return JSON.parse(this.text)
  }
  /** NDJSON：一行一个对象，空行丢掉 */
  get rows(): Record<string, unknown>[] {
    return this.text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }
}

/** 走一遍 handler：先发 req/res，再把请求体喂进去（readBody 的监听器在同步段里就已经挂上了） */
async function send(
  handler: (req: FacadeRequest, res: FacadeResponse) => void,
  opts: { method: string; url: string; authorization?: string | string[] | null; body?: string }
): Promise<FakeRes> {
  const res = new FakeRes()
  const { req, fire } = makeReq(opts)
  handler(req, res as unknown as FacadeResponse)
  if (opts.body !== undefined) {
    fire('data', Buffer.from(opts.body))
    fire('end')
  }
  await tick()
  return res
}

/** 让微任务与 setImmediate 都跑完：假作业里的 then 链靠这一步落地 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const okResult = (jobId: string): TranscribeJobResult => ({
  jobId,
  success: true,
  segments: [SEGMENT],
  provider: 'local',
})

const event = (jobId: string, progress: number): TranscribeProgressEvent => ({
  jobId,
  progress,
  segment: undefined,
  stage: undefined,
  model: undefined,
})

function depsWith(over: Partial<FacadeDeps> = {}): FacadeDeps {
  return {
    token: TOKEN,
    version: '1.2.0-test',
    engineReady: () => true,
    startJob: calls.startJob,
    cancelJob: calls.cancelJob,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.loadSettings.mockResolvedValue({ agentApi: 'on' } as unknown as AppSettings)
  calls.engineReady.mockReturnValue(true)
  calls.cancelJob.mockResolvedValue({ ok: true, error: null })
  calls.startJob.mockImplementation(async (_file: string, _o: unknown, sink: TranscribeProgressSink) => {
    sink(event('J1', 0))
    return okResult('J1')
  })
  // 一个不存在的目录：没开门面那些用例走到 clearAgentEndpoint 时应当一声不响
  dirs.userData = join(tmpdir(), 'vv-facade-not-created')
})

afterEach(async () => {
  // 真监听那两测会留下一个 server；不收回就会带着 token 活到下一个用例
  await stopAgentFacade()
})

describe('开关：认不出来就是不监听', () => {
  it('只有 on 是开；其余一律 off', () => {
    expect(normalizeAgentApi('on')).toBe('on')
    for (const raw of ['off', '', 'ON', 'true', true, 'require', undefined, null, 1, {}]) {
      expect(normalizeAgentApi(raw)).toBe('off')
    }
  })

  it('日志字段名不许撞脱敏那张表，撞了的那类要换个名字', () => {
    // 门面那行读数用的三个键：值必须是看得见的，否则「开了没开」这句在日志里读不出来
    expect(isSensitiveKey('agentApi')).toBe(false)
    expect(isSensitiveKey('authStatus')).toBe(false)
    expect(isSensitiveKey('port')).toBe(false)
    // 反面：这两个写法都会被 CREDENTIAL_KEY 整值隐掉，所以这一层不许用
    expect(isSensitiveKey('token')).toBe(true)
    expect(isSensitiveKey('tokenStatus')).toBe(true)
  })
})

describe('目录公式：主进程与 CLI 必须算出同一个目录', () => {
  const HOME = '/home/u'

  // 三条都按 join 拼期望值：这份公式用的就是 node:path 的 join，而它按平台决定分隔符。
  // 在 mac/linux 上跑 win32 那一支、在 Windows 上跑另两支，钉住的都只是「取哪个 base、拼哪几段」；
  // 真机分隔符只在各自平台上才算测过——这一条已经记进 #378 的遗留清单。
  it('darwin 走 Library/Application Support', () => {
    expect(userDataDirFor('darwin', HOME)).toBe(join(HOME, 'Library', 'Application Support', APP_DATA_DIR_NAME))
  })

  it('win32 用 APPDATA，没有才退回 Roaming', () => {
    expect(userDataDirFor('win32', HOME, { APPDATA: '/other/roaming' })).toBe(join('/other/roaming', APP_DATA_DIR_NAME))
    expect(userDataDirFor('win32', HOME, {})).toBe(join(HOME, 'AppData', 'Roaming', APP_DATA_DIR_NAME))
  })

  it('linux 认绝对路径的 XDG_CONFIG_HOME，相对值与空值都忽略', () => {
    expect(userDataDirFor('linux', HOME, { XDG_CONFIG_HOME: '/xdg' })).toBe(join('/xdg', APP_DATA_DIR_NAME))
    expect(userDataDirFor('linux', HOME, { XDG_CONFIG_HOME: 'relative/path' })).toBe(join(HOME, '.config', APP_DATA_DIR_NAME))
    expect(userDataDirFor('linux', HOME, {})).toBe(join(HOME, '.config', APP_DATA_DIR_NAME))
  })

  it('这份公式不许 import electron：CLI 在 ELECTRON_RUN_AS_NODE 里那条会抛', async () => {
    const source = code(await read('electron/main/services/userDataDir.ts'))
    expect(source).not.toMatch(/from 'electron'|require\('electron'\)|app\.getPath/)
  })

  it('目录名与打包产物、与主进程里的应用名同一个字串', async () => {
    const builder = await read('electron-builder.cjs')
    const index = await read('electron/main/index.ts')
    expect(APP_DATA_DIR_NAME).toBe('Vv Transcribe')
    expect(builder).toMatch(/productName:\s*'Vv Transcribe'/)
    expect(index).toMatch(/const APP_NAME = 'Vv Transcribe'/)
  })
})

describe('端点文件：唯一一处凭据落盘', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vv-agent-endpoint-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('写下去就是 0600，读回来是同一份 port + token', async () => {
    await writeAgentEndpoint(dir, { port: 43210, token: TOKEN })
    const info = await stat(agentEndpointFile(dir))
    // rename 带过去的是 tmp 的权限，所以这一条测的是「chmod 那步没省」
    expect(info.mode & 0o777).toBe(0o600)
    expect(await readAgentEndpoint(dir)).toStrictEqual({
      status: 'ok',
      endpoint: { port: 43210, token: TOKEN },
    })
  })

  it('文件名只有这一处定义，且不在 transcribe- 前缀那种临时目录里', () => {
    expect(AGENT_ENDPOINT_FILE_NAME).toBe('agent-api.json')
    expect(agentEndpointFile('/UserData')).toBe(join('/UserData', 'agent-api.json'))
  })

  it('没有文件＝没开，不是坏了', async () => {
    expect(await readAgentEndpoint(dir)).toStrictEqual({ status: 'missing' })
  })

  it('半截 JSON、类型不对、端口越界、token 太短或带空白都算读不懂', async () => {
    const file = agentEndpointFile(dir)
    const cases: string[] = [
      '{ "port": 123',
      '[]',
      '{"port":"8080","token":"aaaaaaaaaaaaaaaa"}',
      '{"port":0,"token":"aaaaaaaaaaaaaaaa"}',
      '{"port":70000,"token":"aaaaaaaaaaaaaaaa"}',
      '{"port":43210,"token":"short"}',
      '{"port":43210,"token":"has space inside"}',
    ]
    for (const content of cases) {
      await writeFile(file, content, 'utf-8')
      const got = await readAgentEndpoint(dir)
      expect(got.status).toBe('invalid')
      if (got.status === 'invalid') expect(got.reason).toBeTruthy()
    }
  })

  it('写失败不留 tmp 副本', async () => {
    await expect(writeAgentEndpoint(join(dir, '不存在的目录'), { port: 1, token: TOKEN })).rejects.toThrow()
    const leftover = await readFile(`${agentEndpointFile(join(dir, '不存在的目录'))}.tmp`, 'utf-8').catch(() => null)
    expect(leftover).toBeNull()
  })

  it('clear 在没有文件时也算成功（回 null，调用方不该为一声「本来就没有」报警）', async () => {
    expect(await clearAgentEndpoint(dir)).toBeNull()
    await writeAgentEndpoint(dir, { port: 1, token: TOKEN })
    expect(await clearAgentEndpoint(dir)).toBeNull()
    expect(await readAgentEndpoint(dir)).toStrictEqual({ status: 'missing' })
  })
})

describe('端点契约：四个端点与那道 Bearer', () => {
  let handler: ReturnType<typeof createFacadeHandler>

  beforeEach(() => {
    handler = createFacadeHandler(depsWith())
  })

  it('GET /health 免鉴权，且不因为 token 不对就变脸', async () => {
    for (const authorization of [null, `Bearer ${TOKEN}`, 'Bearer wrong', 'Basic zzz']) {
      const res = await send(handler, { method: 'GET', url: '/health', authorization })
      expect(res.status).toBe(200)
      expect(res.json).toStrictEqual({ ok: true, version: '1.2.0-test', engineReady: true })
    }
    // 查询串与尾斜杠都不影响这一条
    const res = await send(handler, { method: 'GET', url: '/health?ts=1', authorization: null })
    expect(res.status).toBe(200)
  })

  it('其余三个端点：没带 / 带错 / 不带 Bearer 前缀都是 401', async () => {
    for (const authorization of [null, 'Bearer nope', TOKEN, 'Basic '+TOKEN]) {
      const res = await send(handler, {
        method: 'POST',
        url: '/jobs/transcribe',
        authorization,
        body: JSON.stringify({ file: '/素材/采访.mp4' }),
      })
      expect(res.status).toBe(401)
      expect(calls.startJob).not.toHaveBeenCalled()
    }
  })

  it('POST /jobs/transcribe 走的是第一个进度事件那条路：202 + jobId，作业还在跑就已经答了', async () => {
    const settle = deferred<TranscribeJobResult>()
    calls.startJob.mockImplementation(async (_file: string, _o: unknown, sink: TranscribeProgressSink) => {
      sink(event('J9', 0))
      return settle.promise
    })
    const res = await send(handler, {
      method: 'POST',
      url: '/jobs/transcribe',
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({ file: '  /素材/采访.mp4  ', language: 'en', profileId: 'asr-mini' }),
    })
    expect(res.status).toBe(202)
    expect(res.json).toStrictEqual({ jobId: 'J9' })
    // file 去掉首尾空白，其余两样原样进 options；mediaSessionId 不是门面能给的
    expect(calls.startJob.mock.calls[0][0]).toBe('/素材/采访.mp4')
    expect(calls.startJob.mock.calls[0][1]).toStrictEqual({ language: 'en', profileId: 'asr-mini' })
    // 答完 202 时作业还挂着——「POST 不等作业跑完」这句的全部含义
    settle.resolve(okResult('J9'))
  })

  it('作业结算得太快、没来得及发进度时，202 从结算那一路拿编号', async () => {
    calls.startJob.mockImplementation(async () => okResult('J-settle-only'))
    const res = await send(handler, {
      method: 'POST',
      url: '/jobs/transcribe',
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({ file: '/a.mp4' }),
    })
    expect(res.status).toBe(202)
    expect(res.json).toStrictEqual({ jobId: 'J-settle-only' })
  })

  it('作业体自己抛了：POST 答 500 而不是永远挂着', async () => {
    calls.startJob.mockRejectedValue(new Error('作业体炸了'))
    const res = await send(handler, {
      method: 'POST',
      url: '/jobs/transcribe',
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({ file: '/a.mp4' }),
    })
    expect(res.status).toBe(500)
    expect(calls.log).toHaveBeenCalled()
  })

  it('请求体：空 / 不是 JSON / 不是对象 / 超大都拒，且不进作业', async () => {
    const cases: [string, number][] = [
      ['', 400],
      ['   ', 400],
      ['{', 400],
      ['[1,2]', 400],
      ['"一个字符串"', 400],
      [JSON.stringify({ file: 'x'.repeat(70 * 1024) }), 413],
    ]
    for (const [body, status] of cases) {
      const res = await send(handler, {
        method: 'POST',
        url: '/jobs/transcribe',
        authorization: `Bearer ${TOKEN}`,
        body,
      })
      expect(res.status).toBe(status)
      expect((res.json.error as string) || '').toBeTruthy()
    }
    expect(calls.startJob).not.toHaveBeenCalled()
  })

  it('入参：拼错的键、空 file、非字符串 language 都点名拒掉', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ filePath: '/a.mp4' }, 'filePath'],
      [{ file: '/a.mp4', mode: 'cloud' }, 'mode'],
      [{ file: '   ' }, 'file'],
      [{ file: '/a.mp4', language: 1 }, 'language'],
      [{ file: '/a.mp4', profileId: {} }, 'profileId'],
    ]
    for (const [body, named] of cases) {
      const res = await send(handler, {
        method: 'POST',
        url: '/jobs/transcribe',
        authorization: `Bearer ${TOKEN}`,
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(400)
      expect(res.json.error).toContain(named)
    }
    expect(calls.startJob).not.toHaveBeenCalled()
  })

  it('GET /jobs/:id 是 NDJSON：先补缓冲的行，再实时追，最后一行是 result', async () => {
    const settle = deferred<TranscribeJobResult>()
    let sink: TranscribeProgressSink = () => {}
    calls.startJob.mockImplementation(async (_file: string, _o: unknown, s: TranscribeProgressSink) => {
      sink = s
      s(event('J2', 0))
      s(event('J2', 5))
      return settle.promise
    })
    await send(handler, {
      method: 'POST',
      url: '/jobs/transcribe',
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({ file: '/a.mp4' }),
    })

    const res = await send(handler, { method: 'GET', url: '/jobs/J2', authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(200)
    expect(res.headers['Content-Type']).toContain('application/x-ndjson')
    expect(res.rows.map((r) => r.progress)).toEqual([0, 5])
    expect(res.rows.every((r) => r.type === 'progress')).toBe(true)
    expect(res.ended).toBe(false)
    // 断开的两条路都要收：close 是对面走了，error 是写到一个已经没了的流
    expect(res.listeners.has('close')).toBe(true)
    expect(res.listeners.has('error')).toBe(true)

    sink(event('J2', 52.5))
    expect(res.rows.map((r) => r.progress)).toEqual([0, 5, 52.5])

    settle.resolve(okResult('J2'))
    await tick()
    const last = res.rows[res.rows.length - 1]
    expect(last).toStrictEqual({ type: 'result', jobId: 'J2', success: true, segments: [SEGMENT], provider: 'local' })
    expect(res.ended).toBe(true)
  })

  it('跑完的那一单晚来也能补齐全部行；不认识的编号 404 并说清记不记得谁', async () => {
    await send(handler, {
      method: 'POST',
      url: '/jobs/transcribe',
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({ file: '/a.mp4' }),
    })
    const late = await send(handler, { method: 'GET', url: '/jobs/J1', authorization: `Bearer ${TOKEN}` })
    expect(late.status).toBe(200)
    expect(late.rows.map((row) => row.type)).toEqual(['progress', 'result'])
    expect(late.ended).toBe(true)

    const miss = await send(handler, { method: 'GET', url: '/jobs/nope', authorization: `Bearer ${TOKEN}` })
    expect(miss.status).toBe(404)
    expect(miss.json.error).toContain('nope')
  })

  it('取消只认门面自己启动的那单：界面启动的那单猜出 UUID 也打不断', async () => {
    await send(handler, {
      method: 'POST',
      url: '/jobs/transcribe',
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({ file: '/a.mp4' }),
    })
    const hit = await send(handler, {
      method: 'POST',
      url: '/jobs/J1/cancel',
      authorization: `Bearer ${TOKEN}`,
    })
    expect(hit.status).toBe(200)
    expect(hit.json).toStrictEqual({ ok: true, error: null, finished: true })
    expect(calls.cancelJob).toHaveBeenCalledWith('J1')

    const miss = await send(handler, {
      method: 'POST',
      url: '/jobs/界面那一单/cancel',
      authorization: `Bearer ${TOKEN}`,
    })
    expect(miss.status).toBe(404)
    expect(calls.cancelJob).toHaveBeenCalledTimes(1)
  })

  it('没有的端点回 404，并把有的四条念一遍', async () => {
    for (const url of ['/jobs', '/nope', '/jobs/J1/extra']) {
      const res = await send(handler, { method: 'GET', url, authorization: `Bearer ${TOKEN}` })
      expect(res.status).toBe(404)
    }
    const res = await send(handler, { method: 'GET', url: '/nope', authorization: `Bearer ${TOKEN}` })
    expect(res.json.error).toContain('GET /health')
  })

  it('两个 handler 实例各带一份会话表，不串状态', async () => {
    const other = createFacadeHandler(depsWith())
    await send(handler, {
      method: 'POST',
      url: '/jobs/transcribe',
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({ file: '/a.mp4' }),
    })
    const res = await send(other, { method: 'GET', url: '/jobs/J1', authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(404)
  })

  it('会话攒够 20 单就开始丢最老的：丢的是查询记录，不是素材', async () => {
    let seq = 0
    calls.startJob.mockImplementation(async (_file: string, _o: unknown, sink: TranscribeProgressSink) => {
      const jobId = `J${++seq}`
      sink(event(jobId, 0))
      return okResult(jobId)
    })
    for (let i = 0; i < 21; i++) {
      await send(handler, {
        method: 'POST',
        url: '/jobs/transcribe',
        authorization: `Bearer ${TOKEN}`,
        body: JSON.stringify({ file: '/a.mp4' }),
      })
    }
    const oldest = await send(handler, { method: 'GET', url: '/jobs/J1', authorization: `Bearer ${TOKEN}` })
    const newest = await send(handler, { method: 'GET', url: '/jobs/J21', authorization: `Bearer ${TOKEN}` })
    expect(oldest.status).toBe(404)
    expect(newest.status).toBe(200)
  })

  it('客户端中途走掉之后，那条流不会再被写', async () => {
    const settle = deferred<TranscribeJobResult>()
    let sink: TranscribeProgressSink = () => {}
    calls.startJob.mockImplementation(async (_file: string, _o: unknown, s: TranscribeProgressSink) => {
      sink = s
      s(event('J3', 0))
      return settle.promise
    })
    await send(handler, {
      method: 'POST',
      url: '/jobs/transcribe',
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({ file: '/a.mp4' }),
    })
    const res = await send(handler, { method: 'GET', url: '/jobs/J3', authorization: `Bearer ${TOKEN}` })
    const before = res.rows.length
    res.listeners.get('close')?.()
    sink(event('J3', 50))
    expect(res.rows.length).toBe(before)
    settle.resolve(okResult('J3'))
    await tick()
    expect(res.ended).toBe(false)
  })

  it('鉴权比对不许用 ===，且长度不等时不许把两个串交给 timingSafeEqual', async () => {
    const source = code(await read('electron/main/services/agentFacade.ts'))
    expect(source).toMatch(/timingSafeEqual/)
    expect(source).toMatch(/mine\.length === theirs\.length/)
  })
})

describe('真启动：开关、监听与凭据文件', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vv-facade-real-'))
    dirs.userData = dir
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** 从盘上读回来（走的是 CLI 那一侧同一个函数）：这一层唯一的事实来源就是这份文件 */
  const onDisk = async (): Promise<{ port: number; token: string } | null> => {
    const got = await readAgentEndpoint(dir)
    return got.status === 'ok' ? got.endpoint : null
  }

  it('开着时监听在 127.0.0.1 的随机端口上，端口与 token 一起落盘（0600），且明文进不了日志', async () => {
    const result = await startAgentFacade()
    expect(result.listening).toBe(true)
    expect(result.reason).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const endpoint = await onDisk()
    expect(endpoint).not.toBeNull()
    expect(endpoint!.port).toBe(Number(result.reason.split(':').pop()))
    expect(endpoint!.port).toBeGreaterThan(0)
    // 每次运行一份新的随机串：这一条钉的是「不许把一个 token 永久写在配置里」
    expect(endpoint!.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect((await stat(agentEndpointFile(dir))).mode & 0o777).toBe(0o600)
    // 产物不许落在 transcribe- 前缀那种临时目录里（那是清扫的靶子，也在 /tmp 而不是 userData）
    expect(dir).not.toContain('transcribe-')

    // 把每一条日志调用序列化后找那个串：比扫源码强，因为它测的是真的读数
    for (const call of calls.log.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(endpoint!.token)
      // 调用点自己就没交出整路径（脱敏那道闸门在 logger 里面，这里 mock 掉了）
      expect(JSON.stringify(call)).not.toContain(dir)
    }
    expect(calls.log).toHaveBeenCalledWith('AgentApi', 'Facade listening', { host: '127.0.0.1', port: endpoint!.port, authStatus: true })
    // 目录公式与 app.getPath 对不上时必须当场说一声：开发模式下这两边本来就不是一个目录
    expect(calls.log).toHaveBeenCalledWith(
      'AgentApi',
      'userData dir formula diverged from app.getPath',
      expect.objectContaining({ formulaDir: APP_DATA_DIR_NAME })
    )
  })

  it('开着的时候真的能连上：/health 免鉴权，其余 401，Bearer 对了才办事', async () => {
    const result = await startAgentFacade()
    const { port, token } = (await onDisk())!
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ok: true })

    const denied = await fetch(`http://127.0.0.1:${port}/jobs/whatever`)
    expect(denied.status).toBe(401)
    const unknownJob = await fetch(`http://127.0.0.1:${port}/jobs/whatever`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(unknownJob.status).toBe(404)
    // /health 里那句 engineReady 取的是真门的读数（这里 mock 好了）
    expect(result.listening).toBe(true)
  })

  it('开关是关：不监听，且把上一份运行留下的凭据删掉', async () => {
    await writeAgentEndpoint(dir, { port: 43210, token: TOKEN })
    calls.loadSettings.mockResolvedValue({ agentApi: 'require' } as unknown as AppSettings)

    const result = await startAgentFacade()
    expect(result.listening).toBe(false)
    expect(result.reason).toContain('读出来是 off')
    // 这一句会被 settings:save 拼成给用户看的 agentNote，所以它得指出该去哪一格看——只说「off」是把排查
    // 推回文档；同时它不许带端口或 token（#385 那条「渲染层只拿到开关」的边界）
    expect(result.reason).toContain('关于与更新')
    expect(result.reason).not.toMatch(/\d{4,5}/)
    expect(await readAgentEndpoint(dir)).toStrictEqual({ status: 'missing' })
  })

  it('退出：收监听 + 删文件一次做完，再停一次也不报警', async () => {
    const result = await startAgentFacade()
    expect(result.listening).toBe(true)
    const port = (await onDisk())!.port

    await stopAgentFacade()
    expect(await readAgentEndpoint(dir)).toStrictEqual({ status: 'missing' })
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()

    // 已经停了还再停一次：不许抛，也不该再报一次「停了」
    calls.log.mockClear()
    await stopAgentFacade()
    expect(calls.log).not.toHaveBeenCalled()
  })

  it('凭据文件写不下去就不监听：宁可没有 agent 入口，也不要一份全世界可读的 Bearer', async () => {
    // 失败注入用的是真磁盘：目录没了，tmp+rename 那两步自然写不下去
    await rm(dir, { recursive: true, force: true })
    const first = await startAgentFacade()
    expect(first.listening).toBe(false)
    expect(first.reason).toContain('凭据文件写不下去')

    // 半截状态不许留下：目录回来了，下一次启动照样能正常起来
    await mkdir(dir, { recursive: true })
    const second = await startAgentFacade()
    expect(second.listening).toBe(true)
    expect(await onDisk()).not.toBeNull()
  })

  it('两次启动不会把端口开两遍（单飞），也不会换掉已经交出去的那份 token', async () => {
    const first = await startAgentFacade()
    const before = await onDisk()
    const second = await startAgentFacade()

    expect(first.listening).toBe(true)
    expect(second).toStrictEqual({ listening: true, reason: '已经在听了' })
    // 重写一份 token 会让已经拿到旧 token 的 CLI 立刻连不上
    expect(await onDisk()).toStrictEqual(before)
  })
})

describe('结构判据：写在注释里的规矩得有机械判式', () => {
  it('地址是写死的 127.0.0.1，localhost 一次都不出现', async () => {
    const source = code(await read('electron/main/services/agentFacade.ts'))
    expect(source).toMatch(/const HOST = '127\.0\.0\.1'/)
    expect(source).not.toMatch(/localhost/)
    // 端口交给 OS：出现任何写死的端口号都意味着会与 ASR 那个 8000 抢
    expect(source).toMatch(/listen\(0, HOST/)
    expect(source).not.toMatch(/listen\(\s*[1-9]\d*/)
  })

  it('不装 CORS，也不发任何 Access-Control 头', async () => {
    // 只扫代码行：文件头那句「不装 CORS」是这份判据要解释的事，连着注释一起扫就等于罚它不许解释
    const source = code(await read('electron/main/services/agentFacade.ts'))
    expect(source).not.toMatch(/Access-Control/i)
    expect(source).not.toMatch(/setHeader\([^)]*[Oo]rigin/)
    expect(source).not.toMatch(/\bcors\b/i)
  })

  it('0600 那两步不许省：writeFile 的 mode 与显式 chmod 都在', async () => {
    const source = code(await read('electron/main/services/agentEndpoint.ts'))
    expect(source).toMatch(/mode:\s*0o600/)
    expect(source).toMatch(/chmod\([^)]*,\s*0o600\)/)
  })

  it('#358 诊断包压根不读这份凭据文件', async () => {
    const source = await read('electron/main/services/diagnosticsService.ts')
    expect(source).not.toMatch(/agent-api|agentEndpoint|AGENT_ENDPOINT/)
  })

  it('起停挂在两处：应用生命周期，加上保存时主进程侧那一次拉齐', async () => {
    // 启动开 + 退出关（退出顺序那条判式在下面）
    const index = code(await read('electron/main/index.ts'))
    expect(index).toMatch(/startAgentFacade\(\)/)
    const quit = index.slice(index.indexOf("app.on('before-quit'"))
    expect(quit).toMatch(/stopAgentFacade\(\)/)
    // 网络边界先关：引擎还活着的时候不该还有一个能收文件路径的端口开着
    expect(quit.indexOf('stopAgentFacade')).toBeLessThan(quit.indexOf('stopASRService'))
    // #385：保存即生效走的是 `settings:save` 里主进程自己拉齐，**不新开 IPC 通道**——
    // 新开一条「把门面打开」的通道，下一步就是有人往里塞端口和 token
    const handlers = code(await read('electron/main/ipc/settingsHandlers.ts'))
    expect(handlers).toMatch(/startAgentFacade\(\)/)
    expect(handlers).toMatch(/stopAgentFacade\(\)/)
    expect(await read('electron/preload/index.ts')).not.toMatch(/AgentFacade|agent-api/)
  })

  it('键可以进界面，凭证与端口读数永远不许进渲染层', async () => {
    // #385 把这一项从「只在磁盘」换成了「界面上有一格」：它决定的是**一种用法**（让本机另一个进程
    // 或 AI 客户端来调这个应用），不是一个技术参数——按旧判式藏起来，代价是普通用户永远不知道还能这样用。
    // 换掉的只是「可发现性」这一半，凭证那一半的边界必须还在，所以两头都钉：
    // ① 进了 `SettingsValues` 就必须同时进回填名单：保存发的是整份 values，漏一个键就等于
    //    每一次界面保存都把磁盘上那个 on 盖回默认——非 mac 上没有那一格，那里只会更隐蔽。
    const modal = await read('src/components/settings/SettingsModal.tsx')
    const keys = /const GLOBAL_VALUE_KEYS[^\n]*\n([\s\S]*?)\n\]/.exec(modal)
    expect(keys?.[1] ?? '').toMatch(/'agentApi'/)
    // ② 渲染层整棵树里不许出现凭据文件名、它的读写模块，或任何端口／token 的读数
    const tree = await readTree('src')
    expect(tree).not.toMatch(/agent-api\.json|agentEndpoint|AGENT_ENDPOINT/)
    expect(tree).not.toMatch(/agentToken|agentPort|AddressInfo/)
    // ③ 这一格只在 mac 渲染：门面三平台都能起，但 `vv` 只随 mac 安装包交付（electron-builder.cjs 的
    //    darwin 分支），在没有它的平台上摆一颗开关＝许一个装不出来的承诺。判式只认「isMac 那个块里
    //    确实包着这格」，所以把门拆掉会红，在别处新加一格不会。
    expect(code(modal)).toMatch(/\{isMac && \([\s\S]{0,400}?values\.agentApi/)
  })
})

/**
 * 只留代码行：注释里写「为什么不 import electron」「不许出现 localhost」本来就是要解释这件事，
 * 判式连着注释一起扫就等于罚这些文件不许解释自己（与 tests/transcribeJob.test.ts 同一口径）。
 */
function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

const read = (rel: string): Promise<string> => readFile(join(process.cwd(), rel), 'utf-8')

/** 渲染层整棵树：用来证「这一项真的没走界面」，而不是只证某个组件没提它 */
async function readTree(root: string): Promise<string> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(await readFile(full, 'utf-8'))
    }
  }
  await walk(join(process.cwd(), root))
  return out.join('\n')
}
