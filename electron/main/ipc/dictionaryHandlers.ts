/**
 * 词典服务 IPC 处理器
 * 提供词典查询（单词/批量）、版本检查、更新下载等功能
 * 应用启动时自动初始化词典缓存
 */
import { ipcMain } from 'electron'
import { lookupWord, lookupMultipleWords, initDictionary, checkForUpdate, downloadUpdate, getCurrentVersion } from '../services/dictionaryService'

export function registerDictionaryHandlers() {
  initDictionary().catch(console.error)

  ipcMain.handle('dictionary:lookup', async (_event, word: string) => {
    return await lookupWord(word)
  })

  ipcMain.handle('dictionary:lookupMultiple', async (_event, words: string[]) => {
    return await lookupMultipleWords(words)
  })

  ipcMain.handle('dictionary:checkUpdate', async () => {
    return await checkForUpdate()
  })

  ipcMain.handle('dictionary:downloadUpdate', async () => {
    return await downloadUpdate()
  })

  ipcMain.handle('dictionary:getVersion', async () => {
    return getCurrentVersion()
  })
}
