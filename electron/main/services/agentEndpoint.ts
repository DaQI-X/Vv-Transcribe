/**
 * 门面的「这次运行连得上哪、凭据是什么」那一份落盘文件（#376）
 *
 * 这是本项目里**唯一一处凭据必须落盘**的地方，理由只有一条：CLI 是另一个进程，而
 * ELECTRON_RUN_AS_NODE 模式里连 `require('electron')` 都抛错（#374 实测），拿不到 safeStorage。
 * 所以 #353 那套「凭证只活在内存」在这里做不到，得按 #376 的口径改认：
 * **不跨 IPC 传明文**这条还在，只是多了一条「落盘、0600、随运行结束消失」。
 *
 * 三条硬约束长在哪：
 * 1. **0600**：tmp 写完先 chmod 再 rename（rename 带过去的是 tmp 的权限）。裸 writeFile 在
 *    文件已存在时不改权限，所以 chmod 这步不许省。失败就往外抛，调用方（`agentFacade`）
 *    据此**不启动门面**——一份全世界可读的凭据比「没有 agent 入口」糟得多。
 * 2. **随运行结束消失**：启动时开关是关就删掉它，退出时（before-quit）也删。
 *    留着会出现「上次的 token + 这次没人监听的端口」，而端口号是 OS 随机给的，
 *    下次可能被别的程序占走——那种情况下 CLI 拿到的是「连到别人的服务」。
 * 3. **不落 `transcribe-` 前缀**：那是 `sweepStaleMediaTempDirs` 的靶子，也在 /tmp 而不是 userData。
 *
 * 为什么不复用 `userDataStore.atomicWriteJson`：那一层 import 'electron'（`app.getPath`），
 * CLI 一 import 就崩。这里的 tmp+rename 与那一层同一套写法，是有意的重复而不是漂移——
 * `userDataDir.ts` 头上说的「两处定义」风险只在**目录算法**那一条上，文件名与格式都收在这一个模块里。
 *
 * token 明文不许进日志、不许进 #358 诊断包：这两条都不是靠这里「记得不提它」保的——
 * 日志那侧由 `logRedact` 按键名兜（字段名撞 `CREDENTIAL_KEY` 就整值隐掉），诊断包那侧
 * `diagnosticsService` 只走 settings/profiles/components/日志尾，压根不读这份文件。
 * 要新增读数请写 `authStatus` 这类布尔位，别写 `tokenStatus`（归一化后含 `token`，会被隐掉）。
 */
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 文件名只有这一处定义：主进程拼它、CLI 也拼它，两边不许各写一个串 */
export const AGENT_ENDPOINT_FILE_NAME = 'agent-api.json'

export interface AgentEndpoint {
  /** OS 随机给的端口（`listen(0)`），所以每次运行都可能不同——这正是它必须落盘的另一半理由 */
  port: number
  token: string
}

export type AgentEndpointRead =
  | { status: 'ok'; endpoint: AgentEndpoint }
  /** 没有这份文件＝门面没开过，或上次随退出删掉了：这是「没开」，不是「坏了」 */
  | { status: 'missing' }
  /** 有文件但读不懂（半截、权限、手改坏）：CLI 要说这句，不能推给「应用没在跑」 */
  | { status: 'invalid'; reason: string }

export function agentEndpointFile(dir: string): string {
  return join(dir, AGENT_ENDPOINT_FILE_NAME)
}

/**
 * 这里不复用 `userDataStore.readJsonFile` 的四种结局（ok / missing / corrupt / unreadable），
 * 因为那一层要区分的是「读失败之后还能不能写」——那是 settings.json 与历史账本的命门，
 * 而这一份文件每次启动整体重写一次、里面没有用户填过的东西：读不懂就是「这一份不可用」，
 * 具体是解不开还是没权限只决定那句 `reason` 怎么写。分成三种已经够 CLI 说清是哪一类问题。
 */
export async function readAgentEndpoint(dir: string): Promise<AgentEndpointRead> {
  let text: string
  try {
    text = await readFile(agentEndpointFile(dir), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'invalid', reason: err instanceof Error ? err.message : String(err) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { status: 'invalid', reason: err instanceof Error ? err.message : String(err) }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'invalid', reason: '文件内容不是一个 JSON 对象' }
  }
  const { port, token } = parsed as Record<string, unknown>
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { status: 'invalid', reason: `port 不是一个端口号（读到 ${JSON.stringify(port)}）` }
  }
  // 不校验「是不是 UUID 形状」：那等于把生成方式写进读取端，将来换一种生成法就自己读出自己坏了
  if (typeof token !== 'string' || token.length < 16 || /\s/.test(token)) {
    return { status: 'invalid', reason: 'token 不是一个可用的字符串' }
  }
  return { status: 'ok', endpoint: { port, token } }
}

/**
 * 先写 `<file>.tmp`（0600）再 rename，所以「这份文件存在」等价于「它是完整且只有本用户可读的」。
 * 中途失败一定清掉 tmp：磁盘上留一份没人认领的凭据副本，比这次没写成更糟。
 */
export async function writeAgentEndpoint(dir: string, endpoint: AgentEndpoint): Promise<void> {
  const file = agentEndpointFile(dir)
  const tmp = `${file}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(endpoint), { mode: 0o600 })
    // 上一份 tmp 残留过（上次崩在这里）时 mode 不会跟着新的 writeFile 变，所以显式 chmod
    await chmod(tmp, 0o600)
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/** 删除失败不抛：开关是关的时候，「没监听」已经是真的，老文件只是难看——但要把 errno 递回去让人记账 */
export async function clearAgentEndpoint(dir: string): Promise<string | null> {
  try {
    await rm(agentEndpointFile(dir), { force: true })
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
