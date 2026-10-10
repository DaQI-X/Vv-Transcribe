/**
 * Python ASR 服务管理器
 * 负责在 Electron 主进程启动时自动拉起 Python ASR 子进程，退出时优雅关闭
 * 
 * 二进制查找路径：
 * - 开发模式：python-asr/dist/vv-asr-server
 * - 打包模式：process.resourcesPath/python-asr/vv-asr-server
 * 
 * 启动流程：spawn 子进程 → 轮询 /health 直到就绪 → 标记服务可用
 * 关闭流程：SIGTERM → 等待退出 → 超时 SIGKILL
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const ASR_PORT = 8000
const ASR_URL = `http://localhost:${ASR_PORT}`
const HEALTH_TIMEOUT_MS = 60_000
const HEALTH_POLL_INTERVAL_MS = 500
const SHUTDOWN_TIMEOUT_MS = 5_000

let asrProcess: ChildProcess | null = null
let asrReady = false

/** 获取 ASR 二进制文件路径（区分开发/打包环境） */
function getBinaryPath(): string {
  if (process.env.VITE_DEV_SERVER_URL) {
    return join(import.meta.dirname, '../../python-asr/dist/vv-asr-server')
  }
  return join(process.resourcesPath, 'python-asr', 'vv-asr-server')
}

/** 轮询 health 接口，等待 ASR 服务就绪 */
async function waitForReady(): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    try {
      const res = await fetch(`${ASR_URL}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        console.log('[ASR Service] Ready')
        return true
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS))
  }
  return false
}

/** 启动 Python ASR 服务 */
export async function startASRService(): Promise<boolean> {
  const binaryPath = getBinaryPath()

  if (!existsSync(binaryPath)) {
    console.warn(`[ASR Service] Binary not found at ${binaryPath}, local ASR unavailable`)
    return false
  }

  if (asrProcess) {
    console.log('[ASR Service] Already running')
    return asrReady
  }

  // 检查端口是否已被占用（可能用户手动启动了服务）
  try {
    const res = await fetch(`${ASR_URL}/health`, { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      console.log('[ASR Service] Already running on port', ASR_PORT, '(external process)')
      asrReady = true
      return true
    }
  } catch {
    // port not occupied, proceed to start
  }

  console.log('[ASR Service] Starting:', binaryPath)

  asrProcess = spawn(binaryPath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com' },
    detached: false,
  })

  asrProcess.stdout?.on('data', (data) => {
    console.log(`[ASR Service] ${data.toString().trim()}`)
  })

  asrProcess.stderr?.on('data', (data) => {
    console.error(`[ASR Service] ${data.toString().trim()}`)
  })

  asrProcess.on('exit', (code, signal) => {
    console.log(`[ASR Service] Process exited (code: ${code}, signal: ${signal})`)
    asrProcess = null
    asrReady = false
  })

  asrProcess.on('error', (err) => {
    console.error('[ASR Service] Process error:', err.message)
    asrProcess = null
    asrReady = false
  })

  asrReady = await waitForReady()

  if (!asrReady) {
    console.error('[ASR Service] Failed to become ready within timeout')
    stopASRService()
    return false
  }

  return true
}

/** 优雅关闭 Python ASR 服务 */
export function stopASRService(): Promise<void> {
  return new Promise((resolve) => {
    if (!asrProcess) {
      resolve()
      return
    }

    console.log('[ASR Service] Shutting down...')

    const killTimer = setTimeout(() => {
      if (asrProcess) {
        console.warn('[ASR Service] Force killing after timeout')
        asrProcess.kill('SIGKILL')
      }
    }, SHUTDOWN_TIMEOUT_MS)

    asrProcess.once('exit', () => {
      clearTimeout(killTimer)
      asrProcess = null
      asrReady = false
      console.log('[ASR Service] Stopped')
      resolve()
    })

    asrProcess.kill('SIGTERM')
  })
}

/** 获取 ASR 服务状态 */
export function isASRServiceReady(): boolean {
  return asrReady
}
