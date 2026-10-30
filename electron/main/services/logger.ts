/**
 * 日志服务
 * 记录用户操作、服务调用和错误信息，便于问题排查
 * 日志文件保存在 userData 目录下的 logs 文件夹
 *
 * 这一层是日志的唯一写入口，也是 #281 那道闸门的所在：每条记录在序列化之前都要过
 * `logRedact.redactEntry`（凭据字段、用户原文字段、绝对路径、超长文本），
 * 落盘之前都要过 `ensureRoom`（单文件到上限就把 app.log 挪成 app.1.log，旧的一路往后推，
 * 只留 3 份）。两件事都长在写盘的那两个口上，调用点没法绕过去——以前「日志不带全路径」
 * 靠调用点各自记得写 `basename()`，没记到的那些照抄原样进盘（具体几处见 `logRedact.ts` 头上），
 * 这跟 #280 之前那句「不跨 IPC 抛错」只写在注释里是同一个毛病。
 */
import { mkdir, appendFile } from 'node:fs/promises'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logsDir } from './userDataStore'
import { redactEntry } from './logRedact'

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

interface LogEntry {
  timestamp: string
  level: LogLevel
  module: string
  message: string
  data?: unknown
}

/**
 * 单文件上限。本机那份真实 app.log 是 3,113,607 字节 / 15,946 行，均值约 195 字节/行，
 * 按它折算 5MB 约装得下 2.7 万条；配合下面留的 3 份，logs/ 这一层最坏占 20MB——
 * 用户「打开日志文件夹」发回来的那一份也就还发得动。
 */
export const MAX_LOG_BYTES = 5 * 1024 * 1024
/** app.log 之外再留几份轮转（app.1.log / app.2.log / app.3.log），第四份起老的直接扔 */
export const KEEP_ROTATIONS = 3

class Logger {
  private logDir: string
  private logFile: string
  private initialized = false
  /**
   * 已写字节的内存计数：第一次写时 stat 一次，之后每行累加。
   * 不做每行 stat——那是把一次顺序写换成一次同步系统调用。代价是多个应用实例共用同一份
   * 日志时计数会偏小，偏小的结局只是晚一点轮转，不会写爆磁盘，也不会丢行。
   */
  private bytes: number | null = null

  constructor() {
    this.logDir = logsDir()
    this.logFile = join(this.logDir, 'app.log')
  }

  private async init() {
    if (this.initialized) return
    try {
      await mkdir(this.logDir, { recursive: true })
      this.initialized = true
      console.log(`[Logger] Log directory: ${this.logDir}`)
    } catch (err) {
      console.error('[Logger] Failed to create log directory:', err)
    }
  }

  /** 0 是 app.log 本身，1..KEEP 是轮转出去的旧档 */
  private rotationName(index: number): string {
    return index === 0 ? this.logFile : join(this.logDir, `app.${index}.log`)
  }

  /**
   * 这一行还塞得下吗；塞不下就先把 app.log 挪走。
   * 全程同步是必需的：常规 write 与崩溃路径的 errorSync 共用这一条，而 errorSync 那一头没法 await。
   * 挪不动（目录只读、旧档被别的进程占着）也绝不吞掉这一行：这一条按「没轮转」处理、计数继续累加，
   * 于是下一行还会再试一次——把它当成「文件已清空」的话，就得再攒满 5MB 才想起来挪。
   * 返回 true 表示这次**真的**挪成功了，调用方据此在新 app.log 开头补一句说明，
   * 免得读日志的人只看到时间戳突然跳了一段；没挪成就不能说这句（那就是句谎）。
   */
  private ensureRoom(incoming: number): boolean {
    if (this.bytes === null) {
      try {
        this.bytes = statSync(this.logFile).size
      } catch {
        this.bytes = 0
      }
    }
    if (this.bytes + incoming <= MAX_LOG_BYTES) {
      this.bytes += incoming
      return false
    }
    try {
      rmSync(this.rotationName(KEEP_ROTATIONS), { force: true })
      for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
        const from = this.rotationName(i)
        // 这里只该为「这一份本来就没有」跳过；挪不动是真故障，要让它冒到下面那个 catch
        if (existsSync(from)) renameSync(from, this.rotationName(i + 1))
      }
      renameSync(this.logFile, this.rotationName(1))
    } catch {
      this.bytes += incoming
      return false
    }
    this.bytes = incoming
    return true
  }

  private rotationMarker(): string {
    return this.compose(
      'INFO',
      'Logger',
      `日志轮转：app.log 到了 ${(MAX_LOG_BYTES / 1024 / 1024).toFixed(0)}MB 上限，旧的移到 app.1.log（最多留 ${KEEP_ROTATIONS} 份，超出的一档删除）`
    ).line
  }

  /**
   * 一条记录的全部准备工作都在这里：脱敏一次，同时给出「落盘那一行」和「上控制台的那两句」。
   * 只跑一次 redactEntry 是必需的——跑两遍就意味着控制台和文件可能说不一样，
   * 而用户截图控制台、发回 app.log 时，差的正是最难查的那种问题。
   */
  private compose(
    level: LogLevel,
    module: string,
    message: string,
    data?: unknown,
    timestamp = new Date().toISOString()
  ): { line: string; message: string; data: unknown } {
    const clean = redactEntry(message, data)
    const entry: LogEntry = {
      timestamp,
      level,
      module,
      message: clean.message,
      data: clean.data,
    }
    return { line: JSON.stringify(entry) + '\n', message: clean.message, data: clean.data }
  }

  private consoleLine(level: LogLevel, module: string, message: string, data?: unknown): void {
    const prefix = `[${level}][${module}]`
    try {
      if (level === 'ERROR') {
        console.error(prefix, message, data || '')
      } else if (level === 'WARN') {
        console.warn(prefix, message, data || '')
      } else {
        console.log(prefix, message, data || '')
      }
    } catch {
      // EPIPE: stdout pipe broken (e.g. dev server restarted)
    }
  }

  private async write(level: LogLevel, module: string, message: string, data?: unknown) {
    await this.init()
    const entry = this.compose(level, module, message, data)
    const marker = this.ensureRoom(Buffer.byteLength(entry.line, 'utf-8'))
    this.consoleLine(level, module, entry.message, entry.data)

    try {
      await appendFile(this.logFile, (marker ? this.rotationMarker() : '') + entry.line, 'utf-8')
    } catch (err) {
      console.error('[Logger] Failed to write log:', err)
    }
  }

  info(module: string, message: string, data?: unknown) {
    return this.write('INFO', module, message, data)
  }

  warn(module: string, message: string, data?: unknown) {
    return this.write('WARN', module, message, data)
  }

  error(module: string, message: string, data?: unknown) {
    return this.write('ERROR', module, message, data)
  }

  debug(module: string, message: string, data?: unknown) {
    return this.write('DEBUG', module, message, data)
  }

  /**
   * 同步落盘的一条 ERROR，只给「写完就要阻塞事件循环」的崩溃兜底用（见 crashWatch）。
   * 常规 write 走的是 fs/promises：调用方拿到的是 Promise，字节要等微任务队列转一圈才落盘。
   * 而 dialog.showMessageBoxSync 恰恰会把事件循环按住不放——实测那条 'Render process gone'
   * 要等用户点掉对话框才出现在 app.log 里。用户要是那会儿强杀进程，现场就没了。
   *
   * 这一条同样过脱敏与轮转（都在 compose / ensureRoom 里，它一个都没绕开）。
   */
  errorSync(module: string, message: string, data?: unknown) {
    const entry = this.compose('ERROR', module, message, data)
    const marker = this.ensureRoom(Buffer.byteLength(entry.line, 'utf-8'))
    try {
      console.error(`[ERROR][${module}]`, entry.message, entry.data || '')
    } catch {
      // EPIPE: stdout pipe broken
    }
    try {
      mkdirSync(this.logDir, { recursive: true })
      this.initialized = true
      appendFileSync(this.logFile, (marker ? this.rotationMarker() : '') + entry.line, 'utf-8')
    } catch (err) {
      console.error('[Logger] Failed to write log synchronously:', err)
    }
  }

  // 用户操作日志
  userAction(action: string, details?: unknown) {
    return this.info('UserAction', action, details)
  }

  // 服务调用日志
  serviceCall(service: string, method: string, params?: unknown) {
    return this.info('ServiceCall', `${service}.${method}`, params)
  }

  // 错误日志
  serviceError(service: string, method: string, error: unknown) {
    const err = error as { message?: unknown; stack?: unknown } | null | undefined
    return this.error('ServiceError', `${service}.${method}`, {
      message: err?.message,
      stack: err?.stack,
    })
  }
}

export const logger = new Logger()
