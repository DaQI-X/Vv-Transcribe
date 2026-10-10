/**
 * 前端日志服务
 * 记录用户操作和关键事件，通过 IPC 发送到主进程写入日志文件
 */
import { getElectronAPI } from '@/hooks/useElectronAPI'

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

class FrontendLogger {
  private api: ReturnType<typeof getElectronAPI> | null = null

  setAPI(api: ReturnType<typeof getElectronAPI>) {
    this.api = api
  }

  private log(level: LogLevel, module: string, message: string, data?: any) {
    const timestamp = new Date().toISOString()
    const entry = { timestamp, level, module, message, data }

    // 输出到浏览器控制台
    const prefix = `[${level}][${module}]`
    if (level === 'ERROR') {
      console.error(prefix, message, data || '')
    } else if (level === 'WARN') {
      console.warn(prefix, message, data || '')
    } else {
      console.log(prefix, message, data || '')
    }

    // 发送到主进程写入日志文件
    if (this.api?.log) {
      this.api.log(entry).catch(() => {
        // 忽略日志写入失败
      })
    }
  }

  info(module: string, message: string, data?: any) {
    this.log('INFO', module, message, data)
  }

  warn(module: string, message: string, data?: any) {
    this.log('WARN', module, message, data)
  }

  error(module: string, message: string, data?: any) {
    this.log('ERROR', module, message, data)
  }

  debug(module: string, message: string, data?: any) {
    this.log('DEBUG', module, message, data)
  }

  // 用户操作日志
  userAction(action: string, details?: any) {
    this.info('UserAction', action, details)
  }

  // 服务调用日志
  serviceCall(service: string, method: string, params?: any) {
    this.info('ServiceCall', `${service}.${method}`, params)
  }
}

export const frontendLogger = new FrontendLogger()
