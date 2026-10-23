/**
 * Python ASR 服务管理器
 * 负责在 Electron 主进程启动时自动拉起 Python ASR 子进程，退出时优雅关闭
 *
 * 二进制查找路径：
 * - 开发模式：python-asr/dist-<arch>/vv-asr-server[.exe]
 * - 打包模式：process.resourcesPath/python-asr/vv-asr-server[.exe]
 *
 * 启动流程：spawn 子进程 → 轮询 /health 直到「应答者确实是我拉起的那个」→ 标记服务可用
 * 关闭流程：对整个进程组 SIGTERM → 等待退出 → 超时升级 SIGKILL → 确认端口上不再有我这次的身份标识
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import { app } from 'electron'

const ASR_PORT = 8000
const ASR_URL = `http://localhost:${ASR_PORT}`
/** 与 python-asr/main.py 的 TRANSCRIBE_PROTOCOL 对应：2 = NDJSON 逐句流式 */
const ASR_PROTOCOL = 2
const HEALTH_TIMEOUT_MS = 60_000
const HEALTH_POLL_INTERVAL_MS = 500
const SHUTDOWN_TIMEOUT_MS = 5_000
/** 连续多少次应答来自别的实例就判定端口被占，不再空等满 60s */
const FOREIGN_ANSWER_LIMIT = 3

/**
 * 本次应用启动的身份标识，随 env 下发给引擎并由 /health 回显。
 * 只有对得上这个 id 的应答才代表「我拉起的引擎已经起来了」——
 * 上一代没退干净的残尸照样能应答 /health（它已加载的模块还在内存里），
 * 但它那份 PyInstaller 临时解包目录早被删了，任何懒加载的模块都会报
 * 「No module named ...」这种用户完全看不懂的错。
 */
const bootId = randomUUID()

interface AsrHealth {
  status?: string
  model_loaded?: boolean
  protocol?: number
  boot_id?: string
}

let asrProcess: ChildProcess | null = null
/** 进程退出后仍要按进程组补刀，所以 pid 要比 ChildProcess 活得久一点 */
let asrPid: number | null = null
/** 引擎进程的退出信息，仅用于把失败原因写进日志 */
let asrExitInfo: string | null = null
let asrReady = false
/** 未就绪时的用户可读原因，随转写失败一起展示，避免只留一句 fetch failed */
let asrError: string | null = null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 端口上探一次 /health；没人应答或应答不了就返回 null */
async function probeHealth(): Promise<AsrHealth | null> {
  try {
    const res = await fetch(`${ASR_URL}/health`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    return (await res.json()) as AsrHealth
  } catch {
    return null
  }
}

/** 获取 ASR 二进制文件路径（区分开发/打包环境，适配架构与 Windows .exe） */
function getBinaryPath(): string {
  const exeName = process.platform === 'win32' ? 'vv-asr-server.exe' : 'vv-asr-server'
  if (process.env.VITE_DEV_SERVER_URL) {
    // 开发模式：产物按架构分目录（dist-arm64 / dist-x64）
    return join(import.meta.dirname, '../../python-asr', `dist-${process.arch}`, exeName)
  }
  // 打包模式：extraResources 已将对应架构产物复制到 resources/python-asr/
  return join(process.resourcesPath, 'python-asr', exeName)
}

/**
 * faster-whisper("base") 的权重默认落在 HuggingFace 缓存里，repo 名由档位写死成
 * Systran/faster-whisper-base。命中缓存时给引擎下发 HF_HUB_OFFLINE=1：
 * huggingface_hub 平时每次加载都会向 hf-mirror 发一次「有没有新版本」的在线请求，
 * 弱网/挂代理时这一步能卡十几秒——模型明明已在本地，却被它拖成「首次加载慢了很多」。
 * 没命中缓存必须保持在线，否则用户第一次下载会直接失败，所以只在权重真的在场时才离线。
 */
function isModelCached(): boolean {
  const hubCache = process.env.HF_HUB_CACHE
    || process.env.HUGGINGFACE_HUB_CACHE
    || (process.env.HF_HOME ? join(process.env.HF_HOME, 'hub') : undefined)
    || join(homedir(), '.cache', 'huggingface', 'hub')

  const snapshots = join(hubCache, 'models--Systran--faster-whisper-base', 'snapshots')
  if (!existsSync(snapshots)) return false
  try {
    // 快照目录里的 model.bin 是指向 blobs/ 的软链，只有权重完整下载过才存在
    return readdirSync(snapshots).some((rev) => existsSync(join(snapshots, rev, 'model.bin')))
  } catch {
    return false
  }
}

/** 获取 ffmpeg/ffprobe 二进制路径（与 audioProcessor 逻辑一致） */
function getFfmpegBinaryPath(binaryName: string): string | null {
  const isPackaged = process.env.NODE_ENV === 'production' || app.isPackaged
  const platform = process.platform
  const arch = process.arch
  const binary = platform === 'win32' ? `${binaryName}.exe` : binaryName

  if (isPackaged) {
    const unpackedPath = join(
      process.resourcesPath || '',
      'app.asar.unpacked',
      'node_modules',
      `@${binaryName}-installer`,
      `${platform}-${arch}`,
      binary
    )
    if (existsSync(unpackedPath)) return unpackedPath
  }

  try {
    return require.resolve(`@${binaryName}-installer/${platform}-${arch}/${binary}`)
  } catch {
    return null
  }
}

/** 跑一条本机命令取 stdout；命令缺失、超时、报错一律返回空串，端口回收是尽力而为不能拖垮启动 */
function capture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout))
  })
}

/** 谁在监听 ASR 端口。查不到监听者时返回空数组，调用方必须据此放弃回收 */
async function listPortPids(): Promise<number[]> {
  const pids = new Set<number>()
  if (process.platform === 'win32') {
    const out = await capture('netstat', ['-ano', '-p', 'tcp'])
    for (const line of out.split('\n')) {
      const cols = line.trim().split(/\s+/)
      // TCP  0.0.0.0:8000  0.0.0.0:0  LISTENING  12345
      if (cols[0] !== 'TCP' || !cols[1]?.endsWith(`:${ASR_PORT}`) || cols[3] !== 'LISTENING') continue
      const pid = Number(cols[cols.length - 1])
      if (Number.isInteger(pid) && pid > 0) pids.add(pid)
    }
    return [...pids]
  }
  const out = await capture('lsof', ['-nP', `-tiTCP:${ASR_PORT}`, '-sTCP:LISTEN'])
  for (const line of out.split('\n')) {
    const pid = Number(line.trim())
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

/** 这个 pid 是不是我们自己的引擎：可执行文件名必须和本次要启动的那个二进制同名 */
async function isOurEngine(pid: number): Promise<boolean> {
  const exeName = basename(getBinaryPath()).toLowerCase()
  if (process.platform === 'win32') {
    const out = await capture('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
    return out.toLowerCase().includes(`"${exeName}"`)
  }
  const out = await capture('ps', ['-p', String(pid), '-o', 'comm='])
  return basename(out.trim().toLowerCase()) === exeName
}

/**
 * 把躺在端口上的上一代引擎收掉。
 * 应用被强杀或崩溃时 before-quit 不会跑，引擎就会作为孤儿（PPID=1）永远占着 8000；
 * 光靠 boot_id 握手只能做到「不采信它」，用户重启应用照样起不来，得能自己清掉才行。
 * 只杀命令行确认为我们自己二进制的那些进程，别人的程序一律不碰；
 * 成败以「端口上没有监听者」为准，不能拿 /health 没应答当成功——正在推理的引擎也可能顾不上回。
 */
async function reapForeignEngine(): Promise<'cleared' | 'not-ours' | 'still-held'> {
  const listeners = await listPortPids()
  if (listeners.length === 0) return 'not-ours'

  const targets: number[] = []
  for (const pid of listeners) {
    if (await isOurEngine(pid)) targets.push(pid)
  }
  if (targets.length === 0) return 'not-ours'

  // PyInstaller 的引导进程是监听者的父进程，握着那份临时解包目录，一并收掉
  for (const pid of [...targets]) {
    const out = await capture('ps', ['-o', 'ppid=', '-p', String(pid)])
    const ppid = Number(out.trim())
    if (Number.isInteger(ppid) && ppid > 1 && (await isOurEngine(ppid))) targets.push(ppid)
  }

  console.warn('[ASR Service] Reaping leftover engine processes:', targets.join(', '))
  for (const pid of targets) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      continue
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经退了，正好
    }
  }

  for (let i = 0; i < 10; i++) {
    await sleep(300)
    if ((await listPortPids()).length === 0) return 'cleared'
  }
  return 'still-held'
}

/** 轮询 health 接口，等待本次拉起的 ASR 服务就绪 */
async function waitForReady(): Promise<'ready' | 'foreign' | 'died' | 'timeout'> {
  const start = Date.now()
  let foreignAnswers = 0
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    // 子进程自己退了（例如端口被占导致 uvicorn 直接退出），不会再有好结果
    if (!asrProcess) return 'died'
    const info = await probeHealth()
    if (info) {
      if (info.boot_id === bootId && info.protocol === ASR_PROTOCOL) {
        console.log('[ASR Service] Ready')
        return 'ready'
      }
      if (++foreignAnswers >= FOREIGN_ANSWER_LIMIT) {
        console.warn('[ASR Service] Port answered by a service that is not ours', {
          protocol: info.protocol,
          bootIdMatch: info.boot_id === bootId,
        })
        return 'foreign'
      }
    } else {
      foreignAnswers = 0
    }
    await sleep(HEALTH_POLL_INTERVAL_MS)
  }
  return 'timeout'
}

/** 启动 Python ASR 服务 */
export async function startASRService(): Promise<boolean> {
  const binaryPath = getBinaryPath()

  if (!existsSync(binaryPath)) {
    asrError = '本地转写引擎文件缺失，请重新安装 Vv Transcribe 后再试'
    console.warn(`[ASR Service] Binary not found at ${binaryPath}, local ASR unavailable`)
    return false
  }

  if (asrProcess) {
    console.log('[ASR Service] Already running')
    return asrReady
  }

  // 端口上已经有人应答：还没 spawn，那它必然不是本进程的引擎，不能采信。
  // 但它很可能只是上一次强杀留下的残尸，所以先试着收掉，收不掉才把问题推给用户
  const resident = await probeHealth()
  if (resident) {
    console.warn('[ASR Service] Port', ASR_PORT, 'answered before spawn, trying to reap it', resident)
    const reaped = await reapForeignEngine()
    if (reaped !== 'cleared') {
      asrError =
        reaped === 'not-ours'
          ? '8000 端口被其他程序占用，本地转写无法启动，请关闭占用该端口的程序后重新启动'
          : '上一代本地转写服务未能自动清理，请在活动监视器中结束 vv-asr-server 进程后重新启动 Vv Transcribe'
      console.warn('[ASR Service] Port', ASR_PORT, 'still occupied after reap:', reaped)
      return false
    }
    console.log('[ASR Service] Port freed by reaping leftover engine')
  }

  console.log('[ASR Service] Starting:', binaryPath)

  const ffmpegPath = getFfmpegBinaryPath('ffmpeg')
  const ffprobePath = getFfmpegBinaryPath('ffprobe')
  console.log('[ASR Service] FFmpeg paths:', { ffmpegPath, ffprobePath })

  const modelCached = isModelCached()
  console.log('[ASR Service] Whisper model cached:', modelCached ? 'online check skipped' : 'first run will download')

  asrProcess = spawn(binaryPath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ASR_BOOT_ID: bootId,
      HF_ENDPOINT: 'https://hf-mirror.com',
      ...(modelCached ? { HF_HUB_OFFLINE: '1' } : {}),
      ...(ffmpegPath ? { FFMPEG_PATH: ffmpegPath } : {}),
      ...(ffprobePath ? { FFPROBE_PATH: ffprobePath } : {}),
    },
    // POSIX 下让引擎自成一个进程组，退出时才能连 PyInstaller 引导进程和它自己拉起的
    // 孙进程一起收掉；Windows 没有这套语义，改用 taskkill /T
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  asrPid = asrProcess.pid ?? null

  asrProcess.stdout?.on('data', (data) => {
    console.log(`[ASR Service] ${data.toString().trim()}`)
  })

  asrProcess.stderr?.on('data', (data) => {
    console.error(`[ASR Service] ${data.toString().trim()}`)
  })

  asrProcess.on('exit', (code, signal) => {
    asrExitInfo = `code=${code} signal=${signal}`
    console.log(`[ASR Service] Process exited (${asrExitInfo})`)
    asrProcess = null
    asrReady = false
  })

  asrProcess.on('error', (err) => {
    console.error('[ASR Service] Process error:', err.message)
    asrProcess = null
    asrReady = false
  })

  const outcome = await waitForReady()
  asrReady = outcome === 'ready'
  asrError = readyFailureMessage(outcome)

  // 引擎秒退且端口上仍有人监听：那是别的程序占着 8000（它不该赖给「引擎自己崩了」），
  // 这种占用者不会应答 /health，所以启动前那次残尸回收看不到它
  if (outcome === 'died' && (await listPortPids()).length > 0) {
    asrError = '8000 端口被其他程序占用，本地转写无法启动，请关闭占用该端口的程序后重新启动'
  }

  if (!asrReady) {
    console.error('[ASR Service] Failed to become ready:', outcome, asrExitInfo ?? '')
    await stopASRService()
    return false
  }

  return true
}

/** 各失败原因对应的用户可读文案；引擎中途退出不能赖给「模型下载慢」 */
function readyFailureMessage(outcome: 'ready' | 'foreign' | 'died' | 'timeout'): string | null {
  switch (outcome) {
    case 'ready':
      return null
    case 'foreign':
      return '8000 端口上的转写服务不属于本次启动，请完全退出 Vv Transcribe 后重新启动'
    case 'died':
      return '本地转写引擎启动后立即退出，请重新启动应用；若反复出现请重新安装 Vv Transcribe'
    case 'timeout':
      return '本地转写引擎启动超时（首次运行需下载模型，可能耗时较久），请重新启动应用'
  }
}

/** 对整棵引擎进程树发信号。只杀直接子进程会留下继承了 8000 socket 的孙进程 */
function signalAsrTree(signal: 'SIGTERM' | 'SIGKILL') {
  // 没有 pid 就绝不能走 kill(-0)：那等于给 Electron 自己所在的进程组发信号
  if (!asrPid) return
  if (process.platform === 'win32') {
    // Windows 上 Node 的 kill 无法只做到「优雅」，直接按进程树强制结束
    spawn('taskkill', ['/PID', String(asrPid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    // 负号 = 整个进程组；spawn 时 detached 已经让它当了组长
    process.kill(-asrPid, signal)
  } catch {
    asrProcess?.kill(signal)
  }
}

/**
 * 父进程退了不代表整棵树退干净：继承了监听 socket 的残留进程照样能拿这次的
 * boot id 应答 /health。确认端口上不再有本次的身份标识，还在就补一刀 SIGKILL。
 */
async function ensureTreeGone(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await sleep(300)
    const info = await probeHealth()
    if (info?.boot_id !== bootId) return
    if (i === 2) {
      console.warn('[ASR Service] Engine still answering after exit, killing whole process group')
      signalAsrTree('SIGKILL')
    }
  }
  console.warn('[ASR Service] Engine process may still hold port', ASR_PORT)
}

/** 优雅关闭 Python ASR 服务 */
export async function stopASRService(): Promise<void> {
  const proc = asrProcess
  if (!proc) {
    await ensureTreeGone()
    return
  }

  console.log('[ASR Service] Shutting down...')

  const exited = new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      console.warn('[ASR Service] Graceful shutdown timed out, killing process group')
      signalAsrTree('SIGKILL')
    }, SHUTDOWN_TIMEOUT_MS)

    proc.once('exit', () => {
      clearTimeout(killTimer)
      asrProcess = null
      asrReady = false
      console.log('[ASR Service] Stopped')
      resolve()
    })

    signalAsrTree('SIGTERM')
  })

  await exited
  await ensureTreeGone()
}

/** 获取 ASR 服务状态；未就绪时 error 为可直接展示给用户的原因 */
export function getASRServiceStatus(): { ready: boolean; error: string | null } {
  return {
    ready: asrReady,
    error: asrReady ? null : (asrError || '本地转写引擎未运行，请重新启动应用'),
  }
}

/**
 * 设置里「检查引擎状态」用：现场探一次 /health，而不是只读启动时缓存的布尔值。
 * 引擎可能被外部杀掉，也可能模型还没加载（首次转写才加载），这些信息必须现问才有意义。
 */
export async function getLocalEngineDetail(): Promise<{
  ready: boolean
  error: string | null
  modelLoaded: boolean
  protocol: number | null
  port: number
}> {
  const health = await probeHealth()
  const status = getASRServiceStatus()
  if (!health) {
    return {
      ready: false,
      error: status.error || '本地转写引擎没有应答，请完全退出应用后重新启动',
      modelLoaded: false,
      protocol: null,
      port: ASR_PORT,
    }
  }
  return {
    ready: status.ready,
    // /health 应答了但身份对不上：端口上是别家程序或上一代残尸，不能报「正常」
    error: status.ready ? null : status.error,
    modelLoaded: health.model_loaded === true,
    protocol: typeof health.protocol === 'number' ? health.protocol : null,
    port: ASR_PORT,
  }
}
