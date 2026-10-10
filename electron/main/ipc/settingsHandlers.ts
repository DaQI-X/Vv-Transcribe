/**
 * 设置持久化 IPC 处理器
 * 提供设置的读取和保存接口，数据存储在 userData/settings.json
 */
import { ipcMain } from 'electron'
import { loadSettings, saveSettings } from '../services/settingsService'

export function registerSettingsHandlers() {
  ipcMain.handle('settings:get', async () => {
    return loadSettings()
  })

  ipcMain.handle('settings:save', async (_event, settings: Record<string, unknown>) => {
    return saveSettings(settings)
  })
}
