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

  startTranscription: (filePath: string, options: unknown) =>
    ipcRenderer.invoke('asr:start', filePath, options),
  cancelTranscription: (jobId: string) =>
    ipcRenderer.invoke('asr:cancel', jobId),

  onTranscriptionProgress: (
    callback: (data: { jobId: string; progress: number; segment?: unknown }) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { jobId: string; progress: number; segment?: unknown },
    ) => callback(data)
    ipcRenderer.on('asr:progress', listener)
    return () => {
      ipcRenderer.removeListener('asr:progress', listener)
    }
  },

  correctText: (text: string, options: unknown) =>
    ipcRenderer.invoke('ai:correct', text, options),

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
}

contextBridge.exposeInMainWorld('electronAPI', api)
