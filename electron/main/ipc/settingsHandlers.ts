/**
 * 设置持久化 IPC 处理器
 * 提供设置的读取、保存，以及「测试连接 / 检查引擎状态」接口
 * 数据存储在 userData/settings.json
 */
import { ipcMain } from 'electron'
import { loadSettings, saveSettings } from '../services/settingsService'
import { testASRConfig, testAIConfig, type AsrTestValues, type AITestValues } from '../services/connectionTestService'
import { logger } from '../services/logger'

export function registerSettingsHandlers() {
  ipcMain.handle('settings:get', async () => {
    return loadSettings()
  })

  ipcMain.handle('settings:save', async (_event, settings: Record<string, unknown>) => {
    return saveSettings(settings)
  })

  ipcMain.handle('settings:testConnection', async (_event, kind: 'asr' | 'ai', values: AsrTestValues | AITestValues) => {
    try {
      return kind === 'ai'
        ? await testAIConfig(values as AITestValues)
        : await testASRConfig(values as AsrTestValues)
    } catch (err) {
      // 兜底：任何未预期异常都要变成界面上的结论，而不是让渲染层的 await 直接抛
      const message = err instanceof Error ? err.message : String(err)
      logger.error('ConnTest', 'probe crashed', { kind, message })
      return { level: 'fail' as const, title: '测试没能跑完', message }
    }
  })
}
