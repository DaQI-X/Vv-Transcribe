/**
 * 日志服务
 * 记录用户操作、服务调用和错误信息，便于问题排查
 * 日志文件保存在 userData 目录下的 logs 文件夹
 */
import { app } from 'electron'
import { mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

interface LogEntry {
  timestamp: string
  level: LogLevel
  module: string
  message: string
  data?: any
}

class Logger {
  private logDir: string
  private logFile: string
  private initialized = false

  constructor() {
    this.logDir = join(app.getPath('userData'), 'logs')
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

  private formatEntry(level: LogLevel, module: string, message: string, data?: any): string {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
      data,
    }
    return JSON.stringify(entry) + '\n'
  }

  private async write(level: LogLevel, module: string, message: string, data?: any) {
    await this.init()
    const line = this.formatEntry(level, module, message, data)

    // 同时输出到控制台和文件
    const prefix = `[${level}][${module}]`
    if (level === 'ERROR') {
      console.error(prefix, message, data || '')
    } else if (level === 'WARN') {
      console.warn(prefix, message, data || '')
    } else {
      console.log(prefix, message, data || '')
    }

    try {
      await appendFile(this.logFile, line, 'utf-8')
    } catch (err) {
      console.error('[Logger] Failed to write log:', err)
    }
  }

  info(module: string, message: string, data?: any) {
    return this.write('INFO', module, message, data)
  }

  warn(module: string, message: string, data?: any) {
    return this.write('WARN', module, message, data)
  }

  error(module: string, message: string, data?: any) {
    return this.write('ERROR', module, message, data)
  }

  debug(module: string, message: string, data?: any) {
    return this.write('DEBUG', module, message, data)
  }

  // 用户操作日志
  userAction(action: string, details?: any) {
    return this.info('UserAction', action, details)
  }

  // 服务调用日志
  serviceCall(service: string, method: string, params?: any) {
    return this.info('ServiceCall', `${service}.${method}`, params)
  }

  // 错误日志
  serviceError(service: string, method: string, error: any) {
    return this.error('ServiceError', `${service}.${method}`, {
      message: error?.message,
      stack: error?.stack,
    })
  }
}

export const logger = new Logger()
