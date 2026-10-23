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
  /** 扩展名是否在支持的清单里（拖拽进来的文件没经过选择框，得由主进程判） */
  supported: boolean
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
  systemSettingsHint?: boolean
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

/** 「测试连接 / 检查引擎状态」的结构化结论，由主进程生成中文文案 */
export interface TestOutcome {
  /** pass=可以直接干活；warn=能用但工作阶段会掉级；fail=干活一定失败 */
  level: 'pass' | 'warn' | 'fail'
  title: string
  message: string
}

export interface ConnectionTestValues {
  /** 转写用：local 时主进程改查本机引擎，不发任何网络请求 */
  provider?: string
  apiBase: string
  apiKey: string
  model: string
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
  testConnection: (kind: 'asr' | 'ai', values: ConnectionTestValues) => Promise<TestOutcome>

  getServiceReady: () => Promise<{
    ready: boolean
    error: string | null
    /** 引擎真的可用；启动流程跑完但失败时为 false */
    asrDone: boolean
    /** asrDone 为 false 时的可读原因，不会因此把开屏页判成致命错误 */
    asrError: string | null
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
  openSystemSettings: () => Promise<{ success: boolean; error?: string }>

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
