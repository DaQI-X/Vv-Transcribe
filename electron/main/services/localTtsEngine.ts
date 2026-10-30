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
import { logger } from './logger'
import { componentsDir } from './userDataStore'
import { UPSTREAM_MODEL_SOURCES, hasInAppModelDownload, upstreamTotalBytes } from './ttsModelUpstream'
// 相对路径而非 @/ 别名：主进程这条 build 链没有配别名，用 @/ 只有打包时才炸，tsc 却是过的
import { formatBytes } from '../../../src/utils/formatBytes'

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
 * 这一档模型有几个说话人，给界面在引擎还没起来时把音色列表列全用。
 *
 * 为什么这儿敢写死、下面 parseLocalTtsSid 又坚持交给 sidecar 判：模型是按上游 commit + 逐文件
 * sha256 钉死的（`ttsModelUpstream.ts`），换模型＝换指纹表，这个数不会悄悄变；而「起来的那台引擎
 * 实际有几个」仍然只有它自己知道，所以 sid 越界一律由 sidecar 拒——两份数各司其职，不打架。
 * 真报上来一个更大的数时，`getLocalTtsDetail` 认实时的，这里只兜「还没加载」那一段。
 *
 * VITS 的 5 是 2026-10-28 本机实测（第一次真合成后 /health 回 num_speakers=5）。
 * Kokoro 的 103 是 2026-10-29 本机实测：把那份钉死 sha256 的模型直接喂给 sherpa-onnx 2.0.1，
 * 加载后 num_speakers=103、sample_rate=24000、模型进内存 0.75s。
 */
const LOCAL_TTS_MODEL_SPEAKERS: Record<LocalTtsEngineId, number> = {
  'sherpa-onnx-vits-zh-ll': 5,
  'kokoro-multi-lang-v1_1': 103,
}

/**
 * 「设置 → 关于与更新 → 按需组件」里那三行的名字。
 * 缺件文案要说清「下的是哪一行」，就必须和界面显示的是同一个字符串——所以行名只写在这里一份，
 * componentService 的 SPECS 标题从这里取，两处不会各自漂移（那一栏印的就是 `s.title`）。
 * `name` 是文案里提到这一档时的叫法：直接把 id 摆进 toast（「sherpa-onnx-vits-zh-ll 的模型」）
 * 是给人看机器话，用户在那一栏里认的是 VITS / Kokoro。
 * 渲染层那份档位名在 src/utils/localTtsEngines.ts 的 LOCAL_TTS_ENGINE_OPTIONS，改档名时两处一起改
 * （主进程不能反向 import 渲染层，硬要共用就得把表挪进 preload，不值当）。
 */
export const COMPONENT_ROW_TITLES: {
  engineBinary: string
  models: Record<LocalTtsEngineId, { name: string; row: string }>
} = {
  engineBinary: '本地配音引擎',
  models: {
    'sherpa-onnx-vits-zh-ll': { name: 'VITS', row: 'VITS（体积小，音色支持少）' },
    'kokoro-multi-lang-v1_1': { name: 'Kokoro', row: 'Kokoro（体积大，音色支持多）' },
  },
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
 * 出来的是一个名词短语「VITS 的模型（约 135.5MB）」，调用方直接接在动词后面，
 * 不再出现「缺 sherpa-onnx-vits-zh-ll 的模型约 135.5MB」这种要用户自己翻译的说法。
 * 单位走 src/utils/formatBytes.ts（1000 进位）：下载引导、按需组件列表、关于页里的体积都出自
 * 同一个函数，不再一处按 1000、一处按 1024。
 * 数字只能算自钉死的指纹表——
 * 表里的字节数变了，这句话跟着变，不会再出现「129MB」和「135.5MB」并排。
 * 两档都钉了表（VITS 2026-10-28 / 135,454,939 字节，Kokoro 2026-10-29 / 426,573,262 字节），
 * 所以底下那个「没钉表」的分支本机走不到；真加了第三档时它说「不知道」，不拿另一档的数冒充。
 */
export function modelSizeHint(engine: LocalTtsEngineId): string {
  const name = COMPONENT_ROW_TITLES.models[engine].name
  const source = UPSTREAM_MODEL_SOURCES[engine]
  if (!source) return `${name} 的模型（这一档本版还没钉体积）`
  return `${name} 的模型（约 ${formatBytes(upstreamTotalBytes(source))}）`
}

/**
 * 缺件时给人看的那句话，只报真缺的那一样。启动失败（本文件的兜底）与设置页的「测试连接」
 * 共用这一份，两处不再各写各的：同一个缺失，两处说的话得一样。
 *
 * 为什么要把「另一样已经在磁盘上」说出来：这句以前不分情况都带上模型体积，于是磁盘上明明有模型、
 * 只差一个引擎二进制的机器上，用户会照着提示去下一个已经下好的 135.5MB 包。
 * 「缺哪样报哪样、并点出按需组件里的行名」才是他能一步做完的说法——行名就是那一栏显示的标题，
 * 点进去对得上号，不用在三行里猜哪一行是引擎。
 *
 * 两个位各自决定一句话能不能说：
 * - 模型看这一档本版钉没钉上游指纹表（`hasInAppModelDownload`）。两档现在都钉了（VITS 2026-10-28、
 *   Kokoro 2026-10-29），所以「去按需组件下载」指得动；哪天新加一档只写了 id 没写表，指过去就是
 *   答应了做不到的事——所以位仍然按表算，不写死 true。
 * - 引擎看本版清单里有没有那一条（`binaryInManifest`，由调用方传：这一位在 services/componentService，
 *   本文件是它的依赖，反过来问就成了环）。false 时那一行是收着按钮的，只能给出路（换回云端档）；
 *   null 是这一轮还没读过清单，所以只说「那一行会写明本版有没有包」，不替它答应下得到。
 * 启动失败那条路拿不到清单位（它就在 componentService 的依赖里），传 null 走最后一档说法。
 */
export function missingComponentsMessage(
  engine: LocalTtsEngineId,
  binaryPresent: boolean,
  modelPresent: boolean,
  binaryInManifest: boolean | null = null,
  tail = '下完才能配音',
): string {
  const { name, row } = COMPONENT_ROW_TITLES.models[engine]
  const binaryRow = COMPONENT_ROW_TITLES.engineBinary
  const fallback = `先在「设置 → 配音配置」换回 ${COMPONENT_ROW_TITLES.models[DEFAULT_LOCAL_TTS_ENGINE].name}，或改用云端档`

  if (!modelPresent && binaryPresent) {
    if (!hasInAppModelDownload(engine)) return `本地配音只缺 ${modelSizeHint(engine)}，而这一版没有放它的下载包——${fallback}`
    return `本地配音只缺 ${modelSizeHint(engine)}，引擎二进制已经在磁盘上了。请在「设置 → 关于与更新 → 按需组件」的「${row}」那一行下载，${tail}`
  }
  if (modelPresent && !binaryPresent) {
    if (binaryInManifest === false) {
      return `${name} 的模型已经在磁盘上了，不用重下——本地配音还差引擎二进制，而这一版没有它的下载包。要现在就配音，请在「设置 → 配音配置」改用云端接口`
    }
    const note = binaryInManifest === true ? '' : '（那一行会写明本版有没有它的下载包）'
    return `${name} 的模型已经在磁盘上了，不用重下——本地配音还差引擎二进制。请在「设置 → 关于与更新 → 按需组件」的「${binaryRow}」那一行下载${note}，${tail}`
  }
  const modelNote = hasInAppModelDownload(engine)
    ? `模型在「${row}」那一行`
    : `${name} 这一版没放它的下载包（${fallback}）`
  const binaryNote =
    binaryInManifest === false
      ? '引擎这一版也没有它的下载包（要现在就配音请改用云端接口）'
      : `引擎在「${binaryRow}」那一行${binaryInManifest === true ? '' : '（那一行会写明本版有没有它的下载包）'}`
  return `本地配音两样都还没下载：${modelSizeHint(engine)}和引擎二进制。下载入口在「设置 → 关于与更新 → 按需组件」，${modelNote}、${binaryNote}，${tail}`
}

/**
 * 起进程并等它认下这次的身份。调用方必须已经拿过单飞锁（见 ensureLocalTtsEngine）。
 * 失败时抛可直接弹 toast 的中文原因，主进程不跨 IPC 抛。
 */
async function startEngine(engine: LocalTtsEngineId): Promise<void> {
  const binaryPath = getBinaryPath()
  const modelPresent = existsSync(join(modelRootDir(), engine))
  if (!existsSync(binaryPath)) {
    lastError = missingComponentsMessage(engine, false, modelPresent)
    logger.warn(TAG, 'Engine binary missing', { path: basename(binaryPath), devMode: !!process.env.VITE_DEV_SERVER_URL })
    throw new Error(lastError)
  }
  if (!modelPresent) {
    // 只查目录在不在：里面缺哪个文件由 sidecar 自己报（它有真清单，这边再抄一份必然对不齐），
    // 而「整个模型没下载」是另一种事——那种情况用户要的是「去下载」，不是「重装」
    lastError = missingComponentsMessage(engine, true, false)
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

  engineProcess.stdout?.on('data', (data) => logSidecarOutput(String(data)))
  engineProcess.stderr?.on('data', (data) => logSidecarOutput(String(data)))
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

/**
 * sidecar 两条管道的内容按行分级，不再一刀切。
 *
 * 之前 stdout 全落 INFO、stderr 全落 WARN，而 uvicorn 的生命周期与访问日志走的是 stderr——
 * 本机 app.log 实测有「WARN LocalTTS: INFO:     Uvicorn running on http://127.0.0.1:8010」
 * 这种条目，一次启动+一次停机就刷六七条 WARN。用户「打开日志文件夹」拿来的那一堆里，
 * 真警告和正常起停长得一样，等于把警告埋在自己的噪声里。
 *
 * 只降两类：uvicorn 自己打了 `INFO:` 前缀的那些，和本应用 sidecar 用 `[TTS]` 前缀写的
 * 起停/加载横幅（`log()` 走 stdout，一次成功启动就三条，把它们记成 WARN 等于让用户以为
 * 引擎出过事）。sherpa-onnx 的 C++ 输出（如 `Ignore OOV '：'`，确实是读音退化的信号）
 * 与 PyInstaller 引导器的话一律保持 WARN——宁可吵，不吞。
 * `[TTS]` 里唯二是真事故的是「模型加载失败」和「启动被拒」（白名单没过），那两条落 ERROR。
 */
function logSidecarOutput(raw: string): void {
  for (const line of raw.split('\n')) {
    const body = line.trim()
    if (!body) continue
    if (/^ERROR:/.test(body) || /^Traceback \(most recent call last\)/.test(body)) logger.error(TAG, body)
    else if (/^INFO:/.test(body)) logger.info(TAG, body)
    else if (/^\[TTS\] (load failed|启动被拒)/.test(body)) logger.error(TAG, body)
    else if (/^\[TTS\] /.test(body)) logger.info(TAG, body)
    else logger.warn(TAG, body)
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
 * 本地档的「音色」在界面上是一个下拉，显示按 1…N 编号，落到配置里仍是 sid 编号的字符串写法
 * （'0' 就是界面上那行「音色 1」——sherpa 的 sid 从 0 数起，界面从 1 数起，转换只发生在这一层）。
 * 收口成数字前先验格式：云端那档的音色名（'alloy'）会被原样带过来，
 * 直接 Number() 会得到 NaN 再被 sidecar 拒成一句看不懂的 400。
 * 上限不在这里判，由 sidecar 按它真加载的那份模型说了算（`LOCAL_TTS_MODEL_SPEAKERS` 那份是给界面列表用的，
 * 拿它来拒请求等于把一个静态数摆成第二道闸，模型换了它不会跟着报错）。
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
  /** 这一档有几个音色：模型真加载了用 /health 报的数，没加载用钉死指纹那份的实测值；0＝还不知道 */
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
    // 引擎还没起来时也要能把音色列表列全：这一档有几个说话人是那份钉死指纹的模型的性质，
    // 不是这台进程的性质，所以懒启动阶段照报得出来（见 LOCAL_TTS_MODEL_SPEAKERS 的口径）
    speakers: LOCAL_TTS_MODEL_SPEAKERS[engine],
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

  // /health 报的是「这个端口上的进程」那一档的状态。界面上问的是另一档时（VITS 正在跑、用户把
  // 模型下拉切到 Kokoro），sample_rate 这种「这台进程实际在用什么采样率」不能挪用，按 0 回，
  // 界面那侧的口径是「还不知道」。speakers 不一样：它问的是「选中这一档有几个说话人」，
  // 跨档也得答得出，所以只在同一档时让实时值覆盖静态表（表写小了由它纠正），跨档就回表里那份。
  const servingEngine = typeof health.engine === 'string' ? health.engine : null
  const sameTier = servingEngine === engine

  return {
    ...base,
    ready: status.ready,
    error: status.ready ? null : status.error,
    engine: servingEngine,
    engineLoaded: typeof health.engine_loaded === 'string' ? health.engine_loaded : null,
    speakers: sameTier ? Number(health.speakers) || base.speakers : base.speakers,
    sampleRate: sameTier ? Number(health.sample_rate) || 0 : 0,
  }
}
