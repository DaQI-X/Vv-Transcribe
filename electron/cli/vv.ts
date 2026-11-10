/**
 * `vv` 的那一侧（#377）：argv → 门面 → 文件，中间不许长业务逻辑。
 *
 * 这一层存在的意义就是**薄**：转写、取密钥、临时文件、历史记账全在应用里（#375 抽出来的那份
 * 作业体 + #376 的门面），CLI 只做三件事——把参数拼成一个请求、把 NDJSON 读成人话、把导出的
 * 文本写盘。任何「在 CLI 里再实现一遍」都算跑偏，那等于重写一套密钥落盘，还会让
 * 「CLI 出的文件与界面导的一致」这句承诺变成两条各自演化的代码。
 * `vv check`（#356）不违反这条：它一件都不实现，判定的那一份代码就在 `src/utils/subtitleSpec.ts`，
 * 界面 import 它、CLI 也 import 它，所以界面上「看起来正常」的稿子在终端里也是同一个结论。
 *
 * 三条形状上的硬约束：
 * 1. **不 import 'electron'**：node 模式下 `require('electron')` 直接抛（#374 实测），所以这里
 *    只能用 `userDataDirFor` 那份公式算目录，不能用 `app.getPath`。开发与打包两种环境下应用
 *    自己那份目录是不同的（`Electron` vs `Vv Transcribe`），公式只认打包那份——dev 下要么用
 *    `--data-dir` 指过去，要么按门面那句 divergence WARN 自查。
 * 2. **导出格式只认 `exportTranscript`**：六个档位的清单在这里重复了一次（类型是编译期的，
 *    运行时拿不到），所以有一条守卫测把 `src/utils/exportTranscript.ts` 里那些 `case` 逐条对账。
 * 3. **进度走 stderr，产物走 stdout 或 `-o`**：#374 实测「Electron 自己一个字都不往 stdout 喷」，
 *    这条才让 `vv transcribe x > y.srt` 有意义；把进度混进 stdout 就等于废掉管道。
 *
 * 退出码（`--help` 里也印这份）：0 成 / 1 这一单失败 / 2 命令写错了 / 3 连不上应用 / 130 被 Ctrl-C 打断。
 * 「应用没开 / 开关没开 / 凭据对不上」这三种都归 3，但 stderr 那句话会点明是哪一种——
 * 分开三个码看着更精确，实际会让脚本作者去猜哪一类算「可重试」。
 *
 * `vv check` 是这一层里唯一不碰门面的一条（#356）：它判的是盘上那份文件，用的是界面与 CLI
 * 共用那一份校验器（`src/utils/subtitleSpec.ts`），所以应用没开也能跑、也就不用 token 和端口。
 * 它的退出码只借校验报告里那一个（0 没错误 / 1 有错误），加上 2＝命令行或档位文件本身用不了；
 * 3 与 130 在这里没有对应的失败形状，就不硬凑。
 *
 * `vv mcp`（#356）也不违反「薄」：它一件逻辑都没有，三把 tool 分别转给 `run(['transcribe' …])`、
 * `run(['check' …])` 和 `exportTranscript`，所以 agent 拿到的结论与人在终端里敲出来的同一个字。
 * 它与门面那三把的区别只有一层：**不监听端口**——请求与回话都是 stdin/stdout 上的一行一条
 * JSON-RPC，进程由 MCP 客户端自己拉起、自己关掉。于是「默认关」这一条不需要开关来实现：
 * 没有人敲 `vv mcp`，这台机器上就多不出任何东西；而转写那把照样得应用开着、`agentApi` 打开，
 * 凭据只从 `agent-api.json` 那一份读，壳里没有第二套。
 */
import { realpathSync } from 'node:fs'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { readAgentEndpoint, type AgentEndpointRead } from '../main/services/agentEndpoint'
import { userDataDirFor } from '../main/services/userDataDir'
import { exportTranscript, getExportExtension } from '../../src/utils/exportTranscript'
import { formatBytes } from '../../src/utils/formatBytes'
import {
  BUILTIN_PRESET_IDS,
  DEFAULT_PRESET_ID,
  builtinPreset,
  checkSubtitleText,
  renderReport,
  validatePreset,
  type PresetResult,
  type SubtitlePreset,
} from '../../src/utils/subtitleSpec'
import type { ExportFormat, TranscriptionSegment } from '../../src/types/transcription'

/** 门面回来的那一行结果（#376 的 NDJSON 里最后一条） */
interface FacadeResultRow {
  type: 'result'
  jobId?: string
  success: boolean
  canceled?: boolean
  error?: string
  segments?: { startTime: number; endTime: number; text: string }[]
  provider?: string
}
interface FacadeProgressRow {
  type: 'progress'
  jobId?: string
  progress?: number
  segment?: { startTime: number; endTime: number; text: string }
  stage?: string
  model?: { tier?: string; weightsMb?: number }
}
type FacadeRow = FacadeResultRow | FacadeProgressRow | { type: string; error?: string }

export const USAGE = `用法：
  vv transcribe 素材文件 [-o 输出.srt] [-f srt|vtt|tsv|txt|json|md] [--language zh] [--profile 方案id]
  vv check 字幕文件.srt [--preset vv-default|broadcast-cn|netflix-cjk|我的档位.json] [--fps 25] [--json]
  vv mcp [--data-dir 应用数据目录]
  vv --help
  vv --version

transcribe 走的是本机那个 Vv Transcribe 应用：先把应用开着，并在 settings.json 根上把
agentApi 设成 "on"（改完要重启应用）。开关默认是关的——这一步决定本机多不多一个监听端口。
不写 -o 就把结果打到 stdout，所以 vv transcribe x > x.srt 也是通的（进度在 stderr，不脏管道）。

check 判一份字幕文件上不了得上屏，跟应用开没开着无关：跑的是界面里那同一份校验器，不碰门面也不读 token。
不给 --preset 就用 vv-default（只提示、不拦路）；--preset 也可以是一个 .json 路径，那种档位必须把
六条规则写全、每条都带 cite 与 source——「没判」和「判过」在报告里不许长得一样。--json 出机器读那一份
（阈值连同各自的出处）。文件是 SRT 还是 VTT 按内容认，不用标；帧格那一条只有给了 --fps 才跑得起来。

mcp 是给 agent 客户端挂的那一层 stdio 服务（initialize / ping / tools/list / tools/call 四个方法，
transcribe / check / export 三把 tool）。它不监听任何端口，也不新写一份逻辑：三把 tool 分别转给
上面那两条子命令和导出器，所以 agent 拿到的结论与你在终端里敲出来的同一个字。文件路径、格式、档位、
帧率这些都从 tools/call 的参数里给，argv 只留一个 --data-dir 用来找 agent-api.json。挂法写在
README 的 agent 那一节；只有 transcribe 那一把要应用开着，check 与 export 不用。

退出码：0 成 / 1 这一单失败（check 这里是「有错误级的结果」）/ 2 命令写错了 / 3 连不上应用
（没开、开关没开、凭据不对都算这一类，stderr 那句话会点明是哪一种）/ 130 被 Ctrl-C 打断（会顺手把那一单取消掉）
check 只用 0 / 1 / 2 这三个；mcp 是长驻的，客户端关掉它就退，失败在协议里说（isError），不靠退出码`

/**
 * 六档清单在这里第二次出现，是因为 `ExportFormat` 只是个编译期类型，运行时取不到成员表。
 * 对账交给守卫测（tests/vvCli.test.ts 里那条读 `exportTranscript.ts` 的 `case` 逐条比），
 * 而不是在这里 import 渲染层那份 `FORMAT_OPTIONS`——那会把整个组件树拖进 CLI 产物。
 * export 只为那条对账测拿得到同一份清单，没有别的调用方。
 */
export const FORMATS: ExportFormat[] = ['srt', 'vtt', 'tsv', 'txt', 'json', 'md']

export interface CliArgs {
  command: 'transcribe' | 'check' | 'mcp' | 'help' | 'version'
  /** transcribe 那侧是素材路径，check 那侧是字幕文件路径 */
  file: string
  /** null = 打到 stdout */
  out: string | null
  format: ExportFormat
  formatGiven: boolean
  language?: string
  profileId?: string
  dataDir?: string
  /** check：内置档位名或一份 .json 路径；不给就是 vv-default */
  preset?: string
  /** check：那一部片子的帧率。只有给了它，帧格对齐那一条才跑得起来 */
  fps?: number
  /** check：出校验报告那一份 JSON，而不是排给人看的话 */
  json?: boolean
}

export type ParseResult = { ok: true; args: CliArgs } | { ok: false; message: string }

/** 按 `-o` 的后缀认出来的档位；认不出来（没有后缀、或后缀不在六档里）返回 null，交给 -f 的口径 */
function formatFromExt(target: string): ExportFormat | null {
  const ext = extname(target).slice(1).toLowerCase()
  return FORMATS.find((f) => getExportExtension(f) === ext) ?? null
}

export function parseArgv(argv: string[]): ParseResult {
  const positional: string[] = []
  let out: string | null = null
  let format: ExportFormat = 'srt'
  let formatGiven = false
  let language: string | undefined
  let profileId: string | undefined
  let dataDir: string | undefined
  let preset: string | undefined
  let fps: number | undefined
  let json = false
  /** 两条子命令各有一把自己的参数；串了门的那种组合没有一种有意义，所以记下名字好点名 */
  const transcribeOnly: string[] = []
  const checkOnly: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === undefined) continue
    if (!token.startsWith('-')) {
      positional.push(token)
      continue
    }
    // 只认这几个长标记；`--flag=value` 那种写法也收，脚本里拼参数时很常用
    const eq = token.indexOf('=')
    const name = eq > 0 ? token.slice(0, eq) : token
    const inlineValue = eq > 0 ? token.slice(eq + 1) : undefined
    const value = (): string | null => {
      if (inlineValue !== undefined) return inlineValue
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('-')) return null
      i++
      return next
    }

    if (name === '-o' || name === '--out') {
      const got = value()
      if (got === null || got === '') return { ok: false, message: `${name} 后面要跟一个输出文件路径` }
      out = got
      transcribeOnly.push(name)
      continue
    }
    if (name === '-f' || name === '--format') {
      const got = value()
      if (got === null) return { ok: false, message: `${name} 后面要跟 srt / vtt / tsv / txt / json / md 中的一个` }
      const hit = FORMATS.find((f) => f === got)
      if (!hit) {
        return { ok: false, message: `不认得 -f ${got}。可选：${FORMATS.join(' / ')}` }
      }
      format = hit
      formatGiven = true
      transcribeOnly.push(name)
      continue
    }
    if (name === '--language' || name === '--profile' || name === '--data-dir') {
      const got = value()
      if (got === null || got === '') return { ok: false, message: `${name} 后面要跟一个值` }
      if (name === '--language') language = got
      else if (name === '--profile') profileId = got
      else dataDir = got
      transcribeOnly.push(name)
      continue
    }
    if (name === '--preset') {
      const got = value()
      if (got === null || got === '') {
        return { ok: false, message: `--preset 后面要跟内置档位名（${BUILTIN_PRESET_IDS.join(' / ')}）或一份 .json 路径` }
      }
      if (!BUILTIN_PRESET_IDS.includes(got) && !isPresetPath(got)) {
        return {
          ok: false,
          message: `--preset 收到的是「${got}」：内置档位只有 ${BUILTIN_PRESET_IDS.join(' / ')} 这三个，自己那份要写成 .json 路径`,
        }
      }
      preset = got
      checkOnly.push(name)
      continue
    }
    if (name === '--fps') {
      const got = value()
      if (got === null || got === '') return { ok: false, message: '--fps 后面要跟一个帧率数字，比如 25 或 23.976' }
      const rate = Number(got)
      // 23.976 / 29.97 这类非整数帧率是真的在用（NTSC），所以这里不但不取整，还得收得住小数
      if (!Number.isFinite(rate) || rate <= 0) {
        return { ok: false, message: `--fps 要的是一个大于 0 的数（帧率），收到的是「${got}」` }
      }
      fps = rate
      checkOnly.push(name)
      continue
    }
    if (name === '--json') {
      json = true
      checkOnly.push(name)
      continue
    }
    if (name === '--help' || name === '-h') return { ok: true, args: emptyArgs('help') }
    if (name === '--version') return { ok: true, args: emptyArgs('version') }
    return {
      ok: false,
      message: `不认得的标记：${name}（能用的：-o/--out、-f/--format、--language、--profile、--data-dir、--preset、--fps、--json、--help、--version）`,
    }
  }

  const command = positional[0]
  if (command === undefined) return { ok: false, message: `要一个子命令。${USAGE}` }
  if (command !== 'transcribe' && command !== 'check' && command !== 'mcp') {
    return { ok: false, message: `这一版只有 transcribe / check / mcp 这三个子命令（收到的是「${command}」）。${USAGE}` }
  }
  if (command === 'mcp') {
    // mcp 一把文件都不收：路径、格式、档位、帧率全在 tools/call 的参数里，argv 只留 --data-dir 用来找凭据
    const unwanted = [...transcribeOnly.filter((name) => name !== '--data-dir'), ...checkOnly]
    if (unwanted.length > 0) {
      return {
        ok: false,
        message: `mcp 只认 --data-dir（收到的是 ${unwanted.join('、')}）：文件路径、格式、档位这些都放进 tools/call 的参数里给`,
      }
    }
    if (positional.length > 1) {
      return { ok: false, message: `mcp 不收文件路径（${positional.slice(1).join(' ')}）：那是 tools/call 里的 file` }
    }
    return { ok: true, args: emptyArgs('mcp', dataDir) }
  }
  if (positional.length > 2) {
    return { ok: false, message: `${command} 只收一个文件路径，多了 ${positional.length - 1} 个：${positional.slice(1).join(' ')}` }
  }
  const file = positional[1]
  if (!file) return { ok: false, message: `${command} 后面要跟${command === 'check' ? '一个字幕文件' : '一个素材文件'}路径` }

  const misplaced = command === 'check' ? transcribeOnly : checkOnly
  if (misplaced.length > 0) {
    return {
      ok: false,
      message:
        command === 'check'
          ? `check 不收 ${misplaced.join('、')}：它只在本地判一份文件，不提交作业。格式按文件内容认，阈值用 --preset 选`
          : `transcribe 不收 ${misplaced.join('、')}：那是 check 那一条的参数（判一份已经存在的字幕文件）`,
    }
  }
  if (command === 'check') {
    // 这两个字段在 check 这条路上恒为「没给」：留成默认值，而不是让下游各自判 undefined
    return { ok: true, args: { command, file, out: null, format: 'srt', formatGiven: false, preset, fps, json } }
  }

  // `-o` 的后缀认得出来时以它为准（用户看着文件名就知道里面是什么）；两边都写还不一致就拒，
  // 不许出现「文件名叫 .vtt、里面是 SRT 语法」这种要靠打开才发现的谎
  const extFormat = out ? formatFromExt(out) : null
  if (extFormat && formatGiven && extFormat !== format) {
    return { ok: false, message: `-f ${format} 和 -o 的后缀 .${extFormat} 说的不是一种格式，改一个` }
  }
  return {
    ok: true,
    args: {
      command: 'transcribe',
      file,
      out,
      format: extFormat ?? format,
      formatGiven,
      language,
      profileId,
      dataDir,
    },
  }
}

/** 内置那三个之外的 `--preset` 值只有「是一份档位文件」这一种可能；名字里带斜杠或后缀是 .json */
function isPresetPath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.toLowerCase().endsWith('.json')
}

/** 不收文件的那几条（help / version / mcp）共用的空壳：字段留默认值，下游不必各自判 undefined */
function emptyArgs(command: 'mcp' | 'help' | 'version', dataDir?: string): CliArgs {
  return { command, file: '', out: null, format: 'srt', formatGiven: false, dataDir }
}

/**
 * 可注入的那几只手：`run` 里不直接碰 `process`/`fetch`/磁盘，所以单测能把「应用没开」
 * 「token 对不上」「被取消」每一种都演一遍，不用真起一个 Electron。
 */
export interface CliIo {
  fetch: typeof fetch
  readEndpoint: (dir: string) => Promise<AgentEndpointRead>
  writeText: (path: string, text: string) => Promise<void>
  /** check 那一条读的文件都走这里（字幕那份，加上 --preset 指的那份档位）；transcribe 不读正文，素材交给应用去读 */
  readText: (path: string) => Promise<string>
  accessFile: (path: string) => Promise<unknown>
  /** 可以返回一个「刷完了」的 promise：最后一行产物走 stdout 时，run 会等它，免得管道那头拿到半截文件 */
  stdout: (chunk: string) => void | Promise<void>
  stderr: (chunk: string) => void
  cwd: string
  platform: NodeJS.Platform | string
  home: string
  env: Record<string, string | undefined>
  version: () => string
  /** 作业跑到一半时要能中断（Ctrl-C）；测试传一个已经 abort 的 signal 来走那条路 */
  signal: AbortSignal
  /** 门面回来的 jobId，用来在被打断时取消那一单 */
  onJobId: (jobId: string) => void
}

const STAGE_LABEL: Record<string, string> = {
  loading_model: '模型装载中',
  transcribing: '转写中',
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  const parsed = parseArgv(argv)
  if (!parsed.ok) {
    io.stderr(`vv: ${parsed.message}\n`)
    return 2
  }
  const args = parsed.args
  if (args.command === 'help') {
    await io.stdout(`${USAGE}\n`)
    return 0
  }
  if (args.command === 'version') {
    await io.stdout(`${io.version()}\n`)
    return 0
  }
  // check 在这里就分岔：下面那一整段都是「把参数拼成一个请求发给应用」，而 check 不发请求
  if (args.command === 'check') return runCheck(args, io)
  // mcp 也在这里分岔：它不自己产出，而是坐等客户端一行行喂请求。里面 transcribe 那一把仍然
  // 回头走下面这条路（run(['transcribe', …])），所以凭据与门面都只有那一份，壳里没有第二套
  if (args.command === 'mcp') return runMcp(args, io)

  // 应用那边的作业体认的是绝对路径：CLI 的 cwd 和应用的 cwd 不是一个东西（#374：CLI 是另一个进程）
  const filePath = isAbsolute(args.file) ? args.file : resolve(io.cwd, args.file)
  try {
    await io.accessFile(filePath)
  } catch {
    io.stderr(`vv: 这个文件读不到：${args.file}\n`)
    return 2
  }

  const dir = endpointDir(args, io)
  const endpoint = await io.readEndpoint(dir)
  if (endpoint.status !== 'ok') {
    io.stderr(`vv: ${explainEndpoint(endpoint, dir)}\n`)
    return 3
  }
  const { port, token } = endpoint.endpoint

  const body: Record<string, unknown> = { file: filePath }
  if (args.language) body.language = args.language
  if (args.profileId) body.profileId = args.profileId

  const base = { Authorization: `Bearer ${token}` }
  let res: Awaited<ReturnType<typeof io.fetch>>
  try {
    res = await io.fetch(`http://127.0.0.1:${port}/jobs/transcribe`, {
      method: 'POST',
      headers: { ...base, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: io.signal,
    })
  } catch (err) {
    io.stderr(`vv: ${explainConnect(err, port)}\n`)
    return io.signal.aborted ? 130 : 3
  }

  if (res.status === 401) {
    io.stderr(`vv: token 对不上（401）。这一份 token 是上一次运行留下的：应用重启过，token 每次运行换一个。\n`)
    return 3
  }
  if (!res.ok) {
    io.stderr(`vv: ${await facadeError(res, '提交作业')}\n`)
    return res.status >= 500 ? 1 : 2
  }

  const payload = (await res.json().catch(() => ({}))) as { jobId?: unknown }
  if (typeof payload.jobId !== 'string' || !payload.jobId) {
    io.stderr('vv: 门面回了 202 却没给 jobId（这一单没被记下来，去应用的日志里看那一句）\n')
    return 1
  }
  io.stderr('已提交，转写中…\n')
  io.onJobId(payload.jobId)

  return streamJob(port, token, payload.jobId, args, io)
}

/**
 * `GET /jobs/:id` 那一串 NDJSON：先补发缓冲区，再实时追，最后一行是 result。
 * 只打「有意义」的那几行（换档、装载模型、每出一段、收尾），不按每个事件刷一行——
 * 一段两分钟的素材能出几百个进度事件，那种输出没人读。
 */
async function streamJob(port: number, token: string, jobId: string, args: CliArgs, io: CliIo): Promise<number> {
  let res: Awaited<ReturnType<typeof io.fetch>>
  try {
    res = await io.fetch(`http://127.0.0.1:${port}/jobs/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: io.signal,
    })
  } catch (err) {
    io.stderr(`vv: ${explainConnect(err, port)}\n`)
    return io.signal.aborted ? 130 : 3
  }
  if (res.status === 404) {
    io.stderr('vv: 门面说没有这一单。多半是应用在这中间退出了（那一单的历史还在应用自己的账上）。\n')
    return 3
  }
  if (!res.ok || !res.body) {
    io.stderr(`vv: ${await facadeError(res, '取作业进度')}\n`)
    return 3
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let result: FacadeResultRow | null = null
  const shown = { segments: 0, finished: false }
  /*
    Ctrl-C 落点实测过一次：信号打在 `reader.read()` 的 await 上，那一支的 AbortError 不由上面那个
    fetch 的 try/catch 接（它只管建连接），于是整个 run 带着一个 Node 栈退出、退成 1 而不是 130。
    所以读循环自己得有一道 catch；抛上来的东西不外传，只在这里落成一句话——
    是不是「被打断」由下面 `io.signal.aborted` 那支判，不用在这里认异常名字。
  */
  let streamError: unknown = null

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let cut = pending.indexOf('\n')
      while (cut >= 0) {
        const line = pending.slice(0, cut).trim()
        pending = pending.slice(cut + 1)
        if (line) {
          const row = parseRow(line)
          if (row) {
            if (row.type === 'result') result = row as FacadeResultRow
            else report(row, shown, io)
          }
        }
        cut = pending.indexOf('\n')
      }
    }
  } catch (err) {
    streamError = err
  }

  if (!result) {
    if (io.signal.aborted) {
      // dev 实测：Ctrl-C 落在这一带时这一支原先一声不响就退 130，只有下面那两处建连接的落点会说话
      io.stderr(`vv: ${CANCELED_NOTE}\n`)
      return 130
    }
    const why = streamError
      ? `：${firstLine(streamError instanceof Error ? streamError.message : String(streamError))}`
      : ''
    io.stderr(`vv: 连接断了，没等到结果那一行${why}（应用退出了？这一单可能被中断）。\n`)
    return 1
  }
  if (!result.success) {
    // dev 实测：这一支的 error 串是「人话那句 + 冒号 + 工具的整段输出」（喂一个假 .mp4，ffprobe
    // 把它十几行版本横幅一起带上来）。CLI 的口径是一句话，所以只取第一行——完整原文在应用的日志里。
    const reason = firstLine(result.error ?? '') || '应用没说原因'
    io.stderr(`vv: 这一单没成：${reason}\n`)
    return 1
  }

  const segments = result.segments ?? []
  if (segments.length === 0) {
    io.stderr('vv: 这一单回来是空的（0 段）。要么这段素材没有语音，要么引擎那边没出词。\n')
    return 1
  }
  const text = exportTranscript(asSegments(segments), args.format)
  if (args.out) {
    const target = isAbsolute(args.out) ? args.out : resolve(io.cwd, args.out)
    try {
      await io.writeText(target, text)
    } catch (err) {
      io.stderr(`vv: 写不下去 ${args.out}：${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
    io.stderr(`已写入 ${basename(target)}（${segments.length} 段 · ${args.format.toUpperCase()}）\n`)
    return 0
  }
  io.stdout(text)
  // 产物之外什么都不往 stdout 喷：管道那头可能直接就是 .srt 文件
  io.stderr(`已输出到 stdout（${segments.length} 段 · ${args.format.toUpperCase()}）\n`)
  return 0
}

/**
 * 凭据所在的目录：`--data-dir` 优先，其余按 #376 那份公式算。
 * 取消那一单也读它——只让 `--data-dir` 管提交不管取消的话，Ctrl-C 会把单子留在应用里继续跑。
 * dev 实测过公式那条支：`pnpm dev` 起的应用把 agent-api.json 落在公式算出的那个目录里
 * （主进程早就把 app.name 钉成打包那份的名字，不是 `Electron`），所以不带 `--data-dir` 也找得到；
 * 这一项留着的用处是手改 `--user-data-dir` 跑测试、或自定义 XDG_CONFIG_HOME 那类不在公式里的落点。
 */
function endpointDir(args: Pick<CliArgs, 'dataDir'>, io: Pick<CliIo, 'platform' | 'home' | 'env'>): string {
  return args.dataDir ?? userDataDirFor(io.platform, io.home, io.env)
}

/** 应用那侧的 error 串可能带一整段工具输出，人在 CLI 里要的是第一句 */
function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? ''
}

// ——— check：一份文件 + 一份档位，全程不碰门面 ————————————————————————

/**
 * 字幕文件的体积上限：`vv check` 认的是文本。把素材路径错手打过来（几百 MB 的 mp4）时，
 * 读进内存再逐行判定只会刷一屏乱码，而且在被当成文件读完之前没有人知道走错了门。
 * 八百万字节差不多是二十万条字幕，现实中没有一份字幕文件会先到这里。
 * 按 1000 而不是 1024 折：报错里那个数走 `formatBytes`（全仓唯一那把尺，SI），两边必须是同一把，
 * 否则会出现「上限 8MB 的文件被念成 8.4MB」这种看着像换算坏了的话。
 */
const MAX_SUBTITLE_BYTES = 8 * 1000 * 1000

type PresetLoad = { ok: true; preset: SubtitlePreset } | { ok: false; message: string }

/**
 * 档位从哪来：内置那三个是随包的（已经在装载时被 validatePreset 过了一遍），
 * 其余按路径读一份 JSON，并且**必须**过同一个 validatePreset。
 * 手改那份少写一条规则、或者少写 cite/source 就直接拒掉：绕过这道闸等于让报错里的「依据」那一栏变空，
 * 而那一栏是这套判定对外人唯一成立的理由（出处是二手转述，不是官方红线）。
 */
async function loadPreset(spec: string | undefined, io: CliIo): Promise<PresetLoad> {
  if (spec === undefined) return fromResult(builtinPreset(DEFAULT_PRESET_ID), `内置档位 ${DEFAULT_PRESET_ID}`)
  if (BUILTIN_PRESET_IDS.includes(spec)) return fromResult(builtinPreset(spec), `内置档位 ${spec}`)
  const path = isAbsolute(spec) ? spec : resolve(io.cwd, spec)
  let raw: unknown
  try {
    raw = JSON.parse(await io.readText(path)) as unknown
  } catch (err) {
    return {
      ok: false,
      message: `档位文件读不了：${spec}（${firstLine(err instanceof Error ? err.message : String(err))}）。`
        + `要用内置那档就别写路径：${BUILTIN_PRESET_IDS.join(' / ')}`,
    }
  }
  const loaded = validatePreset(raw, spec)
  return loaded.ok ? loaded : { ok: false, message: `档位文件用不了：${loaded.errors.join('；')}` }
}

/** 内置档位装载不了＝随包文件写坏了，跟「用户给的那份不行」说的是两种话 */
function fromResult(loaded: PresetResult, where: string): PresetLoad {
  return loaded.ok ? loaded : { ok: false, message: `${where}装载不了：${loaded.errors.join('；')}` }
}

/**
 * 报告整份走 stdout（管道那头可能就是 `> check.txt`），只有失败才往 stderr 说话。
 * 退出码直接取报告里那一个：门槛是「有没有 error 级」，warn/info 都不拦路——这个口径由校验器定，
 * CLI 不自己数 findings，否则两边各有一套「算不算过了」的判式。
 */
async function runCheck(args: CliArgs, io: CliIo): Promise<number> {
  const filePath = isAbsolute(args.file) ? args.file : resolve(io.cwd, args.file)
  try {
    await io.accessFile(filePath)
  } catch {
    io.stderr(`vv: 这个文件读不到：${args.file}\n`)
    return 2
  }
  const loaded = await loadPreset(args.preset, io)
  if (!loaded.ok) {
    io.stderr(`vv: ${loaded.message}\n`)
    return 2
  }
  let text: string
  try {
    text = await io.readText(filePath)
  } catch (err) {
    io.stderr(`vv: 读不了 ${args.file}：${firstLine(err instanceof Error ? err.message : String(err))}\n`)
    return 2
  }

  const report = checkSubtitleText(text, { preset: loaded.preset, fps: args.fps ?? null })
  const body = args.json ? JSON.stringify(report, null, 2) : renderReport(report, args.file)
  await io.stdout(`${body}\n`)
  return report.exitCode
}

// ——— mcp：三把 tool 的壳，一件逻辑都不在这里实现 ——————————————————————

/**
 * 客户端先报它自己那版协议，服务端不支持时回自己支持的最新一版——协议里就这一处版本协商。
 * 这三串是 2024-11 到 2025-06 之间实际在用的；对不上就回第一串，不猜没公布过的版本号。
 */
const MCP_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

/**
 * `tools/call` 的两种失败形状是两种事，各走各的通道：参数本身不合法＝请求写错了，走 JSON-RPC 的
 * `error`（-32602）；参数对但活儿没干成（应用没开、文件读不到）＝一次成了形的工具失败，走
 * `isError`，原因原样放在正文里。把后者也报成 -32602 会让客户端显示「参数不对」，而真正的话是「应用没开」。
 */
type McpBody = { result: Record<string, unknown> } | { error: { code: number; message: string } }

export interface McpCtx {
  io: CliIo
  /** `vv mcp --data-dir` 那一个，原样喂给里面那条 transcribe，让它找得到 agent-api.json */
  dataDir?: string
}

export const TOOL_NAMES = ['transcribe', 'check', 'export'] as const

/**
 * 三把 tool 的清单。描述里写的都是「这一把转给了谁」，因为这一层对外只有那一条承诺：
 * agent 拿到的结论，与人在终端里敲 `vv transcribe` / `vv check` 拿到的同一个字。
 */
export function toolSpecs(): Record<string, unknown>[] {
  return [
    {
      name: 'transcribe',
      description:
        '把一份素材交给本机那个 Vv Transcribe 应用转写，回来的是 `vv transcribe` 打出的那份文本。'
        + '要应用开着、settings.json 根上有 "agentApi": "on"：这一把走的正是应用那侧的门面与 token，壳里没有第二套凭据。',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '素材的路径。绝对路径最稳：应用和这个进程不是一个 cwd' },
          format: {
            type: 'string',
            enum: [...FORMATS],
            description: '产物格式，默认 srt。json 出的是 startTime / endTime / text 那一段段（外加两个标志位）',
          },
          language: { type: 'string', description: '转写语言；不给就走应用当前的设置' },
          profileId: { type: 'string', description: '用哪套方案；不给就走应用当前的默认' },
        },
        required: ['file'],
      },
    },
    {
      name: 'check',
      description:
        '判一份字幕文件上不了得上屏，等于 `vv check --json`：回来的是整份校验报告，越线的条目一条不少，'
        + '每条都带 cite 与 source。红没红看报告里的 exitCode（1＝有 error 级结果），那是一份判完了的报告，不是这一把失败了。',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '字幕文件（SRT 或 VTT，按内容认，不用标）' },
          preset: {
            type: 'string',
            description: `内置档位名（${BUILTIN_PRESET_IDS.join(' / ')}）或一份 .json 路径；不给就用 ${DEFAULT_PRESET_ID}（只提示、不拦路）`,
          },
          fps: { type: 'number', description: '那一部片子的帧率，比如 25 或 23.976；只有给了它，帧格对齐那一条才跑得起来' },
        },
        required: ['file'],
      },
    },
    {
      name: 'export',
      description:
        '把 segments 导出成某一种字幕或台词格式，用的就是界面导出那一个函数（exportTranscript）。'
        + '改过内容的 agent 用这一把出盘，别自己拼 SRT：自己拼的时间取整口径与界面不一致时，vv check 会报出你根本没改过的那一处。',
      inputSchema: {
        type: 'object',
        properties: {
          segments: {
            type: 'array',
            description:
              '段落数组，每项 {startTime, endTime, text}，时间单位是秒。'
              + 'transcribe 那把 format=json 出来的就是它（多出来的 isEdited / isCorrected 会被忽略）',
            items: {
              type: 'object',
              properties: {
                startTime: { type: 'number' },
                endTime: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['startTime', 'endTime', 'text'],
            },
          },
          format: { type: 'string', enum: [...FORMATS], description: '默认 srt' },
        },
        required: ['segments'],
      },
    },
  ]
}

/**
 * 一行请求进、一行回话出；通知（没有 id）按协议不许回话，返回 null。
 * stdin/stdout 的接线全在 `runMcp` 那三行里，协议怎么答在这里——所以测的是这里。
 */
export async function handleMcpLine(line: string, ctx: McpCtx): Promise<string | null> {
  let msg: unknown
  try {
    msg = JSON.parse(line) as unknown
  } catch {
    return rpcLine(null, { error: { code: -32700, message: `这一行不是 JSON：${firstLine(line).slice(0, 80)}` } })
  }
  if (Array.isArray(msg)) {
    return rpcLine(null, { error: { code: -32600, message: '不接批量：一条消息占一行' } })
  }
  const req = msg as { id?: string | number | null; method?: unknown; params?: unknown }
  const id = req.id ?? null
  if (typeof req.method !== 'string') {
    return rpcLine(id, { error: { code: -32600, message: '这一条没有 method，不是请求' } })
  }
  const wantsReply = req.id !== undefined && req.id !== null
  switch (req.method) {
    case 'initialize': {
      const asked = (req.params as { protocolVersion?: unknown } | undefined)?.protocolVersion
      const protocolVersion = typeof asked === 'string' && MCP_PROTOCOLS.includes(asked) ? asked : MCP_PROTOCOLS[0]
      return rpcLine(id, {
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'vv', version: ctx.io.version() },
        },
      })
    }
    case 'ping':
      return wantsReply ? rpcLine(id, { result: {} }) : null
    case 'tools/list':
      return wantsReply ? rpcLine(id, { result: { tools: toolSpecs() } }) : null
    case 'tools/call':
      return wantsReply ? rpcLine(id, await callTool(req.params, ctx)) : null
    default:
      return wantsReply
        ? rpcLine(id, {
            error: {
              code: -32601,
              message: `不认得的方法：${req.method}。这一版只有 initialize / ping / tools/list / tools/call，通知类的方法不回话`,
            },
          })
        : null
  }
}

async function callTool(params: unknown, ctx: McpCtx): Promise<McpBody> {
  const p = (params ?? {}) as { name?: unknown; arguments?: Record<string, unknown> }
  if (typeof p.name !== 'string') return badArgs('tools/call 少了 name')
  const args = p.arguments ?? {}
  if (p.name === 'transcribe') return toolTranscribe(args, ctx)
  if (p.name === 'check') return toolCheck(args, ctx)
  if (p.name === 'export') return toolExport(args)
  return badArgs(`这一版只有 ${TOOL_NAMES.join(' / ')} 这三把（收到的是「${p.name}」）`)
}

async function toolTranscribe(args: Record<string, unknown>, ctx: McpCtx): Promise<McpBody> {
  const file = argText(args.file)
  if (!file) return badArgs('transcribe 要一个 file：素材的路径')
  const format = formatArg(args.format, 'srt')
  if (!format) return badArgs(`format 只认 ${FORMATS.join(' / ')}，收到的是「${String(args.format)}」`)
  const argv = ['transcribe', file, '-f', format]
  const language = argText(args.language)
  if (language) argv.push('--language', language)
  const profileId = argText(args.profileId)
  if (profileId) argv.push('--profile', profileId)
  if (ctx.dataDir) argv.push('--data-dir', ctx.dataDir)
  const ran = await throughRun(argv, ctx.io)
  // 连不上应用（3）、这一单失败（1）、被打断（130）的原因都在 stderr 那句话里，原样转给 agent，不在这里改口
  if (ran.code !== 0) return toolFail(ran.err || `transcribe 退成 ${ran.code}：应用开着没、agentApi 开关打开没`)
  return toolText(ran.out)
}

async function toolCheck(args: Record<string, unknown>, ctx: McpCtx): Promise<McpBody> {
  const file = argText(args.file)
  if (!file) return badArgs('check 要一个 file：字幕文件的路径')
  const argv = ['check', file, '--json']
  const preset = argText(args.preset)
  if (preset) argv.push('--preset', preset)
  if (args.fps !== undefined && args.fps !== null) {
    const fps = typeof args.fps === 'number' ? args.fps : Number(args.fps)
    if (!Number.isFinite(fps) || fps <= 0) {
      return badArgs(`fps 要的是一个大于 0 的数（那一部片子的帧率），收到的是「${String(args.fps)}」`)
    }
    argv.push('--fps', String(fps))
  }
  const ran = await throughRun(argv, ctx.io)
  // 0 与 1 都是「判完了」：红没红写在报告的 exitCode 里。这一层把它读成工具失败，agent 就再也拿不到那 300 条了
  if (ran.code > 1) return toolFail(ran.err || `check 退成 ${ran.code}`)
  return toolText(ran.out)
}

function toolExport(args: Record<string, unknown>): McpBody {
  const format = formatArg(args.format, 'srt')
  if (!format) return badArgs(`format 只认 ${FORMATS.join(' / ')}，收到的是「${String(args.format)}」`)
  const list = args.segments
  if (!Array.isArray(list)) {
    return badArgs('export 要一份 segments：[{startTime, endTime, text}, …]，transcribe 那把 format=json 出来的就是它')
  }
  const rows: { startTime: number; endTime: number; text: string }[] = []
  for (let i = 0; i < list.length; i++) {
    const row = list[i] as { startTime?: unknown; endTime?: unknown; text?: unknown } | null
    if (typeof row?.startTime !== 'number' || typeof row?.endTime !== 'number' || typeof row.text !== 'string') {
      return badArgs(`segments 第 ${i + 1} 项不像一段：要 {startTime, endTime, text}，时间单位是秒`)
    }
    rows.push({ startTime: row.startTime, endTime: row.endTime, text: row.text })
  }
  if (rows.length === 0) {
    return badArgs('segments 是空数组：导出来也是一份空文件。这一把不替你决定「交一份空字幕」是不是你想要的')
  }
  return toolText(exportTranscript(asSegments(rows), format))
}

/**
 * 把 CLI 自己那条路再跑一遍，产物从 stdout 收进来、给人看的话从 stderr 收进来（同时照样往真
 * stderr 打一份——那是 MCP 服务端唯一的日志去处）。transcribe 与 check 都只从这里过，
 * 所以「壳里没有第二套实现」不是注释里的一句话：这两把能拿到的就是那两条子命令的输出。
 */
async function throughRun(argv: string[], io: CliIo): Promise<{ code: number; out: string; err: string }> {
  const buf = { out: '', err: '' }
  const code = await run(argv, {
    ...io,
    stdout: (chunk) => {
      buf.out += chunk
    },
    stderr: (chunk) => {
      buf.err += chunk
      io.stderr(chunk)
    },
  })
  return { code, out: buf.out, err: buf.err }
}

function argText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** 参数里的 format：不给就用 fallback，给了不在那六档里就返回 null，让调用点自己说人话 */
function formatArg(value: unknown, fallback: ExportFormat): ExportFormat | null {
  if (value === undefined || value === null) return fallback
  return typeof value === 'string' ? FORMATS.find((f) => f === value) ?? null : null
}

function toolText(content: string): McpBody {
  return { result: { content: [{ type: 'text', text: content }] } }
}

function toolFail(message: string): McpBody {
  return { result: { content: [{ type: 'text', text: message }], isError: true } }
}

function badArgs(message: string): McpBody {
  return { error: { code: -32602, message } }
}

function rpcLine(id: string | number | null, body: McpBody): string {
  return JSON.stringify({ jsonrpc: '2.0', id, ...body })
}

/**
 * stdio 接线。stdout 在这一条路上是协议通道，所以除了回话什么都不许往里写——
 * `vv transcribe` 那侧「进度走 stderr」的规矩在这里更硬：进度混进 stdout 就等于把整条链接打断。
 *
 * 一次只跑一把：转写要几分钟，这期间客户端的 ping 排在后面。要真并行得应用那侧先支持多个作业
 * 各自排队，不是在这一层加并发——这一层没有可并发的东西，它只是把请求转给那两条子命令。
 *
 * `process.stdin` 是这里唯一没走 `CliIo` 的手：为它加一层抽象只为让测试能塞一个假流，
 * 而协议怎么答已经由 `handleMcpLine` 全测到了，这三行剩下的只有接线。
 */
async function runMcp(args: CliArgs, io: CliIo): Promise<number> {
  const ctx: McpCtx = { io, dataDir: args.dataDir }
  io.stderr('vv mcp: 在读 stdin（一行一条 JSON-RPC）。这一把不监听端口；transcribe 那把要应用开着。\n')
  const lines = createInterface({ input: process.stdin, terminal: false })
  for await (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const reply = await handleMcpLine(trimmed, ctx)
    if (reply === null) continue
    await io.stdout(`${reply}\n`)
  }
  return 0
}

/** 一行 NDJSON；半截或不是 JSON 就报一句，不静默丢——丢了用户看到的段数就是假的 */
function parseRow(line: string): FacadeRow | null {
  try {
    const row = JSON.parse(line) as FacadeRow
    return typeof row === 'object' && row !== null && 'type' in row ? row : null
  } catch {
    return null
  }
}

/**
 * 进度行的三种形状各打一行，段号自己数（门面那侧没有「第几段」，只有引擎每出一段发一条）。
 * `shown` 是这次运行里已经打过的：收尾那条 progress=100 会来两次（引擎流式那一单的最后一条、
 * 作业体自己收口那一条），dev 实测就刷出两行「转写完成，收结果」——同一条消息打两遍，
 * 读起来像是出了两段而实际只有一段收尾。
 */
function report(row: FacadeRow, shown: { segments: number; finished: boolean }, io: CliIo): void {
  if (row.type !== 'progress') return
  const event = row as FacadeProgressRow
  if (event.segment) {
    shown.segments += 1
    io.stderr(`第 ${shown.segments} 段出来了：${Math.round(event.progress ?? 0)}%\n`)
    return
  }
  if (event.stage) {
    const model = event.model?.tier ? `（${event.model.tier}）` : ''
    io.stderr(`${STAGE_LABEL[event.stage] ?? event.stage}${model}\n`)
    return
  }
  if (event.progress === 100 && !shown.finished) {
    shown.finished = true
    io.stderr('转写完成，收结果\n')
  }
}

/**
 * 作业体回的是引擎原样三段（startTime / endTime / text），导出器要的是界面那副形状。
 * id 用序号而不是 UUID：这一份只在下一个进程里活一次，没有跨会话引用它的人。
 */
function asSegments(list: { startTime: number; endTime: number; text: string }[]): TranscriptionSegment[] {
  return list.map((segment, index) => ({
    id: String(index + 1),
    startTime: segment.startTime,
    endTime: segment.endTime,
    text: segment.text,
    isEdited: false,
    isCorrected: false,
  }))
}

/**
 * 三种「读不到凭据」是三种不同的事，得说不同的话：missing 是没人开了这个开关，
 * invalid 是文件在但用不了（手改坏、半截、上一个版本留下的），
 * 而连不上端口是「应用跑过、现在不在了」。把它们都念成「应用没在跑」会把人引去重启一个本来就在跑的应用。
 */
function explainEndpoint(endpoint: AgentEndpointRead, dir: string): string {
  if (endpoint.status === 'missing') {
    return `这里没有 agent-api.json（${dir}）。两种可能：Vv Transcribe 没在跑，或者它跑的时候 agentApi 开关是关的——`
      + '后者要在 settings.json 根上加一行 "agentApi": "on" 并重启应用（这一步决定本机开不开那个监听端口，所以默认是关）'
  }
  if (endpoint.status === 'invalid') {
    return `agent-api.json 读不懂：${endpoint.reason}（在 ${dir}）。`
      + '删掉它再重启应用，会让应用重新落一份'
  }
  // 调用点已经认过 status !== 'ok'，这一支走不到；留着是因为联合类型 narrowing 之后编译器不认别的写法
  return `这份凭据用不了（在 ${dir}）`
}

/** Ctrl-C 有三个落点（提交那一发、建流那一发、读流那一带），要说同一句话，所以文案只留一份 */
const CANCELED_NOTE = '被取消了（Ctrl-C），那一单已经顺手发给门面取消'

function explainConnect(err: unknown, port: number): string {
  if (err instanceof Error && err.name === 'AbortError') return CANCELED_NOTE
  return `端口 ${port} 上没人应答。这份凭据文件是某次运行留下的，而那次运行已经结束了——重启应用会重新落一份`
}

async function facadeError(res: Awaited<ReturnType<typeof fetch>>, step: string): Promise<string> {
  const fallback = `门面在${step}这一步回了 HTTP ${res.status}`
  try {
    const body = (await res.json()) as { error?: string }
    return body.error ? `${body.error}` : fallback
  } catch {
    return fallback
  }
}

/** 打包版在 app.asar 根上，dev 在项目根上，两处都是「往上两层」——这一句在两种环境下都要成 */
function readVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const doc = require(join('..', '..', 'package.json')) as { version?: string }
    return doc.version ?? '未知版本'
  } catch {
    return '未知版本'
  }
}

export function realIo(signal: AbortSignal, onJobId: (jobId: string) => void): CliIo {
  return {
    fetch,
    readEndpoint: readAgentEndpoint,
    writeText: (path, text) => writeFile(path, text, 'utf-8'),
    readText: async (path) => {
      const info = await stat(path)
      if (info.size > MAX_SUBTITLE_BYTES) {
        throw new Error(
          `它有 ${formatBytes(info.size)}，check 判的是字幕文件那种文本（素材请交给 transcribe）`,
        )
      }
      return readFile(path, 'utf-8')
    },
    accessFile: (path) => access(path),
    // 走管道时 stdout 是异步的：不等刷完就退，重定向出来的文件可能被截掉最后一块
    stdout: (chunk) => new Promise<void>((flushed) => void process.stdout.write(chunk, () => flushed())),
    stderr: (chunk) => process.stderr.write(chunk),
    cwd: process.cwd(),
    platform: process.platform,
    home: homedir(),
    env: process.env as Record<string, string | undefined>,
    version: readVersion,
    signal,
    onJobId,
  }
}

/**
 * Ctrl-C 不只是退出：那一单还在应用里跑着。先把编号发给门面取消，再收尾退出，
 * 否则「按下 Ctrl-C 的 CLI」会在应用里留一个没人看的转写任务（它还会占着引擎）。
 */
export async function main(argv: string[]): Promise<number> {
  const controller = new AbortController()
  let jobId = ''
  const io = realIo(controller.signal, (id) => {
    jobId = id
  })
  const parsed = parseArgv(argv)
  const dir = parsed.ok ? endpointDir(parsed.args, io) : userDataDirFor(io.platform, io.home, io.env)
  const onInterrupt = () => {
    controller.abort()
    if (!jobId) return
    // 取消用的是同一份凭据；这里失败也不重要——进程马上就走，留一句在 stderr 够了
    void readAgentEndpoint(dir).then((endpoint) => {
      if (endpoint.status !== 'ok') return
      return fetch(`http://127.0.0.1:${endpoint.endpoint.port}/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${endpoint.endpoint.token}` },
      }).catch(() => undefined)
    })
  }
  process.on('SIGINT', onInterrupt)
  try {
    return await run(argv, io)
  } finally {
    process.off('SIGINT', onInterrupt)
  }
}

/**
 * 只有被当成入口跑时才动手（`ELECTRON_RUN_AS_NODE=1 …/vv.mjs`），单测从这里 import 函数才不会顺手真跑一趟。
 * 认法用「两边都归成文件系统路径再比」而不是比 URL：应用名字里带空格（Vv Transcribe.app），
 * 拿 URL 比就多一套编码规矩要担心，而 dev 与打包版吃的是同一条式子。
 *
 * 字面比不过再用 realpath 兜一层。ESM 那个 `import.meta.url` 是 Node realpath 过的，软链没消掉的话
 * 两边就对不上（2026-11-10 拿 `/tmp/…/app.asar/dist-electron/cli/vv.mjs` 跑打包形态实测到：不报错、
 * 不输出，直接退 0）。这种失败形状比报错坏得多——看着像成功了，而 agent 读到的是一份空产物。
 */
export function entryMatches(argvTarget: string | undefined, selfPath: string): boolean {
  if (!argvTarget) return false
  try {
    const target = resolve(argvTarget)
    return target === selfPath || realpathSync(target) === selfPath
  } catch {
    return false
  }
}

function invokedAsEntry(): boolean {
  return entryMatches(process.argv[1], fileURLToPath(import.meta.url))
}

if (invokedAsEntry()) {
  // 只设 exitCode，不 process.exit：真退出交给事件环排空，最后一行 stdout 已经等过刷盘
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((err: unknown) => {
      /*
        最后一道：没被 run 里那几处 catch 接住的意外，在 Node 24 里会变成「一段栈 + 退成 1」
        （Ctrl-C 那一支实测到的正是这个形状）。CLI 的失败形状是一句话加一个非零号，不该是栈。
      */
      process.stderr.write(`vv: 出错了：${firstLine(err instanceof Error ? err.message : String(err))}\n`)
      process.exitCode = 1
    })
}
