/**
 * 引擎冻结二进制冒烟（#235 路径 A：不需要额外机器的 CI 侧证）
 *
 * 为什么要这一条：#223 的数全是 M 系列 arm64 上取的，Intel Mac 与 Windows 一直是假设；
 * 而这两个平台最容易坏的偏偏是「PyInstaller 收原生库收得齐不齐」这一层——Windows 上
 * onnxruntime.dll 漏收、espeak-ng-data 的路径分隔符、macOS x64 的架构错配，全都是
 * **进程一拉起来就见分晓** 的那类问题，纯函数单测碰不到，界面用例更碰不到。
 *
 * 默认不跑：`pnpm test`（含 CI 的 ubuntu test 闸门）上没有这些二进制，也不该在纯函数闸门里
 * 拉起 24MB/69MB 的冻结产物。只有各平台构建 job 里带 `VV_ENGINE_SMOKE=1` 才跑，
 * 挂在已有的三平台矩阵之后，不为它单独烧一次 CI（按 [[avoid-wasteless-ci-runs]]）。
 *
 * 开关一开却找不到产物 = **直接红，不是跳过**。否则产物目录名或 exe 后缀一变，这一档就会
 * 静默退化成「只有 4 条判据在跑」，而 CI 三个 job 照样全绿——那种绿比红难发现得多。
 * 唯一合法的跳过是「出声档」：CI 不下 135MB/426MB 的模型，那一档恒为跳过。
 *
 * 分档，每档证的事不同、代价也不同，别把它们混成一句「冒烟过了」：
 * 1. 启动 + 身份握手：证 onefile 解包、Python 引导、顶层 import（TTS 的 fastapi/uvicorn/pydantic，
 *    ASR 再加一个 numpy）与端口都通，且 /health 回显的是本次给的 boot_id。
 * 2. 空模型目录要出 **503**：这一条才是「原生库齐」的真凭据。python-tts/main.py 的 load_engine()
 *    先 `import sherpa_onnx`（:137）再查文件（require_files），所以缺文件报 503、缺 dll 报 500——
 *    拿到 503 就等于看到 `_sherpa_onnx.pyd` / `libonnxruntime` 已经加载成功。
 * 3. 请求未绑定的那档引擎要出 **409**：证「一个进程只服务一个引擎」这条契约在产物里还在。
 * 4. ASR 只到握手为止：`from faster_whisper import WhisperModel` 是懒加载（python-asr/main.py:73），
 *    不跑一次真转写就证不到 torch/faster-whisper。真转写要 138MB 起步的权重，不在 CI 里下，
 *    那条留给路径 B（用户手测）。
 * 5. 真出一段声：只有这台机器已经有模型目录时才跑（再给一个 `VV_ENGINE_SMOKE_MODEL_DIR`）。
 *    CI 不下模型，所以这一档在 CI 里恒为跳过——想在那边拿 RTF，得先接受 135MB/426MB 的下载。
 *
 * 端口一律另取（18010/18011/18000），绝不碰应用正在用的 8010/8000：
 * 冒烟跑到开着的应用旁边，抢端口就是给别人制造「引擎坏了」的假故障。
 * 收尾按端口找 pid、按二进制名核验后再杀——只清自己这代，不做 `pkill -f vv-asr-server`
 * 那种会把构建进程一起带走的通配（见 [[asr-port-8000-orphan-hazard]]）。
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ENABLED = process.env.VV_ENGINE_SMOKE === '1'
const EXE = process.platform === 'win32' ? '.exe' : ''
/**
 * 产物按架构分目录，所以要用「产物那份架构」而不是 Node 自己的架构来找：
 * CI 的 macOS x64 job 跑在 arm64 runner 上，只有构建步骤被 `arch -x86_64` 按在 x64 里，
 * 那里的 process.arch 仍是 arm64——不设这个开关就会去找一份根本不存在的 dist-arm64。
 * 拉起 x64 产物靠 Rosetta（同 job 里已经 softwareupdate 装好）。
 */
const SMOKE_ARCH = process.env.VV_ENGINE_SMOKE_ARCH || process.arch
const TTS_BIN = join('python-tts', `dist-${SMOKE_ARCH}`, `vv-tts-server${EXE}`)
const ASR_BIN = join('python-asr', `dist-${SMOKE_ARCH}`, `vv-asr-server${EXE}`)

/** 与 python-tts/main.py 的 TTS_PROTOCOL、python-asr/main.py 的 TRANSCRIBE_PROTOCOL 对齐；
 *  下面第一条常开用例会把这两个数跟源码比一遍，改了源码忘了改测试就当场红。 */
const TTS_PROTOCOL = 1
const ASR_PROTOCOL = 2

const TTS_ENGINE = 'sherpa-onnx-vits-zh-ll'
const OTHER_ENGINE = 'kokoro-multi-lang-v1_1'

const TTS_PORT = 18010
const TTS_AUDIO_PORT = 18011
const ASR_PORT = 18000

/** onefile 首次解包 + Windows runner 本来就慢，本机 arm64 那 0.22–0.86 秒不构成参照 */
const START_TIMEOUT_MS = 180_000
const POLL_MS = 500
/** Vitest 的 hookTimeout 默认只有 10s，够不到「在 beforeAll 里拉起一个冻结产物」这件事 */
const START_HOOK_MS = START_TIMEOUT_MS + 60_000
const STOP_HOOK_MS = 90_000

interface Health {
  status?: string
  engine?: string | null
  engine_loaded?: string | null
  speakers?: number
  sample_rate?: number
  protocol?: number
  boot_id?: string
  model_loaded?: boolean
  model?: string
  engines?: string[]
}

interface Sidecar {
  /** 冻结产物的文件名，按它核验端口上的监听者是不是我们这代 */
  name: string
  port: number
  bootId: string
  proc: ChildProcess | null
  pid: number | null
  /** 引擎自己的 stdout/stderr，失败时原样带进测试输出 */
  out: string
}

/** 拉起来的东西都记在这，收尾逐个清 */
const live: Sidecar[] = []

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function capture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(err ? '' : `${stdout}${stderr}`)
    })
  })
}

async function listPortPids(port: number): Promise<number[]> {
  const pids = new Set<number>()
  if (process.platform === 'win32') {
    const out = await capture('netstat', ['-ano', '-p', 'tcp'])
    for (const line of out.split('\n')) {
      const cols = line.trim().split(/\s+/)
      if (cols[0] !== 'TCP' || !cols[1]?.endsWith(`:${port}`) || cols[3] !== 'LISTENING') continue
      const pid = Number(cols[cols.length - 1])
      if (Number.isInteger(pid) && pid > 0) pids.add(pid)
    }
    return [...pids]
  }
  const out = await capture('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'])
  for (const line of out.split('\n')) {
    const pid = Number(line.trim())
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

/** 只认我们自己的二进制名：端口上站着别的东西时宁可留着它，也不能误杀 */
async function isOurBinary(pid: number, name: string): Promise<boolean> {
  const out =
    process.platform === 'win32'
      ? await capture('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
      : await capture('ps', ['-p', String(pid), '-o', 'comm='])
  return out.includes(name)
}

/**
 * 收掉本次这一代：先按进程组（POSIX 下 spawn 时 detached，组里只有我们自己和派生的孙），
 * 再按端口补刀（Windows 的 PyInstaller 引导进程退了不会带走解释器子进程，那个才是在 listen 的）。
 * 直接子进程已经自己退了就不碰组号——组长没了之后组号可能被复用，那时只有端口证据是安全的。
 */
async function stopSidecar(s: Sidecar): Promise<void> {
  const idx = live.indexOf(s)
  if (idx >= 0) live.splice(idx, 1)

  const targets = new Set<number>()
  if (s.proc && s.pid) {
    try {
      process.kill(-s.pid, 'SIGKILL')
    } catch {
      /* 组已经没了 */
    }
  }
  for (const pid of await listPortPids(s.port)) {
    if (!(await isOurBinary(pid, s.name))) continue
    targets.add(pid)
    const ppid = Number((await capture('ps', ['-o', 'ppid=', '-p', String(pid)])).trim())
    if (Number.isInteger(ppid) && ppid > 1 && (await isOurBinary(ppid, s.name))) targets.add(ppid)
  }
  for (const pid of targets) {
    try {
      if (process.platform === 'win32') await capture('taskkill', ['/PID', String(pid), '/T', '/F'])
      else process.kill(pid, 'SIGKILL')
    } catch {
      /* 已经退了 */
    }
  }
  for (let i = 0; i < 20; i++) {
    if ((await listPortPids(s.port)).length === 0) return
    await sleep(300)
  }
  throw new Error(`冒烟收尾失败：${s.name} 还在 ${s.port} 端口上监听，请手动结束它`)
}

async function probeHealth(port: number): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    return (await res.json()) as Health
  } catch {
    return null
  }
}

/** 拿到「本次这个 boot_id」的应答才算就绪；别人的应答一律不采信（同 #128 的教训） */
async function waitForOwnHealth(s: Sidecar): Promise<Health> {
  const start = Date.now()
  while (Date.now() - start < START_TIMEOUT_MS) {
    if (!s.proc) {
      // 本机那份产物可能早于「端口可由环境变量改写」那次改动：它照样去绑 8000，
      // 报出来的却是 address already in use，看着像引擎坏了。给一句能直接行动的提示。
      const hint = /address already in use/.test(s.out)
        ? '\n提示：若报的端口不是冒烟指定的那个，说明这份冻结产物是旧的，重新 pnpm build:asr / pnpm build:tts 再跑。'
        : ''
      throw new Error(`${s.name} 启动后自己退了，引擎输出尾部：\n${s.out.slice(-1500)}${hint}`)
    }
    const info = await probeHealth(s.port)
    if (info?.boot_id === s.bootId) return info
    await sleep(POLL_MS)
  }
  throw new Error(
    `${s.name} 在 ${START_TIMEOUT_MS / 1000}s 内没回出本次 boot_id=${s.bootId}；引擎输出尾部：\n${s.out.slice(-1500)}`,
  )
}

/**
 * 拉起一份冻结产物并等它自报身份。boot id 在这里现生成、现下发，
 * 所以下面所有用例读的 /health 都必然是本次这一代。
 */
async function startSidecar(opts: {
  bin: string
  name: string
  port: number
  bootIdKey: string
  env: Record<string, string>
}): Promise<Sidecar> {
  const s: Sidecar = { name: opts.name, port: opts.port, bootId: randomUUID(), proc: null, pid: null, out: '' }
  const proc = spawn(opts.bin, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, [opts.bootIdKey]: s.bootId, ...opts.env },
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  s.proc = proc
  s.pid = proc.pid ?? null
  proc.stdout?.on('data', (d) => {
    s.out += String(d)
  })
  proc.stderr?.on('data', (d) => {
    s.out += String(d)
  })
  proc.on('exit', (code, signal) => {
    s.out += `\n[exit code=${code} signal=${signal}]`
    s.proc = null
  })
  live.push(s)
  await waitForOwnHealth(s)
  return s
}

async function synthesize(s: Sidecar, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${s.port}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(START_TIMEOUT_MS),
  })
}

const binsPresent = existsSync(TTS_BIN) && existsSync(ASR_BIN)
const MODEL_PARENT = process.env.VV_ENGINE_SMOKE_MODEL_DIR || ''
const AUDIO_ENGINE = process.env.VV_ENGINE_SMOKE_ENGINE || OTHER_ENGINE
const audioReady = ENABLED && binsPresent && !!MODEL_PARENT && existsSync(join(MODEL_PARENT, AUDIO_ENGINE))

// 这里刻意不写「产物不在就 console.info 一句然后跳过」：开关已经明确要跑冒烟了，
// 找不到产物却报绿，等于把这一档静默降级成「只有 3 条判据在跑」——产物目录名或
// exe 后缀一变就会发生，而 CI 那三个 job 照样全绿。缺产物必须是红的，判据在下面
// 「引擎冒烟的判据本身」里。唯一合法的跳过是出声档（CI 不下模型）。
if (ENABLED && binsPresent && MODEL_PARENT && !existsSync(join(MODEL_PARENT, AUDIO_ENGINE))) {
  console.info(`[engineSmoke] 出声档跳过：${join(MODEL_PARENT, AUDIO_ENGINE)} 不存在`)
}

/** 这一档不碰进程，所以永远跑——它是「协议号变了就去改冒烟」的常驻提醒 */
describe('引擎冒烟的判据本身', () => {
  it('开了开关就必须找得到两份冻结产物，否则六档会静默跳过、报出一条假绿', () => {
    if (!ENABLED) return
    expect(
      existsSync(TTS_BIN),
      `缺 TTS 产物 ${TTS_BIN}（按架构 ${SMOKE_ARCH} 找）。在该平台跑 pnpm build:tts，` +
        `或把 VV_ENGINE_SMOKE_ARCH 指到产物那份架构（CI 的 macOS x64 job 就得指，Node 自己是 arm64）。`,
    ).toBe(true)
    expect(
      existsSync(ASR_BIN),
      `缺 ASR 产物 ${ASR_BIN}（按架构 ${SMOKE_ARCH} 找）。在该平台跑 pnpm build:asr；` +
        `若产物是改动前那份，它不认 VV_ASR_PORT，会去抢 8000 然后自己退出。`,
    ).toBe(true)
  })

  it('写死的协议号与两份 sidecar 源码一致', async () => {
    const ttsSrc = await readFile('python-tts/main.py', 'utf-8')
    const asrSrc = await readFile('python-asr/main.py', 'utf-8')
    expect(ttsSrc).toMatch(new RegExp(`^TTS_PROTOCOL = ${TTS_PROTOCOL}$`, 'm'))
    expect(asrSrc).toMatch(new RegExp(`^TRANSCRIBE_PROTOCOL = ${ASR_PROTOCOL}$`, 'm'))
  })

  it('冒烟用的端口避开应用在用的 8010/8000', () => {
    const appPorts = [8010, 8000]
    for (const p of [TTS_PORT, TTS_AUDIO_PORT, ASR_PORT]) {
      expect(appPorts, `冒烟端口 ${p} 会和应用抢同一个端口`).not.toContain(p)
    }
  })

  it('ASR 的端口可由 VV_ASR_PORT 改写，默认仍是 8000', async () => {
    const src = await readFile('python-asr/main.py', 'utf-8')
    expect(src).toContain('os.environ.get("VV_ASR_PORT", "8000")')
  })
})

describe('引擎冻结二进制冒烟：配音', () => {
  const run = ENABLED && binsPresent
  let tts: Sidecar | null = null
  let emptyModelDir = ''

  beforeAll(async () => {
    if (!run) return
    emptyModelDir = await mkdtemp(join(tmpdir(), 'vv-engine-smoke-empty-'))
    tts = await startSidecar({
      bin: TTS_BIN,
      name: 'vv-tts-server',
      port: TTS_PORT,
      bootIdKey: 'VV_TTS_BOOT_ID',
      env: {
        VV_TTS_ENGINE: TTS_ENGINE,
        VV_TTS_MODEL_DIR: emptyModelDir,
        VV_TTS_PORT: String(TTS_PORT),
      },
    })
  }, START_HOOK_MS)

  afterAll(async () => {
    if (tts) await stopSidecar(tts)
    tts = null
    if (emptyModelDir) await rm(emptyModelDir, { recursive: true, force: true })
  }, STOP_HOOK_MS)

  it.skipIf(!run)(
    '回话即身份：boot_id 是本次给的、protocol 是 1、绑定引擎是钉死那档、且模型还没加载',
    async () => {
      const info = await probeHealth(TTS_PORT)
      expect(info, '/health 没应答').not.toBeNull()
      expect(info!.status).toBe('ok')
      expect(info!.protocol).toBe(TTS_PROTOCOL)
      expect(info!.boot_id).toBe(tts!.bootId)
      expect(info!.engine).toBe(TTS_ENGINE)
      expect(info!.engine_loaded, '启动不该顺手把模型读进内存').toBeNull()
      expect(info!.engines, '白名单应从产物里报出来').toEqual(expect.arrayContaining([TTS_ENGINE, OTHER_ENGINE]))
    },
    START_TIMEOUT_MS + 10_000,
  )

  it.skipIf(!run)(
    '模型目录是空的 → 503 点名缺哪些文件而不是 500：503 才证明 sherpa-onnx 的原生库加载成功',
    async () => {
      const res = await synthesize(tts!, { engine: TTS_ENGINE, text: '冒烟测试。', sid: 0, speed: 1 })
      const body = await res.text()
      expect(res.status, `期望 503（缺文件），实际 ${res.status}：${body.slice(0, 500)}`).toBe(503)
      expect(body).toContain('缺少文件')
      expect(body).toContain(TTS_ENGINE)
      // model.onnx 与 dict 都在 VITS 那档的 files 表里，缺了就一定出现在这句话里
      expect(body).toContain('model.onnx')
      expect(body).toContain('dict')
    },
    START_TIMEOUT_MS + 10_000,
  )

  it.skipIf(!run)(
    '请求没绑定的那档引擎必须 409：换引擎由宿主重起进程，不许静默加载第二份模型',
    async () => {
      const res = await synthesize(tts!, { engine: OTHER_ENGINE, text: '冒烟测试。', sid: 0, speed: 1 })
      const body = await res.text()
      expect(res.status, `期望 409，实际 ${res.status}：${body.slice(0, 500)}`).toBe(409)
      expect(body).toContain('换引擎请先让宿主重启该服务')
      const info = await probeHealth(TTS_PORT)
      expect(info!.engine, '被拒之后进程仍应绑在原引擎上').toBe(TTS_ENGINE)
      expect(info!.engine_loaded, '被拒的请求不该把任何模型读进内存').toBeNull()
    },
    START_TIMEOUT_MS + 10_000,
  )

  it.skipIf(!run)(
    '文本超过 2000 字要 413：这条兜底发生在加载引擎之前，所以没模型也能证',
    async () => {
      const res = await synthesize(tts!, { engine: TTS_ENGINE, text: '一'.repeat(2001) })
      const body = await res.text()
      expect(res.status, `期望 413，实际 ${res.status}：${body.slice(0, 500)}`).toBe(413)
      expect(body).toContain('2000')
      const info = await probeHealth(TTS_PORT)
      expect(info!.engine_loaded, '被拒的请求不该触发加载').toBeNull()
    },
    30_000,
  )
})

describe('引擎冻结二进制冒烟：转写', () => {
  const run = ENABLED && binsPresent

  it.skipIf(!run)(
    '回话即身份：boot_id + protocol 2；只到握手，faster_whisper 是懒加载，这条证不到 torch',
    async () => {
      const asr = await startSidecar({
        bin: ASR_BIN,
        name: 'vv-asr-server',
        port: ASR_PORT,
        bootIdKey: 'ASR_BOOT_ID',
        env: { VV_ASR_PORT: String(ASR_PORT) },
      })
      try {
        const info = await probeHealth(ASR_PORT)
        expect(info!.status).toBe('ok')
        expect(info!.protocol).toBe(ASR_PROTOCOL)
        expect(info!.boot_id).toBe(asr.bootId)
        expect(info!.model_loaded, '启动不该把 Whisper 权重读进内存').toBe(false)
        expect(info!.model, '没加载过就该是空串').toBe('')
      } finally {
        await stopSidecar(asr)
      }
    },
    START_TIMEOUT_MS + 30_000,
  )
})

/**
 * 出声档：只在「这台机器已经有模型目录」时跑（本机是 #246/#275 落下的 Kokoro）。
 * CI 不下模型，所以这一档在 CI 里恒为跳过。RTF 只打印不断言——它是本机性能画像，
 * 断言它只会让冒烟变成随机红；而且 macOS x64 的 runner 走 Rosetta，那个数不等于 Intel Mac。
 */
describe('引擎冻结二进制冒烟：真出一段声', () => {
  let s: Sidecar | null = null

  beforeAll(async () => {
    if (!audioReady) return
    s = await startSidecar({
      bin: TTS_BIN,
      name: 'vv-tts-server',
      port: TTS_AUDIO_PORT,
      bootIdKey: 'VV_TTS_BOOT_ID',
      env: {
        VV_TTS_ENGINE: AUDIO_ENGINE,
        VV_TTS_MODEL_DIR: MODEL_PARENT,
        VV_TTS_PORT: String(TTS_AUDIO_PORT),
      },
    })
  }, START_HOOK_MS)

  afterAll(async () => {
    if (s) await stopSidecar(s)
    s = null
  }, STOP_HOOK_MS)

  it.skipIf(!audioReady)(
    '一次真合成：RIFF/WAVE 头、采样数、时长三者自洽（不靠 ffprobe 估）',
    async () => {
      const res = await synthesize(s!, { engine: AUDIO_ENGINE, text: '这是一次引擎冒烟测试。', sid: 0, speed: 1 })
      // 响应体只许读一次，所以先落成 Buffer 再断状态码：非 200 时那是一份 JSON 错误，读成文本正好当消息
      const buf = Buffer.from(await res.arrayBuffer())
      expect(res.status, `合成失败 ${res.status}：${buf.subarray(0, 400).toString('utf-8')}`).toBe(200)
      expect(res.headers.get('content-type')).toContain('audio/wav')
      const samples = Number(res.headers.get('x-vv-samples'))
      const rate = Number(res.headers.get('x-vv-sample-rate'))
      const duration = Number(res.headers.get('x-vv-duration'))
      const wallMs = Number(res.headers.get('x-vv-wall-ms'))
      expect(Number.isInteger(samples) && samples > 0, '采样数为 0 等于没出声').toBe(true)
      expect(rate).toBeGreaterThan(0)
      expect(duration).toBeCloseTo(samples / rate, 5)

      expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF')
      expect(buf.subarray(8, 12).toString('ascii')).toBe('WAVE')
      expect(buf.readUInt32LE(4)).toBe(buf.length - 8)
      expect(buf.subarray(12, 16).toString('ascii')).toBe('fmt ')
      expect(buf.readUInt32LE(16), 'canonical PCM 头').toBe(16)
      expect(buf.readUInt16LE(20), 'PCM').toBe(1)
      expect(buf.readUInt16LE(22), '单声道').toBe(1)
      expect(buf.readUInt32LE(24)).toBe(rate)
      expect(buf.readUInt16LE(34), '16bit').toBe(16)
      expect(buf.subarray(36, 40).toString('ascii')).toBe('data')
      expect(buf.readUInt32LE(40)).toBe(samples * 2)
      // to_wav() 就是 44 字节头 + 16bit 单声道，字节数对不上等于形状变了
      expect(buf.length).toBe(44 + samples * 2)

      console.info(
        `[engineSmoke] ${AUDIO_ENGINE} sid=0 合成 ${duration.toFixed(2)}s 音频用了 ${wallMs}ms，` +
          `RTF=${(wallMs / 1000 / duration).toFixed(3)}（rate=${rate}）。` +
          `注意：macOS x64 的 CI runner 是 Rosetta 转译，那个数不等于 Intel Mac 的数。`,
      )

      const loaded = await probeHealth(TTS_AUDIO_PORT)
      expect(loaded!.engine_loaded, '合成过一次就该常驻了').toBe(AUDIO_ENGINE)
      expect(loaded!.speakers, '音色数应来自引擎加载后的 num_speakers').toBeGreaterThan(0)
      expect(loaded!.sample_rate).toBe(rate)
    },
    START_TIMEOUT_MS + 120_000,
  )
})

afterAll(async () => {
  for (const s of live.splice(0)) {
    await stopSidecar(s)
  }
}, STOP_HOOK_MS)
