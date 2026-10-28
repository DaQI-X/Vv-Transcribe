/**
 * 本地配音引擎（TTS sidecar）管理器
 *
 * 形态照 asrServiceManager（spawn + boot_id 握手 + /health 轮询 + 进程树回收），但有四处按
 * 本地配音的实际改过，不是随手写的差异：
 *
 * - 懒启动。ASR 在开屏时就拉起来，因为几乎每个用户第一件事就是转写；配音不是，而且本地引擎
 *   二进制与模型都不进安装包（#230 按需下载），没下载的用户开屏就该看到「没下载」而不是「启动失败」。
 *   所以本模块只在第一次真要用时 ensure，进程退出前不做任何事。
 * - 一进程一引擎。引擎 id 是启动时通过 VV_TTS_ENGINE 钉死的（sidecar 文件头有实测账：
 *   VITS 370MB、Kokoro 878MB，同进程切回只退 103MB）。换引擎这件事由这里做：发现绑定的引擎
 *   和要用的不一样就重起进程。409 不是错误，是「你该重启了」的信号。
 * - 「起来了」和「能出声」是两个时间点。冻结包是 PyInstaller onefile，2026-10-28 本机实测
 *   （M4）空载到 /health 应答 8.07 秒（解包成本），引擎本体还要惰性加载 VITS 0.22 秒 /
 *   Kokoro 0.86 秒，落在第一次 /synthesize 里。就绪只保证能收请求。
 * - 只绑 127.0.0.1、端口 8010。ASR 那个 8000 绑了 0.0.0.0 是历史遗留，新服务不重复。
 *
 * 时长一律采信 sidecar 的 X-Vv-Duration（它自己数的采样数），不走 ffprobe 的容器估算：
 * 见 ttsService 头部与记忆「随包 ffmpeg 三平台差七年」。
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { logger } from './logger'
import { UPSTREAM_MODEL_SOURCES, hasInAppModelDownload, upstreamTotalBytes } from './ttsModelUpstream'

const TAG = 'LocalTTS'

const TTS_PORT = 8010
const TTS_URL = `http://127.0.0.1:${TTS_PORT}`
/** 与 python-tts/main.py 的 TTS_PROTOCOL 对应：改请求或响应字段时那边 +1，这里跟上 */
const TTS_PROTOCOL = 1
/**
 * 等 /health 回显本次身份的时限。下限由实测决定：冻结包光是解包就要 8 秒；给 120 秒是因为
 * 这台机器上可能是第一次跑（磁盘忙、杀软扫这 23MB），慢网里什么都不该发生，但不能把界面钉死。
 */
const START_TIMEOUT_MS = 120_000
const HEALTH_POLL_INTERVAL_MS = 500
const SHUTDOWN_TIMEOUT_MS = 5_000
/** 连续多少次应答来自别的实例就判定端口被占，不再空等满时限 */
const FOREIGN_ANSWER_LIMIT = 3
/** 单次合成的时限，与云端那档的 SPEECH_TIMEOUT_MS 对齐：两档共用同一套段号与熔断语义 */
const SYNTHESIS_TIMEOUT_MS = 60_000

/**
 * 引擎白名单，必须与 python-tts/main.py 的 ENGINES 一字不差。
 * 这边收口的原因是 id 会被拼进 VV_TTS_MODEL_DIR 下的目录名，也能被界面报上来；
 * sidecar 自己也会验一遍（不在白名单直接拒绝启动），两道关都不赌对方记得验。
 */
export const LOCAL_TTS_ENGINES = ['sherpa-onnx-vits-zh-ll', 'kokoro-multi-lang-v1_1'] as const
export type LocalTtsEngineId = (typeof LOCAL_TTS_ENGINES)[number]

/**
 * 中文默认档。选 VITS 而不是 Kokoro 是拍板过的（2026-10-28）：本项目的主场景是中文节目字幕配音，
 * VITS 这档 RTF 0.12–0.15、129MB，且 sid0 就是用户试听后挑中的那种口味。
 * 认不出的值（旧配置、手改 settings.json）落回这一档，而不是报「配置坏了」——本地档本来就是新增的，
 * 没有历史值需要兼容。
 */
export const DEFAULT_LOCAL_TTS_ENGINE: LocalTtsEngineId = 'sherpa-onnx-vits-zh-ll'

export function normalizeLocalTtsEngine(raw: unknown): LocalTtsEngineId {
  return (LOCAL_TTS_ENGINES as readonly string[]).includes(raw as string)
    ? (raw as LocalTtsEngineId)
    : DEFAULT_LOCAL_TTS_ENGINE
}

/**
 * 按需组件的根目录。
 * #230 的下载器把引擎二进制与模型都写进这里，约定与 ytDlpUpdate 的 userData/bin 同源
 * （应用可写、升级不动安装包），只是按组件 id 分目录，好按版本摆放与整体回收。
 */
export function componentsDir(): string {
  return join(app.getPath('userData'), 'components')
}

/** 模型根目录：里面是 `<engine-id>/`，目录名就是上游仓库名，sidecar 按同样的名字找 */
export function modelRootDir(): string {
  // 自测口子（同 VV_YTDLP_MANIFEST_URL 的思路）：模型已经手动下在别处时不用复制一份进包目录。
  // 导出给组件下载用——落点必须和这里读的是同一个地方，否则设了 VV_TTS_MODEL_DIR 会变成
  // 「下到 A 处、引擎读 B 处」，而下完就报「已安装」的界面看不出这个分叉。
  return process.env.VV_TTS_MODEL_DIR || join(componentsDir(), 'tts-models')
}

/**
 * 引擎二进制路径。
 * - 优先用 #230 下载到 userData/components 的那份：本地配音不进安装包，用户机器上能有这一份
 *   只有「下载过」这一个来源；下载的那份一旦存在就以它为准，界面上显示的版本才是真的在跑的。
 * - 开发模式且还没下载过：退回 scripts/build-tts.mjs 的产物（按架构分目录，dist-arm64 / dist-x64），
 *   这样本机能在不依赖清单发布的前提下继续验引擎本身。
 * - 打包模式且没下载过：返回下载落点（不存在），调用方按「没下载」报，而不是按「启动失败」报。
 *   路径按 `<platform>-<arch>` 分目录，与随包 ffmpeg/yt-dlp 的命名习惯一致，
 *   免得两种架构的产物在同一路径上互相覆盖。
 */
function getBinaryPath(): string {
  const exe = process.platform === 'win32' ? 'vv-tts-server.exe' : 'vv-tts-server'
  const downloaded = join(componentsDir(), 'vv-tts-server', `${process.platform}-${process.arch}`, exe)
  if (existsSync(downloaded)) return downloaded
  if (process.env.VITE_DEV_SERVER_URL) {
    return join(import.meta.dirname, '../../python-tts', `dist-${process.arch}`, exe)
  }
  return downloaded
}

/** 有没有正在跑的引擎进程。#230 的下载器据此拒绝覆盖/删除，那文件正被进程占着 */
export function isLocalTtsEngineRunning(): boolean {
  return engineProcess !== null
}

interface TtsHealth {
  status?: string
  /** 本进程绑定的引擎；engine_loaded 才是「模型真的在内存里」 */
  engine?: string | null
  engine_loaded?: string | null
  speakers?: number
  sample_rate?: number
  protocol?: number
  boot_id?: string
}

let engineProcess: ChildProcess | null = null
/** 进程退了还要按进程组补刀，所以 pid 要比 ChildProcess 活得久一点 */
let enginePid: number | null = null
let bootId = ''
/** 当前这个进程是用哪个引擎起起来的；null 表示没起过 */
let boundEngine: LocalTtsEngineId | null = null
let ready = false
let exitInfo: string | null = null
/** 未就绪时可直接展示给用户的原因 */
let lastError: string | null = null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function probeHealth(): Promise<TtsHealth | null> {
  try {
    const res = await fetch(`${TTS_URL}/health`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    return (await res.json()) as TtsHealth
  } catch {
    return null
  }
}

/** 跑一条本机命令取 stdout；命令缺失、超时、报错一律返回空串，端口回收是尽力而为不能拖垮调用方 */
function capture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout))
  })
}

/** 谁在监听配音端口。查不到监听者时返回空数组，调用方必须据此放弃回收 */
async function listPortPids(): Promise<number[]> {
  const pids = new Set<number>()
  if (process.platform === 'win32') {
    const out = await capture('netstat', ['-ano', '-p', 'tcp'])
    for (const line of out.split('\n')) {
      const cols = line.trim().split(/\s+/)
      if (cols[0] !== 'TCP' || !cols[1]?.endsWith(`:${TTS_PORT}`) || cols[3] !== 'LISTENING') continue
      const pid = Number(cols[cols.length - 1])
      if (Number.isInteger(pid) && pid > 0) pids.add(pid)
    }
    return [...pids]
  }
  const out = await capture('lsof', ['-nP', `-tiTCP:${TTS_PORT}`, '-sTCP:LISTEN'])
  for (const line of out.split('\n')) {
    const pid = Number(line.trim())
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

/** 这个 pid 是不是我们自己的引擎：可执行文件名必须和本次要启动的那个二进制同名 */
async function isOurEngine(pid: number): Promise<boolean> {
  const exe = basename(getBinaryPath()).toLowerCase()
  if (process.platform === 'win32') {
    const out = await capture('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
    return out.toLowerCase().includes(`"${exe}"`)
  }
  const out = await capture('ps', ['-p', String(pid), '-o', 'comm='])
  return basename(out.trim().toLowerCase()) === exe
}

/**
 * 把躺在 8010 上的上一代引擎收掉（抄 ASR 那段，教训也一样：应用被强杀时 before-quit 不跑，
 * 引擎会作为孤儿永远占着端口，光靠握手只能做到「不采信它」，用户重开应用照样起不来）。
 * 只杀命令行确认是我们自己二进制的那些进程。
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

async function waitForReady(): Promise<'ready' | 'foreign' | 'died' | 'timeout'> {
  const start = Date.now()
  let foreignAnswers = 0
  while (Date.now() - start < START_TIMEOUT_MS) {
    if (!engineProcess) return 'died'
    const info = await probeHealth()
    if (info) {
      if (info.boot_id === bootId && info.protocol === TTS_PROTOCOL && info.engine === boundEngine) {
        logger.info(TAG, 'Engine ready', { engine: boundEngine })
        return 'ready'
      }
      if (++foreignAnswers >= FOREIGN_ANSWER_LIMIT) {
        logger.warn(TAG, 'Port answered by a service that is not ours', {
          protocol: info.protocol,
          engine: info.engine,
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

/**
 * 模型体积的口径。下载引导（#230/#233）、启动失败与自检文案都从这里取，
 * 免得同一个数字在三处各写一遍、改的时候只改对一处。
 * 单位按 1000 进位（与界面的 formatBytes 同一把尺），VITS 那份直接算自钉死的指纹表——
 * 表里的字节数变了，这句话跟着变，不会再出现「129MB」和「135.5MB」并排。
 * Kokoro 本版不开放应用内下载，没有可算的表，用 2026-10-28 上游 tree 接口实测的
 * 426,584,620 字节（不含 README 与 .gitattributes）。
 */
export function modelSizeHint(engine: LocalTtsEngineId): string {
  const source = UPSTREAM_MODEL_SOURCES[engine]
  const modelBytes = source ? upstreamTotalBytes(source) : 426_584_620
  return `${engine} 的模型约 ${(modelBytes / 1e6).toFixed(1)}MB`
}

/** 两份组件一起缺时的说法：模型体积 + 引擎二进制 */
export function componentsSizeHint(engine: LocalTtsEngineId): string {
  return `${modelSizeHint(engine)}，另需下载对应平台的引擎二进制`
}

/**
 * 缺件时给人看的那句话。缺的若是模型，还得看这一档本版有没有应用内下载包：
 * Kokoro 只钉了体积、没钉指纹，按需组件那一行下不了，指过去等于答应了做不到的事。
 */
function missingComponentsMessage(engine: LocalTtsEngineId, missingModel: boolean): string {
  if (missingModel && !hasInAppModelDownload(engine)) {
    return `本地配音缺 ${modelSizeHint(engine)}，而这一版没有放它的下载包——先在「设置 → 配音配置」换回 VITS，或改用云端档`
  }
  return `本地配音组件还没下载完（${componentsSizeHint(engine)}）。下载入口在「设置 → 关于与更新 → 按需组件」，下完才能配音`
}

/**
 * 起进程并等它认下这次的身份。调用方必须已经拿过单飞锁（见 ensureLocalTtsEngine）。
 * 失败时抛可直接弹 toast 的中文原因，主进程不跨 IPC 抛。
 */
async function startEngine(engine: LocalTtsEngineId): Promise<void> {
  const binaryPath = getBinaryPath()
  if (!existsSync(binaryPath)) {
    lastError = missingComponentsMessage(engine, false)
    logger.warn(TAG, 'Engine binary missing', { path: basename(binaryPath), devMode: !!process.env.VITE_DEV_SERVER_URL })
    throw new Error(lastError)
  }
  if (!existsSync(join(modelRootDir(), engine))) {
    // 只查目录在不在：里面缺哪个文件由 sidecar 自己报（它有真清单，这边再抄一份必然对不齐），
    // 而「整个模型没下载」是另一种事——那种情况用户要的是「去下载」，不是「重装」
    lastError = missingComponentsMessage(engine, true)
    logger.warn(TAG, 'Model directory missing', { engine, root: modelRootDir() })
    throw new Error(lastError)
  }

  // 换一份身份标识再 spawn：新引擎只会由新 id 认领，上一代留在端口上的残尸过不了握手
  bootId = randomUUID()
  boundEngine = engine

  const resident = await probeHealth()
  if (resident) {
    logger.warn(TAG, 'Port answered before spawn, trying to reap it', { engine: resident.engine })
    const reaped = await reapForeignEngine()
    if (reaped !== 'cleared') {
      lastError =
        reaped === 'not-ours'
          ? `${TTS_PORT} 端口被其他程序占用，本地配音无法启动，请关闭占用该端口的程序后再试`
          : '上一代本地配音服务没能自动清理，请在活动监视器（或任务管理器）中结束 vv-tts-server 进程后再试'
      throw new Error(lastError)
    }
  }

  logger.info(TAG, 'Starting engine', { engine, binary: basename(binaryPath) })

  engineProcess = spawn(binaryPath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      VV_TTS_BOOT_ID: bootId,
      VV_TTS_ENGINE: engine,
      VV_TTS_MODEL_DIR: modelRootDir(),
      VV_TTS_PORT: String(TTS_PORT),
    },
    // POSIX 下让它自成一个进程组，退出时才能连 PyInstaller 引导进程和孙进程一起收掉
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  enginePid = engineProcess.pid ?? null

  engineProcess.stdout?.on('data', (data) => logger.info(TAG, data.toString().trim()))
  engineProcess.stderr?.on('data', (data) => logger.warn(TAG, data.toString().trim()))
  engineProcess.on('exit', (code, signal) => {
    exitInfo = `code=${code} signal=${signal}`
    logger.info(TAG, 'Process exited', { exitInfo })
    engineProcess = null
    ready = false
  })
  engineProcess.on('error', (err) => {
    logger.error(TAG, 'Process error', { message: err.message })
    engineProcess = null
    ready = false
  })

  const outcome = await waitForReady()
  ready = outcome === 'ready'
  lastError = readyFailureMessage(outcome)
  if (outcome === 'died' && (await listPortPids()).length > 0) {
    lastError = `${TTS_PORT} 端口被其他程序占用，本地配音无法启动，请关闭占用该端口的程序后再试`
  }
  if (!ready) {
    logger.error(TAG, 'Failed to become ready', { outcome, exitInfo: exitInfo ?? '', engine })
    await stopLocalTtsEngine()
    throw new Error(lastError || '本地配音引擎没能启动，请重试')
  }
}

function readyFailureMessage(outcome: 'ready' | 'foreign' | 'died' | 'timeout'): string | null {
  switch (outcome) {
    case 'ready':
      return null
    case 'foreign':
      return `${TTS_PORT} 端口上的配音服务不属于本次启动。点「重启本地配音引擎」可自动回收并重开；反复出现请完全退出 Vv Transcribe 后重新启动`
    case 'died':
      return '本地配音引擎启动后立即退出，可点「重启本地配音引擎」再试；若反复出现请重新下载该组件'
    case 'timeout':
      return `本地配音引擎在 ${START_TIMEOUT_MS / 1000} 秒内没有应答（首次启动要解包，磁盘慢时更久）。可点「重启本地配音引擎」再试`
  }
}

/** 对整棵引擎进程树发信号。只杀直接子进程会留下继承了 8010 socket 的孙进程 */
function signalEngineTree(signal: 'SIGTERM' | 'SIGKILL') {
  // 没有 pid 就绝不能走 kill(-0)：那等于给 Electron 自己所在的进程组发信号
  if (!enginePid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(enginePid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-enginePid, signal)
  } catch {
    engineProcess?.kill(signal)
  }
}

/** 父进程退了不代表整棵树退干净：继承了监听 socket 的残留进程照样能拿这次的 boot id 应答 */
async function ensureTreeGone(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await sleep(300)
    const info = await probeHealth()
    if (info?.boot_id !== bootId) return
    if (i === 2) {
      logger.warn(TAG, 'Engine still answering after exit, killing whole process group')
      signalEngineTree('SIGKILL')
    }
  }
  logger.warn(TAG, 'Engine process may still hold port', { port: TTS_PORT })
}

/** 优雅关闭（应用退出时、以及换引擎前）；没起过就是空操作 */
export async function stopLocalTtsEngine(): Promise<void> {
  const proc = engineProcess
  if (!proc) {
    await ensureTreeGone()
    return
  }
  logger.info(TAG, 'Shutting down')

  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      logger.warn(TAG, 'Graceful shutdown timed out, killing process group')
      signalEngineTree('SIGKILL')
    }, SHUTDOWN_TIMEOUT_MS)
    proc.once('exit', () => {
      clearTimeout(killTimer)
      engineProcess = null
      ready = false
      resolve()
    })
    signalEngineTree('SIGTERM')
  })

  await ensureTreeGone()
}

/**
 * 同一时刻只允许一次启动/重启：连点或两个窗口同时发起一批配音，会并发 spawn 两个引擎抢 8010，
 * 后起的立即退出，而「引擎秒退 + 端口仍有人监听」会被判成端口被占，顺手把刚起好的那个也关掉。
 * 值本身按 T 返回给等待方；ensure 只等「起来了」这件事，重启回给它的那个结果对象对它没有意义。
 */
let startInFlight: Promise<unknown> | null = null

function singleFlight<T>(make: () => Promise<T>): Promise<T> {
  if (startInFlight) return startInFlight as Promise<T>
  const run = make().finally(() => {
    startInFlight = null
  })
  startInFlight = run
  return run
}

async function doEnsure(engine: LocalTtsEngineId): Promise<void> {
  // 引擎是在启动时钉死的（内存账见文件头），所以「绑错了」只有重起这一条路；
  // 停在旧引擎上继续发请求，拿回来的是 409 而不是声音。
  if (ready && boundEngine === engine) return
  if (boundEngine && boundEngine !== engine) {
    logger.info(TAG, 'Switching engine, restarting process', { from: boundEngine, to: engine })
  }
  if (engineProcess) await stopLocalTtsEngine()
  await startEngine(engine)
}

/**
 * 让端口上跑着一个「绑定了这个引擎、且应答者是我拉起的那个」的服务。
 * 没起过就起，起过但绑错引擎就换掉——这是本地配音唯一的「换引擎」入口。
 * 抛错即失败，原因已成人话，调用方（ttsService）负责变成 { error }。
 */
export function ensureLocalTtsEngine(engine: LocalTtsEngineId): Promise<void> {
  if (ready && boundEngine === engine) return Promise.resolve()
  return singleFlight(() => doEnsure(engine))
}

/**
 * 合成一段文本，落盘成 WAV 并回精确时长。
 *
 * 这里刻意不做「时长读不出来就退回 ffprobe」：本地档的 X-Vv-Duration 是 sidecar 自己数的采样数，
 * 比任何容器估算都准；把它降级成 ffprobe 那条估计，等于把本地档唯一比云端强的地方扔了。
 * 真读不出来（sidecar 版本对不上）就按 0 报，调用方按「不知道」处理，跟云端同一个口径。
 */
export async function synthesizeLocally(
  text: string,
  engine: LocalTtsEngineId,
  sid: number,
  speed: number,
  tempDir: string
): Promise<{ filePath: string; bytes: number; duration: number }> {
  await ensureLocalTtsEngine(engine)

  const url = `${TTS_URL}/synthesize`
  const body = JSON.stringify({ engine, text, sid, speed })
  const send = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
    })

  let response = await send().catch((err) => {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`本地配音 ${SYNTHESIS_TIMEOUT_MS / 1000} 秒没返回（这一段太长或这台机器正在忙别的）`)
    }
    // 服务在半路被杀掉/端口被抢，这里报的是「连不上本机服务」，不是「网络问题」
    throw new Error(`没能连上本地配音服务：${err instanceof Error ? err.message : String(err)}`)
  })

  // 409 = 这个进程绑的是别的引擎。正常情况下 ensure 已经拦住了，走到这里说明是竞态
  // （另一边的窗口刚换过引擎）：换成本次要的引擎重启，这一次请求重发一遍，不把它当失败报给用户
  if (response.status === 409) {
    const detail = await response.text().catch(() => '')
    logger.warn(TAG, 'Engine mismatch on request, restarting', { engine, detail: detail.slice(0, 200) })
    const restarted = await restartLocalTtsEngine(engine)
    if (!restarted.ok) throw new Error(restarted.error || '本地配音引擎换引擎后没能重启成功')
    response = await send().catch((err) => {
      throw new Error(`换引擎后重试仍然失败：${err instanceof Error ? err.message : String(err)}`)
    })
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    // sidecar 的错误是 `{"detail": "…"}`，里面本来就是给人看的一句话，剥出来比整段 JSON 有用
    const readable = detail.replace(/^\{"detail":\s*"?/, '').replace(/"\}$/, '')
    throw new Error(`本地配音失败（${response.status}）：${readable || '服务没有说明原因'}`)
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error('本地配音服务返回了 0 字节音频')

  await mkdir(tempDir, { recursive: true })
  const filePath = join(tempDir, `${randomUUID()}.wav`)
  await writeFile(filePath, bytes)

  const reported = Number(response.headers.get('x-vv-duration'))
  const duration = Number.isFinite(reported) && reported > 0 ? reported : 0
  if (!duration) {
    logger.warn(TAG, 'X-Vv-Duration missing or invalid', { engine, probed: response.headers.get('x-vv-duration') })
  }
  const info = await stat(filePath)
  return { filePath, bytes: info.size, duration }
}

export interface EngineActionResult {
  ok: boolean
  error: string | null
}

async function doRestart(engine: LocalTtsEngineId): Promise<EngineActionResult> {
  try {
    if (engineProcess) await stopLocalTtsEngine()
    boundEngine = null
    await startEngine(engine)
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '本地配音引擎没能重启成功' }
  }
}

/** 应用内重启本地配音引擎（换引擎、端口被占、启动失败后都走这一条） */
export function restartLocalTtsEngine(engine: LocalTtsEngineId): Promise<EngineActionResult> {
  return singleFlight(() => doRestart(engine))
}

/**
 * 本地档的「音色」在界面上是一个下拉，落到配置里是 sid 编号的字符串写法（'0'、'40'）。
 * 收口成数字前先验格式：云端那档的音色名（'alloy'）会被原样带过来，
 * 直接 Number() 会得到 NaN 再被 sidecar 拒成一句看不懂的 400。
 * 上限（VITS 5 个、Kokoro 103 个）不在这里判——由 /health 报的 num_speakers 说了算，
 * 这边抄一份就是第三处需要跟引擎版本对齐的清单。
 */
export function parseLocalTtsSid(raw: string): number | null {
  const trimmed = (raw || '').trim()
  if (!/^\d+$/.test(trimmed)) return null
  return Number(trimmed)
}

/**
 * 当前状态（不现问 /health，秒回）：开工前置校验与界面轮询用。
 * engine 传「配置里要用哪个」，不是「进程现在绑着哪个」——懒启动时后者还是空的，
 * 拿它去判断组件在不在场会把「模型明明下好了」说成「还没下载」。
 */
export function getLocalTtsStatus(engine: LocalTtsEngineId): {
  ready: boolean
  /** 进程实际绑定的引擎；没起过时为 null */
  engine: LocalTtsEngineId | null
  error: string | null
  binaryPresent: boolean
  modelPresent: boolean
} {
  return {
    ready,
    engine: ready ? boundEngine : null,
    error: ready ? null : lastError || '本地配音引擎未启动',
    binaryPresent: existsSync(getBinaryPath()),
    modelPresent: existsSync(join(modelRootDir(), engine)),
  }
}

/**
 * 设置里「检查本地配音引擎状态」用：现场问一次 /health，而不是只读缓存的布尔值。
 * 引擎可能在应用开着的时候被外部杀掉，也可能「进程在但模型还没加载」——这两种在界面上
 * 必须是不同的说法，否则用户会以为配音坏了。
 */
export interface LocalTtsDetail {
  ready: boolean
  error: string | null
  /** 按需组件在场情况：#233 的首次下载引导按这两个位决定文案，而不是笼统一句「未就绪」 */
  binaryPresent: boolean
  modelPresent: boolean
  /** 端口上这个进程绑定的引擎；还没起来时是 null */
  engine: string | null
  /** 真的驻留在内存里的引擎；模型是惰性的，这一位为 null 不代表起不来 */
  engineLoaded: string | null
  /** 音色上限：界面按它决定 sid 能选到几；模型没加载时是 0 */
  speakers: number
  sampleRate: number
  port: number
}

export async function getLocalTtsDetail(engine: LocalTtsEngineId): Promise<LocalTtsDetail> {
  const status = getLocalTtsStatus(engine)
  const base = {
    binaryPresent: status.binaryPresent,
    modelPresent: status.modelPresent,
    engine: null as string | null,
    engineLoaded: null as string | null,
    speakers: 0,
    sampleRate: 0,
    port: TTS_PORT,
  }

  const health = await probeHealth()
  if (!health) return { ...base, ready: false, error: status.error }

  // 应答者不是本次拉起的实例（上一代被强杀留下的孤儿）：它的字段再像真的也不能当成自己的状态报，
  // 否则界面显示「已就绪」，用户一点配音却被 startEngine 的回收流程带走，像自己把自己重启了。
  if (health.boot_id !== bootId || health.protocol !== TTS_PROTOCOL) {
    return {
      ...base,
      ready: false,
      error: `8010 端口上应答的是另一个配音服务（大概是上次没退干净留下的）。点「重启本地配音引擎」可自动回收并重开`,
    }
  }

  // /health 报的是「这个端口上的进程」那一档的状态：speakers 和 sample_rate 都属于它那档模型。
  // 界面上问的是另一档时（VITS 正在跑、用户把模型下拉切到 Kokoro）这两个数不能挪用——
  // Kokoro 有 103 个音色，把 VITS 的 5 报过去等于骗用户「0–4 就是全部」。
  // 按 0 回，界面那侧的口径是「还不知道」，等这一档真跑过一次再问就全了。
  const servingEngine = typeof health.engine === 'string' ? health.engine : null
  const sameTier = servingEngine === engine

  return {
    ...base,
    ready: status.ready,
    error: status.ready ? null : status.error,
    engine: servingEngine,
    engineLoaded: typeof health.engine_loaded === 'string' ? health.engine_loaded : null,
    speakers: sameTier ? Number(health.speakers) || 0 : 0,
    sampleRate: sameTier ? Number(health.sample_rate) || 0 : 0,
  }
}
