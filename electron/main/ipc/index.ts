/**
 * IPC 处理器注册中心
 * 统一注册所有主进程 IPC 通道处理器，在 app.whenReady() 时调用
 */
import { registerFileHandlers } from './fileHandlers'
import { registerASRHandlers } from './asrHandlers'
import { registerAIHandlers } from './aiHandlers'
import { registerSettingsHandlers } from './settingsHandlers'
import { registerDictionaryHandlers } from './dictionaryHandlers'
import { registerWindowHandlers } from './windowHandlers'
import { registerUpdateHandlers } from './updateHandlers'

/** 注册全部 IPC 处理器，包括文件、ASR、AI、设置、词典、窗口控制、更新检查模块 */
export function registerAllHandlers() {
  registerFileHandlers()
  registerASRHandlers()
  registerAIHandlers()
  registerSettingsHandlers()
  registerDictionaryHandlers()
  registerWindowHandlers()
  registerUpdateHandlers()
}
