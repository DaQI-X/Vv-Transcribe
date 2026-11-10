/**
 * agent 入口的本地 HTTP 门面（#376）
 *
 * 一句话形状：主进程里挂一个**只绑 127.0.0.1** 的 HTTP 服务，默认关，把 #375 抽出来的
 * 作业体（`transcribeJob`）暴露成四个端点，让另一个进程的 `vv`（#377）与 MCP（#356）能用。
 * 它是这个应用里**第二个调用转写的入口**，所以也是第一处需要「本机另一个进程能拿到什么」
 * 这份答案的地方——那份答案是：一个文件路径 + 一次 Bearer，其余一律不给。
 *
 * 为什么这层可以这么薄：作业体、设置、方案、sidecar 生命周期全是现成的，凭据照旧走
 * profileId + 该档当前默认那条（#222），这里**不新增第二套凭据体系**。转写用的 Key 一个字节都不
 * 经过这个 HTTP 端口——出去的只有 `file / language / profileId`，回来的是段落。
 *
 * 五条不许松的约束，分别长在哪：
 * 1. **默认关**：`settings.agentApi` 经 `normalizeAgentApi` 读成 `'on' | 'off'`，白名单外的值一律
 *    `'off'`（fail-closed：这一项的失败方向是「多开了一个端口」，而多开一个端口没有任何人会来报告）。
 *    #385 起这一格在设置「关于与更新」里（只有 macOS 出现，因为 `vv` 只随 mac 安装包交付），
 *    **保存即生效**：启动时读一次磁盘，之后由 `settings:save` 在主进程侧当场起或停。
 *    这一条与 `asrEngineAuth` 从此不同口径——那个仍是磁盘手改 + 重启生效，因为它没有可决定的内容。
 * 2. **只绑 127.0.0.1**：地址是写死的常量，不读配置、也不写 `localhost`——`localhost` 在现代解析里
 *    可能先给 `::1`，那一半就是「整台机器的 IPv6 监听」，#353 定的就是这条。端口给 0 让 OS 挑，
 *    所以端口每次运行都可能不同，必须与 token 一起落盘（`agentEndpoint.ts`）。
 * 3. **除 `/health` 外每个端点都要 Bearer**（health 只回答「在不在这」，不带一个字节的素材内容）。
 *    比对用 `crypto.timingSafeEqual`（先把长度对齐，否则它直接抛），而不是 `===`。
 *    这一条与 #353 的唯一差别是那份凭据得落盘，理由写在 `agentEndpoint.ts` 头上。
 * 4. **不装 CORS**：这不是给浏览器访问的东西，加了等于把「谁能连」交给一个 Origin 字符串去猜；
 *    也不发任何 `Access-Control-*` 头，`tests/agentFacade.test.ts` 把这条钉住了。
 * 5. **token 明文不进日志、不进 #358 诊断包**：日志里只出现 `port` 与 `authStatus` 这类状态位，
 *    字段名都过了一遍 `logRedact` 那张表（`tokenStatus` 会撞 `token` 被整值隐掉，那就把
 *    「到底有没有 token」这句唯一有用的诊断抹了）。诊断包只走 settings/profiles/components/日志尾，
 *    压根不读这份文件。
 *
 * 进度用 **NDJSON**（一行一个 JSON），不选 SSE：SSE 的 `event:`/`data:` 前缀与心跳注释都要客户端
 * 自己解析，而这里的客户端就是自家那个 CLI，能少一种格式就少一种。Python 引擎侧早就用同一形状
 * （#125），所以整条链路上只有一种流式格式。
 *
 * 端点（路径按精确分段匹配，不做前缀通配）：
 * - `GET  /health`                免鉴权：`{ ok, version, engineReady }`
 * - `POST /jobs/transcribe`       `{ file, language?, profileId? }` → `202 { jobId }`
 * - `GET  /jobs/:id`              NDJSON：先补发缓冲区，再实时追，最后一行 `{ type:'result' }`
 * - `POST /jobs/:id/cancel`       只认**这个门面自己启动的**作业编号，别的一律 404
 *
 * 最后那条是范围，不是漏的：`cancelTranscribeJob` 拿的是全应用共用的那张 `activeJobs`，界面上那一单
 * 理论上能被一个猜出来的 UUID 打断。所以这里的判断按「这个门面认不认得」而不是「应用里有没有在跑」——
 * 猜中的代价是不对称的（打断别人正在跑的转写比让 CLI 多等一会儿严重得多），而 CLI 从来不需要取消别人的单。
 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { app } from 'electron'
import { formatBytes } from '../../../src/utils/formatBytes'
import { getASRServiceStatus } from './asrServiceManager'
import { clearAgentEndpoint, writeAgentEndpoint } from './agentEndpoint'
import { logger } from './logger'
import { loadSettings, normalizeAgentApi } from './settingsService'
import {
  cancelTranscribeJob,
  startTranscribeJob,
  type TranscribeJobOptions,
  type TranscribeJobResult,
  type TranscribeProgressEvent,
  type TranscribeProgressSink,
} from './transcribeJob'
import { userDataDirFor } from './userDataDir'
import { userDataRoot } from './userDataStore'

const TAG = 'AgentApi'

/** 写死，不读配置：见文件头第 2 条。`localhost` 不在这里出现是判据，不是巧合 */
const HOST = '127.0.0.1'

/**
 * 请求体上限。转写的输入只有一个文件路径，64KB 已经宽到塞得下一整篇稿子，而塞满它不需要理由。
 * 按 1000 进位取这个数，不是随手：报错那句话要用全仓那把尺（`formatBytes`，也按 1000）念出来，
 * 写 `64 * 1024` 会得到「超过 66KB」这种没人能对上的数（`ttsVendor.ts` 的 `sizeLimit` 收拾的是同一类）。
 */
const MAX_BODY_BYTES = 64_000

/**
 * 门面记得几单作业。每单都攥着全部段落（界面本来也攥着，所以这不是新的内存来源），
 * 但没有上限就会有一类「POST 完就走、再没来 GET」的客户端把内存留到应用退出。
 * 超了就按完成先后丢最老的——丢的是查询记录，素材本身在历史记录（#247）里另有账。
 */
const MAX_SESSIONS = 20

/** 一个 `POST /jobs/transcribe` 收得的字段；其余一律拒，不静默忽略 */
const JOB_FIELDS = ['file', 'language', 'profileId'] as const

/** 用到的只有这几个成员，见 FacadeRequest 头上那句「让测试能喂一份假的进来」 */
export interface FacadeRequest {
  method?: string
  url?: string
  headers: { authorization?: string | string[] }
  on(event: 'data', listener: (chunk: Buffer) => void): void
  on(event: 'end', listener: () => void): void
}

export interface FacadeResponse {
  writeHead(status: number, headers: Record<string, string>): void
  write(chunk: string): unknown
  end(chunk?: string): void
  on(event: 'close' | 'error', listener: () => void): void
}

export interface FacadeDeps {
  /** 本次运行的 Bearer token，与落盘那一份是同一个串 */
  token: string
  version: string
  /** 本地引擎好了没有——`/health` 要说这句，否则「连上了但转写不动」就成了用户的谜题 */
  engineReady: () => boolean
  startJob: (
    filePath: string,
    options: TranscribeJobOptions,
    onProgress: TranscribeProgressSink
  ) => Promise<TranscribeJobResult>
  cancelJob: (jobId: string) => Promise<{ ok: boolean; error: string | null }>
}

interface FacadeSession {
  jobId: string
  /** 缓冲的进度事件：晚到的 `GET /jobs/:id` 要能补上前面漏掉的那些行 */
  events: TranscribeProgressEvent[]
  /** null＝还在跑 */
  result: TranscribeJobResult | null
  /** 正在流式读这一单的响应 */
  streams: Set<FacadeResponse>
}

type Reply = { status: number; body: Record<string, unknown> }

function json(res: FacadeResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

/** 一行一条 JSON，不带 `data:` 前缀——这就是这里选 NDJSON 的全部含义 */
function line(res: FacadeResponse, obj: Record<string, unknown>): void {
  res.write(`${JSON.stringify(obj)}\n`)
}

function bearerFrom(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return null
  const matched = /^Bearer (\S+)$/.exec(raw)
  return matched ? (matched[1] as string) : null
}

/**
 * 定长比对：先比长度，再交给 `timingSafeEqual`（长度不等它直接抛）。
 * 这里的对手是本机另一个进程，逐字节早退的 `===` 省下的那点时间对它毫无意义——
 * 但 #353 定的就是这一条，抄就抄全，别在「反正没人能时序攻击本机」上打折。
 */
function authorized(req: FacadeRequest, token: string): boolean {
  const got = bearerFrom(req.headers.authorization)
  if (!got) return false
  const mine = Buffer.from(token, 'utf-8')
  const theirs = Buffer.from(got, 'utf-8')
  return mine.length === theirs.length && timingSafeEqual(mine, theirs)
}

function parsePath(url: string | undefined): string[] {
  const pathname = (url ?? '/').split('?')[0] ?? '/'
  return pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/')
}

/** 收请求体；超限就 413 并停止解析（后续 chunk 直接丢，不陪一个乱发的客户端耗内存） */
function readBody(req: FacadeRequest): Promise<Reply | Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let done = false
    req.on('data', (chunk) => {
      if (done) return
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        done = true
        resolve({
          status: 413,
          body: { error: `请求体超过 ${formatBytes(MAX_BODY_BYTES)}（这里只收一个文件路径）` },
        })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      const text = Buffer.concat(chunks).toString('utf-8')
      if (!text.trim()) {
        resolve({ status: 400, body: { error: '请求体是空的' } })
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (err) {
        resolve({
          status: 400,
          body: { error: `请求体不是合法 JSON：${err instanceof Error ? err.message : String(err)}` },
        })
        return
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        resolve({ status: 400, body: { error: '请求体要是一个 JSON 对象' } })
        return
      }
      resolve(parsed as Record<string, unknown>)
    })
  })
}

/**
 * 「这是个错误回复，不是校验通过的入参」的判式。
 * 参数写成 `Reply | object` 而不是某一条具体的联合：`jobInput` 交回的那一支是接口类型
 * （`TranscribeJobOptions & { file: string }`），接口没有隐式索引签名，
 * 收 `Record<string, unknown>` 的签名会在编译期拒掉它——而这里的判据本来就只有
 * 「有没有 status + body 这两个键」，不需要按对象索引。
 */
function isReply(value: Reply | object): value is Reply {
  return 'status' in value && 'body' in value
}

/**
 * 校验入参并收成 `TranscribeJobOptions`。
 * 不认识的字段直接拒而不是忽略：`filePath` 少写一个字母会被当成「没给 file」，那已经够绕了；
 * 静默丢掉一个拼错的键则会让用户以为参数进去了，然后花半小时查为什么没生效。
 */
function jobInput(
  body: Record<string, unknown>
): Reply | (TranscribeJobOptions & { file: string }) {
  const unknown = Object.keys(body).filter((key) => !(JOB_FIELDS as readonly string[]).includes(key))
  if (unknown.length) {
    return {
      status: 400,
      body: { error: `不认识这些字段：${unknown.join('、')}。只收 ${JOB_FIELDS.join(' / ')}` },
    }
  }
  const file = body.file
  if (typeof file !== 'string' || !file.trim()) {
    return { status: 400, body: { error: 'file 要是一个非空的素材路径' } }
  }
  const options: TranscribeJobOptions & { file: string } = { file: file.trim() }
  for (const key of ['language', 'profileId'] as const) {
    const value = body[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') {
      return { status: 400, body: { error: `${key} 要是一个字符串` } }
    }
    if (value) options[key] = value
  }
  return options
}

/**
 * 造 handler。**每个实例自带一份会话表**，所以两处启动（真应用、一条单测）不串状态；
 * 也因此一个进程里只许建一个实例——真应用那边由 `startAgentFacade` 保证（它单飞）。
 */
export function createFacadeHandler(deps: FacadeDeps): (req: FacadeRequest, res: FacadeResponse) => void {
  const sessions = new Map<string, FacadeSession>()

  const ensureSession = (jobId: string): FacadeSession => {
    const existing = sessions.get(jobId)
    if (existing) return existing
    const created: FacadeSession = { jobId, events: [], result: null, streams: new Set() }
    sessions.set(jobId, created)
    if (sessions.size > MAX_SESSIONS) {
      for (const [id, session] of sessions) {
        if (session.result && !session.streams.size) {
          sessions.delete(id)
          break
        }
      }
    }
    return created
  }

  /** 结算那一行写完就收流：客户端拿到 result 行之后不该再等任何东西 */
  const closeStreams = (session: FacadeSession): void => {
    for (const stream of [...session.streams]) {
      if (!session.result) continue
      line(stream, { type: 'result', ...session.result })
      session.streams.delete(stream)
      stream.end()
    }
  }

  /**
   * 起一单，并把作业编号交给 POST 的响应。
   * 编号只能从作业体那里拿（`jobId` 是它自己 `randomUUID()` 出来的），两条路：
   * 第一个进度事件（今天它在任何 await 之前同步发，所以这一步几乎不等）、
   * 或者作业结算时那个 `result.jobId`（几秒或几毫秒之后）。
   * 少了第二条，将来谁把 `sendProgress(0)` 往后挪，症状就变成「POST 永远挂着」，
   * 而那看起来像应用卡死。两条都没交出编号＝作业体自己抛了，回 null 让调用方答 500。
   */
  const runJob = async (input: TranscribeJobOptions & { file: string }): Promise<string | null> => {
    let identify!: (jobId: string) => void
    const identified = new Promise<string>((resolve) => {
      identify = resolve
    })
    const { file, ...options } = input

    const sink: TranscribeProgressSink = (event) => {
      const session = ensureSession(event.jobId)
      session.events.push(event)
      for (const stream of session.streams) line(stream, { type: 'progress', ...event })
      identify(event.jobId)
    }

    // 这一支故意不 await：POST 要在作业**开始**时就答 202，跑完的事由 GET 那边收。
    // catch 也不是可选的——作业体自己不抛，但它一旦抛了，这里必须既不留下没人接的 rejection，
    // 也不留下一个永远不答的请求。
    const settled: Promise<string | null> = deps
      .startJob(file, options, sink)
      .then((result) => {
        const session = ensureSession(result.jobId)
        session.result = result
        closeStreams(session)
        identify(result.jobId)
        return result.jobId
      })
      .catch((err: unknown) => {
        logger.error(TAG, 'Job body threw', err instanceof Error ? err.message : String(err))
        return null
      })

    return Promise.race([identified, settled])
  }

  const handle = async (req: FacadeRequest, res: FacadeResponse): Promise<void> => {
    const parts = parsePath(req.url)
    const method = (req.method ?? 'GET').toUpperCase()

    // 免鉴权：只回答「这个应用在不在这、引擎好了没」，不带一个字节的素材内容
    if (method === 'GET' && parts.length === 1 && parts[0] === 'health') {
      json(res, 200, { ok: true, version: deps.version, engineReady: deps.engineReady() })
      return
    }

    if (!authorized(req, deps.token)) {
      json(res, 401, {
        error: '缺少或不对的 Authorization: Bearer <token>（token 在应用数据目录的 agent-api.json 里）',
      })
      return
    }

    if (method === 'POST' && parts.length === 2 && parts[0] === 'jobs' && parts[1] === 'transcribe') {
      const body = await readBody(req)
      if (isReply(body)) {
        json(res, body.status, body.body)
        return
      }
      const input = jobInput(body)
      if (isReply(input)) {
        json(res, input.status, input.body)
        return
      }
      const jobId = await runJob(input)
      if (!jobId) {
        json(res, 500, { error: '转写作业没能在开始或结束时把作业编号交出来' })
        return
      }
      json(res, 202, { jobId })
      return
    }

    if (method === 'GET' && parts.length === 2 && parts[0] === 'jobs') {
      const session = sessions.get(parts[1] ?? '')
      if (!session) {
        json(res, 404, {
          error: `没有编号为 ${parts[1]} 的作业。门面只记得本次运行里由它启动的最多 ${MAX_SESSIONS} 单，应用重启后不留在盘上`,
        })
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
      })
      for (const event of session.events) line(res, { type: 'progress', ...event })
      if (session.result) {
        // 跑完的那一单：补完就收，客户端不用知道它来晚了
        line(res, { type: 'result', ...session.result })
        res.end()
        return
      }
      session.streams.add(res)
      const drop = (): void => {
        session.streams.delete(res)
      }
      // 两个都要：close 是「对面走了」，error 是「写到一个已经没了的流」——
      // 少了后者，一次客户端中途断开会变成主进程里一个没人接的 error 事件。
      res.on('close', drop)
      res.on('error', drop)
      return
    }

    if (method === 'POST' && parts.length === 3 && parts[0] === 'jobs' && parts[2] === 'cancel') {
      const session = sessions.get(parts[1] ?? '')
      if (!session) {
        json(res, 404, { error: '这个门面没有那一单作业，所以也不去打断它（界面上启动的那单请回界面取消）' })
        return
      }
      const result = await deps.cancelJob(session.jobId)
      json(res, 200, { ...result, finished: session.result !== null })
      return
    }

    json(res, 404, {
      error: '没有这个端点。有的四条：GET /health、POST /jobs/transcribe、GET /jobs/:id、POST /jobs/:id/cancel',
    })
  }

  return (req, res) => {
    // handle 把网络边界上的每一次意外都收成一次 500：这里不许出现没人接的 rejection
    void handle(req, res).catch((err: unknown) => {
      logger.error(TAG, 'Request handling threw', err instanceof Error ? err.message : String(err))
      try {
        json(res, 500, { error: '门面内部出错' })
      } catch {
        /* 头已经发出去了，那就让这一条连接自己断 */
      }
    })
  }
}

let server: Server | null = null

/**
 * 开关为 on 才监听。返回「这次到底开没开 + 为什么」：启动时那一句落进日志（`main/index.ts`），
 * 保存时那一句是要给用户看的（`settings:save` 把它拼成 agentNote）——所以这句话里不许有绝对路径、
 * 端口或 token，只许有「为什么没开」这个原因本身。
 *
 * 幂等：已经在听就回 `listening: true`，重复调用（比如保存了一趟别的字段）不会换 token、
 * 也不会把正在流式输出的那一单作业打断。
 */
export async function startAgentFacade(): Promise<{ listening: boolean; reason: string }> {
  if (server) return { listening: true, reason: '已经在听了' }

  const settings = await loadSettings()
  const mode = normalizeAgentApi(settings.agentApi)
  const dir = userDataRoot()
  if (mode !== 'on') {
    // 关掉时连那份「看起来能连」的凭据也不留：磁盘上躺着一个旧 token 加一个 OS 随机端口，
    // 下次那个端口可能已经归了别的程序，CLI 会连上一个不是这个应用的服务
    const detail = await clearAgentEndpoint(dir)
    if (detail) logger.warn(TAG, 'Stale endpoint file could not be removed', detail)
    return {
      listening: false,
      reason: `开关读出来是 ${mode}（设置「关于与更新」里那一格；这一格认的值只有 on 和 off，别的都当关）`,
    }
  }

  const token = randomUUID()
  const handler = createFacadeHandler({
    token,
    version: app.getVersion(),
    engineReady: () => getASRServiceStatus().ready,
    startJob: startTranscribeJob,
    cancelJob: cancelTranscribeJob,
  })
  const http = createServer((req, res) => handler(req, res))

  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      // 端口 0：让 OS 给一个空闲端口，所以别处不许硬编码端口号（跟 ASR 那个 8000 抢起来只会红）
      http.listen(0, HOST, () => {
        http.removeListener('error', reject)
        resolve()
      })
    })
  } catch (err) {
    return { listening: false, reason: `监听失败：${err instanceof Error ? err.message : String(err)}` }
  }

  const port = (http.address() as AddressInfo).port

  // 两处算法对账（风险写在 userDataDir.ts 头上）。只记目录名：日志里不许出现绝对路径。
  const formula = userDataDirFor(process.platform, homedir())
  if (formula !== dir) {
    logger.warn(TAG, 'userData dir formula diverged from app.getPath', {
      electronDir: basename(dir),
      formulaDir: basename(formula),
      note: 'CLI 只认那份公式，所以它会找不到这份 token。开发模式下两边本来就不是一个目录，只有打包版出现这句才要查',
    })
  }

  try {
    await writeAgentEndpoint(dir, { port, token })
  } catch (err) {
    // 0600 保不住就把监听收回去：一份全世界可读的 Bearer 比「没有 agent 入口」糟得多
    http.closeAllConnections?.()
    http.close()
    return {
      listening: false,
      reason: `凭据文件写不下去（监听已收回）：${err instanceof Error ? err.message : String(err)}`,
    }
  }

  server = http
  // 字段名都过了一遍 logRedact 那张表：port 与 authStatus 不敏感，所以这句读数在日志里真能看见
  logger.info(TAG, 'Facade listening', { host: HOST, port, authStatus: true })
  return { listening: true, reason: `http://${HOST}:${port}` }
}

/** 退出时调用：关监听 + 删凭据，一次做完（启动时开关是关的那条路在 start 里自己删） */
export async function stopAgentFacade(): Promise<void> {
  const http = server
  server = null
  if (http) {
    // 先掐连接再等 close：一个还在流式读作业的 GET 会让 close() 永远不答，那时应用退出会卡住
    http.closeAllConnections?.()
    await new Promise<void>((resolve) => {
      http.close(() => resolve())
    })
    logger.info(TAG, 'Facade stopped')
  }
  const detail = await clearAgentEndpoint(userDataRoot())
  if (detail) logger.warn(TAG, 'Endpoint file could not be removed on quit', detail)
}
