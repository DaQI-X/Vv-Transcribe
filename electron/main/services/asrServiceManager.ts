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
 *
 * 应用内重启引擎（restartLocalEngine）也必须走同一套握手，所以 bootId 是每次 spawn 现生成的：
 * 一个进程内复用同一个身份标识的话，上一代没退干净的残尸照样能对上号被判成就绪，
 * 而它那份 PyInstaller 临时解包目录已经删了，用户第一次转写就会撞见看不懂的报错。
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import { app } from 'electron'
import { loadSettings, normalizeLocalModel } from './settingsService'
import { logger } from './logger'

const TAG = 'ASRService'

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
 * 这次 spawn 的身份标识，随 env 下发给引擎并由 /health 回显。
 * 只有对得上这个 id 的应答才代表「我拉起的引擎已经起来了」——
 * 上一代没退干净的残尸照样能应答 /health（它已加载的模块还在内存里），
 * 但它那份 PyInstaller 临时解包目录早被删了，任何懒加载的模块都会报
 * 「No module named ...」这种用户完全看不懂的错。
 *
 * let 而不是 const：应用内重启（restartLocalEngine）复用同一个 Electron 进程，
 * 沿用同一个 id 等于把上面这道校验关掉，#128/#129 修的正是这个。
 */
let bootId = randomUUID()

interface AsrHealth {
  status?: string
  model_loaded?: boolean
  /** 引擎当前真正驻留内存的档位；没加载过是空串 */
  model?: string
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
 * faster-whisper 的权重默认落在 HuggingFace 缓存里，repo 名由档位拼成
 * Systran/faster-whisper-<档位>。命中缓存时给引擎下发 HF_HUB_OFFLINE=1：
 * huggingface_hub 平时每次加载都会向 hf-mirror 发一次「有没有新版本」的在线请求，
 * 弱网/挂代理时这一步能卡十几秒——模型明明已在本地，却被它拖成「首次加载慢了很多」。
 * 没命中缓存必须保持在线，否则用户第一次下载会直接失败，所以只在权重真的在场时才离线。
 *
 * 必须按档位判断：缓存里有 base 不代表有 small。用户在设置里切到 small 后如果照 base 的
 * 命中结果下发离线标志，首次转写会连不上 hf-mirror，报一个「模型没下载完」却又下载不了的死结。
 */
function isModelCached(tier: string): boolean {
  const hubCache = process.env.HF_HUB_CACHE
    || process.env.HUGGINGFACE_HUB_CACHE
    || (process.env.HF_HOME ? join(process.env.HF_HOME, 'hub') : undefined)
    || join(homedir(), '.cache', 'huggingface', 'hub')

  const snapshots = join(hubCache, `models--Systran--faster-whisper-${tier}`, 'snapshots')
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

  logger.warn(TAG, 'Reaping leftover engine processes', { pids: targets.join(', ') })
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

/**
 * 引擎两条管道的内容按行分级，不再一刀切。
 *
 * 「stderr 全落 WARN」是把警告埋进自己的噪声里：本机一次正常启动，stderr 上就是 4 条
 * uvicorn 自己打了 `INFO:` 前缀的起停行（Started server process / Waiting for application
 * startup / Application startup complete / Uvicorn running），停机时再来一条。
 * `ERROR:` 与 traceback 落 ERROR；uvicorn 的 `INFO:` 与引擎用 `[ASR] ` 前缀写的横幅落 INFO；
 * 认不出前缀的一律保持 WARN——本机停机时那句 resource_tracker 的 UserWarning 就收在这里，
 * 宁可吵，不吞。
 *
 * 走 logger 而不只是挑级别，还多了一道脱敏：`[ASR] Transcribing: <audio_path>` 打的是提取出的
 * wav 全路径，本机实测落盘时已经收成文件名。
 *
 * 一个别当证据看的限度：引擎那句 print 走 stdout，而 Python 在非 tty 下按块缓冲。本机一次
 * 31 秒的转写里，stdout 只有 `[ASR] Transcribing: ...` 进了盘，`Loading Whisper model` 和
 * `Transcription completed` 直到引擎被终止都没露面（整份 app.log 里这三条各 0 次），那句
 * 启动横幅也是攒到 /health 握手前 4 毫秒才涌出。想拿到「引擎自己说它加载完了」，得先让
 * 引擎按行 flush，那是 python-asr 那侧的事。
 */
function logSidecarOutput(raw: string): void {
  for (const line of raw.split('\n')) {
    const body = line.trim()
    if (!body) continue
    if (/^ERROR:/.test(body) || /^Traceback \(most recent call last\)/.test(body)) logger.error(TAG, body)
    else if (/^\[ASR\] Error:/.test(body)) logger.error(TAG, body)
    else if (/^INFO:/.test(body) || /^\[ASR\] /.test(body)) logger.info(TAG, body)
    else logger.warn(TAG, body)
  }
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
        logger.info(TAG, 'Engine ready', { model: info.model || 'not loaded yet' })
        return 'ready'
      }
      if (++foreignAnswers >= FOREIGN_ANSWER_LIMIT) {
        logger.warn(TAG, 'Port answered by a service that is not ours', {
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
    logger.warn(TAG, 'Engine binary missing', {
      binary: basename(binaryPath),
      devMode: !!process.env.VITE_DEV_SERVER_URL,
      arch: process.arch,
    })
    return false
  }

  if (asrProcess) {
    logger.info(TAG, 'Engine already running', { ready: asrReady })
    return asrReady
  }

  // 端口上已经有人应答：还没 spawn，那它必然不是本进程的引擎，不能采信。
  // 但它很可能只是上一次强杀留下的残尸，所以先试着收掉，收不掉才把问题推给用户
  const resident = await probeHealth()
  if (resident) {
    logger.warn(TAG, 'Port answered before spawn, trying to reap it', {
      protocol: resident.protocol,
      model: resident.model || 'not loaded',
      bootIdMatch: resident.boot_id === bootId,
    })
    const reaped = await reapForeignEngine()
    if (reaped !== 'cleared') {
      asrError =
        reaped === 'not-ours'
          ? '8000 端口被其他程序占用，本地转写无法启动，请关闭占用该端口的程序后重新启动'
          : '上一代本地转写服务未能自动清理，请在活动监视器中结束 vv-asr-server 进程后重新启动 Vv Transcribe'
      logger.warn(TAG, 'Port still occupied after reap', { port: ASR_PORT, outcome: reaped })
      return false
    }
    logger.info(TAG, 'Port freed by reaping leftover engine')
  }

  logger.info(TAG, 'Starting engine', { binary: basename(binaryPath) })

  // 换一份身份标识再 spawn：新引擎只会由新 id 认领，重启前留在端口上的残尸
  // 再也过不了握手这道关（见 bootId 上方注释）
  bootId = randomUUID()

  const ffmpegPath = getFfmpegBinaryPath('ffmpeg')
  const ffprobePath = getFfmpegBinaryPath('ffprobe')
  // 只报「有没有导出」：引擎侧那一串「找不到 ffmpeg」的根因就是这两个环境变量没设上，
  // 至于它们解析到哪一层，AudioProcessor 那几条日志已经说了，重复贴一遍绝对路径也没意义
  logger.info(TAG, 'FFmpeg env handed to engine', {
    ffmpeg: !!ffmpegPath,
    ffprobe: !!ffprobePath,
  })

  const tier = normalizeLocalModel((await loadSettings()).asrLocalModel)
  const modelCached = isModelCached(tier)
  // cached=false 意味着这次启动没给 HF_HUB_OFFLINE=1，首次转写会先去 hf-mirror 拉权重
  logger.info(TAG, 'Whisper tier', { tier, cached: modelCached })

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

  asrProcess.stdout?.on('data', (data) => logSidecarOutput(String(data)))

  asrProcess.stderr?.on('data', (data) => logSidecarOutput(String(data)))

  asrProcess.on('exit', (code, signal) => {
    asrExitInfo = `code=${code} signal=${signal}`
    logger.info(TAG, 'Process exited', { exitInfo: asrExitInfo })
    asrProcess = null
    asrReady = false
  })

  asrProcess.on('error', (err) => {
    logger.error(TAG, 'Process error', { message: err.message })
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
    logger.error(TAG, 'Failed to become ready', { outcome, exitInfo: asrExitInfo ?? '' })
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
      return '8000 端口上的转写服务不属于本次启动。点「重启本地引擎」可自动回收并重开；反复出现请完全退出 Vv Transcribe 后重新启动'
    case 'died':
      return '本地转写引擎启动后立即退出，可点「重启本地引擎」再试；若反复出现请重新安装 Vv Transcribe'
    case 'timeout':
      return '本地转写引擎启动超时（首次运行需下载模型，可能耗时较久）。网络确认无误后可点「重启本地引擎」再试'
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
      logger.warn(TAG, 'Engine still answering after exit, killing whole process group')
      signalAsrTree('SIGKILL')
    }
  }
  logger.warn(TAG, 'Engine process may still hold port', { port: ASR_PORT })
}

/** 优雅关闭 Python ASR 服务 */
export async function stopASRService(): Promise<void> {
  const proc = asrProcess
  if (!proc) {
    await ensureTreeGone()
    return
  }

  logger.info(TAG, 'Shutting down')

  const exited = new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      logger.warn(TAG, 'Graceful shutdown timed out, killing process group')
      signalAsrTree('SIGKILL')
    }, SHUTDOWN_TIMEOUT_MS)

    proc.once('exit', () => {
      clearTimeout(killTimer)
      asrProcess = null
      asrReady = false
      logger.info(TAG, 'Stopped')
      resolve()
    })

    signalAsrTree('SIGTERM')
  })

  await exited
  await ensureTreeGone()
}

export interface EngineActionResult {
  ok: boolean
  /** ok 为 false 时可直接展示给用户的原因 */
  error: string | null
}

/**
 * 重启同一时刻只允许跑一次：连点会并发 spawn 两个引擎抢 8000，后起的立即退出，
 * 而「引擎秒退 + 端口仍有人监听」会被判成端口被占，顺手把刚起好的那个也关掉。
 */
let restartInFlight: Promise<EngineActionResult> | null = null

async function doRestartLocalEngine(): Promise<EngineActionResult> {
  // 先停再起。stop 里的 ensureTreeGone 用的还是旧 bootId，正好用来确认「上一代真退干净了」；
  // 新身份由 startASRService 在 spawn 前现生成，残尸过不了握手这道关
  await stopASRService()
  const ok = await startASRService()
  return { ok, error: ok ? null : (asrError || '本地转写引擎没能重启成功，请稍后再试') }
}

/** 应用内重启本地引擎：让用户在软件里就能再试一次，不必退出重开 */
export function restartLocalEngine(): Promise<EngineActionResult> {
  if (restartInFlight) return restartInFlight
  restartInFlight = doRestartLocalEngine().finally(() => {
    restartInFlight = null
  })
  return restartInFlight
}

/** 获取 ASR 服务状态；未就绪时 error 为可直接展示给用户的原因 */
export function getASRServiceStatus(): { ready: boolean; error: string | null } {
  if (asrReady) return { ready: true, error: null }
  // 重启进行中时 asrError 还是上一轮的原因，照原样报出去会误导（端口此刻本来就该是空的）
  if (restartInFlight) return { ready: false, error: '本地转写引擎正在重启中，请等这次重启完成' }
  return {
    ready: false,
    error: asrError || '本地转写引擎未运行，可在「设置 → 转写配置」点「重启本地引擎」',
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
  /** 引擎实际驻留内存的档位（/health 原话）；还没加载时是空串 */
  loadedModel: string
  protocol: number | null
  port: number
}> {
  const health = await probeHealth()
  const status = getASRServiceStatus()
  if (!health) {
    return {
      ready: false,
      error: status.error || '本地转写引擎没有应答，可点「重启本地引擎」再试',
      modelLoaded: false,
      loadedModel: '',
      protocol: null,
      port: ASR_PORT,
    }
  }
  return {
    ready: status.ready,
    // /health 应答了但身份对不上：端口上是别家程序或上一代残尸，不能报「正常」
    error: status.ready ? null : status.error,
    modelLoaded: health.model_loaded === true,
    loadedModel: typeof health.model === 'string' ? health.model : '',
    protocol: typeof health.protocol === 'number' ? health.protocol : null,
    port: ASR_PORT,
  }
}
