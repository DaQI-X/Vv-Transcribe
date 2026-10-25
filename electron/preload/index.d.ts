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
    content: string
  ) => Promise<{ success: boolean; name?: string; canceled?: boolean; error?: string }>

  startTranscription: (
    filePath: string,
    options: unknown
  ) => Promise<{
    jobId: string
    success: boolean
    provider?: 'local' | 'cloud'
    canceled?: boolean
    error?: string
  }>
  cancelTranscription: (jobId: string) => Promise<void>
  /** 应用内重启本地引擎。转写进行中会被拒绝；最长可能等 60 秒（首次要下载模型） */
  restartLocalEngine: () => Promise<{ ok: boolean; error: string | null }>

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
      /** 随 status 事件下发的档位与权重体积，界面用它说清「这次要下载多大」 */
      model?: { tier: string; weightsMb: number | null }
    }) => void
  ) => () => void

  correctText: (
    text: string,
    options: unknown
  ) => Promise<{ corrected: string; changes: string[]; error?: string }>
  explainDifferences: (
    differences: Array<{ original: string; corrected: string; context: string }>
  ) => Promise<Array<{ explanation: string; dictionaryHint?: string }>>
  analyzeReference: (referenceText: string) => Promise<{
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

  proofreadLocal: (segments: Array<{ id: string; text: string }>) => Promise<
    Array<{
      segmentId: string
      corrected: string
      changes: Array<{ before: string; after: string; reason: string; dictionaryHint?: string }>
    }>
  >
  proofreadExplain: (
    differences: Array<{ original: string; corrected: string; context: string }>
  ) => Promise<Array<{ explanation: string; dictionaryHint?: string }>>

  lookupWord: (word: string) => Promise<{ found: boolean; explanation?: string }>
  lookupMultipleWords: (words: string[]) => Promise<Record<string, string>>
  checkDictionaryUpdate: () => Promise<{
    hasUpdate: boolean
    latestCommit?: string
    currentVersion: string
    error: string | null
  }>
  downloadDictionaryUpdate: () => Promise<{ success: boolean; error?: string }>
  getDictionaryVersion: () => Promise<string>

  /**
   * 脱敏视图：两把 API Key 不回明文（值根本不过 IPC），只给状态。
   * 字段是 asrKeyStatus / aiKeyStatus（none / encrypted / plaintext / unreadable）
   * 与 keyEncryptionAvailable，见 SettingsModal 的 KeyStatus。
   */
  getSettings: () => Promise<Record<string, unknown>>
  /**
   * tierRestart：本次保存改了本地档位时的引擎重启结果。
   * busy / failed 时 error 是必须展示给用户的原因——这两种情况下新档位其实还没生效。
   * 密钥字段按「留空＝不改、null＝清除、非空＝替换」处理，返回值同样是脱敏视图。
   */
  saveSettings: (settings: Record<string, unknown>) => Promise<{
    settings: Record<string, unknown>
    tierRestart: 'not-needed' | 'done' | 'busy' | 'failed'
    error: string | null
  }>
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
  /** 本机当前生效的链接解析组件：version 探不到是 null（不要把未知显示成「未知版本」以外的任何说法） */
  getYtDlpLocal: () => Promise<{
    version: string | null
    source: 'updated' | 'bundled' | 'system' | 'path'
    bytes: number | null
  }>
  checkYtDlpUpdate: () => Promise<{
    ok: boolean
    error: string | null
    local?: {
      version: string | null
      source: 'updated' | 'bundled' | 'system' | 'path'
      bytes: number | null
    }
    remote?: { version: string; bytes: number }
    hasUpdate?: boolean
  }>
  applyYtDlpUpdate: () => Promise<{
    success: boolean
    error?: string
    version?: string
    bytes?: number
    rolledBack?: boolean
    systemSettingsHint?: boolean
  }>
  /** 订阅下载进度，返回取消订阅的函数（与 onTranscriptionProgress 同一写法） */
  onYtDlpProgress: (callback: (data: { received: number; total: number }) => void) => () => void
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>
  openSystemSettings: () => Promise<{ success: boolean; error?: string }>
  contactDeveloper: () => Promise<{ success: boolean; email: string; error?: string }>

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
