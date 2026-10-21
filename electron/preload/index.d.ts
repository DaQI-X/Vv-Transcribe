/**
 * Electron API 类型声明
 * 定义 preload 暴露给渲染进程的所有接口类型
 */
export interface FileMetadata {
  path: string
  name: string
  size: number
  extension: string
  type: 'audio' | 'video'
  lastModified: number
}

export interface ExtractAudioResult {
  success: boolean
  wavPath?: string
  tempDir?: string
  duration?: number
  error?: string
}

export interface DownloadFromUrlResult {
  success: boolean
  filePath?: string
  tempDir?: string
  title?: string
  error?: string
}

export interface ProbeAudioResult {
  success: boolean
  metadata?: {
    duration: number
    codec: string
    channels: number
    sampleRate: number
  }
  error?: string
}

export interface ElectronAPI {
  getDroppedFilePath: (file: File) => string
  selectFile: () => Promise<string | null>
  getFileMetadata: (filePath: string) => Promise<FileMetadata | null>
  extractAudio: (filePath: string) => Promise<ExtractAudioResult>
  cleanupTemp: (tempDir: string) => Promise<void>
  probeAudio: (filePath: string) => Promise<ProbeAudioResult>
  downloadFromUrl: (url: string) => Promise<DownloadFromUrlResult>
  selectTextFile: () => Promise<string | null>
  readTextFile: (filePath: string) => Promise<string | null>
  saveTextFile: (
    suggestedName: string,
    content: string,
  ) => Promise<{ success: boolean; name?: string; canceled?: boolean; error?: string }>

  startTranscription: (
    filePath: string,
    options: unknown,
  ) => Promise<{
    jobId: string
    success: boolean
    provider?: 'local' | 'cloud'
    canceled?: boolean
    error?: string
  }>
  cancelTranscription: (jobId: string) => Promise<void>

  onTranscriptionProgress: (
    callback: (data: {
      jobId: string
      progress: number
      segment?: {
        startTime: number
        endTime: number
        text: string
        confidence?: number
      }
      /** 引擎阶段性状态，目前只有本地首次转写的 'loading_model' */
      stage?: string
    }) => void,
  ) => () => void

  correctText: (
    text: string,
    options: unknown,
  ) => Promise<{ corrected: string; changes: string[]; error?: string }>
  explainDifferences: (
    differences: Array<{ original: string; corrected: string; context: string }>,
  ) => Promise<Array<{ explanation: string; dictionaryHint?: string }>>
  analyzeReference: (
    referenceText: string,
  ) => Promise<{
    issues: Array<{
      text: string
      suggestion?: string
      explanation: string
      dictionaryHint?: string
      refStart: number
      refEnd: number
    }>
    error: string | null
  }>

  lookupWord: (word: string) => Promise<{ found: boolean; explanation?: string }>
  lookupMultipleWords: (words: string[]) => Promise<Record<string, string>>
  checkDictionaryUpdate: () => Promise<{ hasUpdate: boolean; latestCommit?: string; currentVersion: string; error: string | null }>
  downloadDictionaryUpdate: () => Promise<{ success: boolean; error?: string }>
  getDictionaryVersion: () => Promise<string>

  getSettings: () => Promise<Record<string, unknown>>
  saveSettings: (settings: Record<string, unknown>) => Promise<void>

  getServiceReady: () => Promise<{
    ready: boolean
    error: string | null
    asrDone: boolean
    dictionaryDone: boolean
  }>

  getAppVersion: () => Promise<string>
  checkAppUpdate: () => Promise<{
    currentVersion: string
    latestVersion: string
    hasUpdate: boolean
    downloadUrl: string
  }>
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>

  openLogDirectory: () => Promise<{ success: boolean; error?: string }>

  toggleWindowMaximize: () => Promise<boolean>
  minimizeWindow: () => Promise<boolean>
  closeWindow: () => Promise<boolean>

  log: (entry: Record<string, unknown>) => Promise<void>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
