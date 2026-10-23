/**
 * Electron preload 脚本
 * 通过 contextBridge 向渲染进程暴露安全的 IPC 调用接口
 * 涵盖：文件操作、ASR 转写、AI 纠错、设置管理、词典查询
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  getDroppedFilePath: (file: File) => webUtils.getPathForFile(file),
  selectFile: () => ipcRenderer.invoke('dialog:selectFile'),
  getFileMetadata: (filePath: string) =>
    ipcRenderer.invoke('file:getMetadata', filePath),
  extractAudio: (filePath: string) =>
    ipcRenderer.invoke('file:extractAudio', filePath),
  cleanupTemp: (tempDir: string) =>
    ipcRenderer.invoke('file:cleanupTemp', tempDir),
  probeAudio: (filePath: string) =>
    ipcRenderer.invoke('file:probeAudio', filePath),
  downloadFromUrl: (url: string) =>
    ipcRenderer.invoke('file:downloadFromUrl', url),
  selectTextFile: () =>
    ipcRenderer.invoke('dialog:selectTextFile'),
  readTextFile: (filePath: string) =>
    ipcRenderer.invoke('file:readTextFile', filePath),
  saveTextFile: (suggestedName: string, content: string) =>
    ipcRenderer.invoke('file:saveText', { suggestedName, content }),

  startTranscription: (filePath: string, options: unknown) =>
    ipcRenderer.invoke('asr:start', filePath, options),
  cancelTranscription: (jobId: string) =>
    ipcRenderer.invoke('asr:cancel', jobId),

  onTranscriptionProgress: (
    callback: (data: {
      jobId: string
      progress: number
      segment?: unknown
      stage?: string
    }) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { jobId: string; progress: number; segment?: unknown; stage?: string },
    ) => callback(data)
    ipcRenderer.on('asr:progress', listener)
    return () => {
      ipcRenderer.removeListener('asr:progress', listener)
    }
  },

  correctText: (text: string, options: unknown) =>
    ipcRenderer.invoke('ai:correct', text, options),
  explainDifferences: (differences: unknown[]) =>
    ipcRenderer.invoke('ai:explainDifferences', differences),
  analyzeReference: (referenceText: string) =>
    ipcRenderer.invoke('ai:analyzeReference', referenceText),

  lookupWord: (word: string) =>
    ipcRenderer.invoke('dictionary:lookup', word),
  lookupMultipleWords: (words: string[]) =>
    ipcRenderer.invoke('dictionary:lookupMultiple', words),
  checkDictionaryUpdate: () =>
    ipcRenderer.invoke('dictionary:checkUpdate'),
  downloadDictionaryUpdate: () =>
    ipcRenderer.invoke('dictionary:downloadUpdate'),
  getDictionaryVersion: () =>
    ipcRenderer.invoke('dictionary:getVersion'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: unknown) =>
    ipcRenderer.invoke('settings:save', settings),
  testConnection: (kind: 'asr' | 'ai', values: unknown) =>
    ipcRenderer.invoke('settings:testConnection', kind, values),

  getServiceReady: () =>
    ipcRenderer.invoke('app:getServiceReady'),

  getAppVersion: () =>
    ipcRenderer.invoke('app:getVersion'),
  checkAppUpdate: () =>
    ipcRenderer.invoke('app:checkUpdate'),
  openExternal: (url: string) =>
    ipcRenderer.invoke('app:openExternal', url),
  openSystemSettings: () =>
    ipcRenderer.invoke('app:openSystemSettings'),

  openLogDirectory: () =>
    ipcRenderer.invoke('app:openLogDirectory'),

  toggleWindowMaximize: () =>
    ipcRenderer.invoke('window:toggleMaximize'),

  minimizeWindow: () =>
    ipcRenderer.invoke('window:minimize'),

  closeWindow: () =>
    ipcRenderer.invoke('window:close'),

  log: (entry: unknown) =>
    ipcRenderer.invoke('app:log', entry),
}

contextBridge.exposeInMainWorld('electronAPI', api)
