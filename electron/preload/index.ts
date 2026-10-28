/**
 * Electron preload 脚本
 * 通过 contextBridge 向渲染进程暴露安全的 IPC 调用接口
 * 涵盖：文件操作、ASR 转写、AI 校对、设置管理、词典查询
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'

/** 与 index.d.ts 的 MediaProgress 对齐：主进程逐行解析 yt-dlp 的进度后推回渲染层 */
interface MediaProgressEvent {
  sessionId: string
  kind: 'audio' | 'video'
  stage: 'downloading' | 'merging' | 'converting'
  streamIndex: number
  streamCount: number
  percent: number | null
  speed: string | null
  eta: string | null
}

/** 过 IPC 的段落形状：时间轴只存在于渲染层，主进程不存第二份（与 proofread:local 同一口径） */
interface VoiceSegment {
  id: string
  /** 秒，浮点 */
  startTime: number
  endTime: number
  text: string
}

/** 单次配音调用的可覆盖参数：只作用于这一次任务，不写回设置 */
interface VoiceCallOptions {
  voice?: string
  speed?: number
}

/** 与 index.d.ts 的 VoiceProgress 对齐：index/total 是真实段号，不做假百分比 */
interface VoiceProgressEvent {
  jobId: string
  stage: 'synthesizing' | 'skipped' | 'failed' | 'assembling' | 'done'
  index: number
  total: number
  segmentId?: string
  note?: string
}

const api = {
  getDroppedFilePath: (file: File) => webUtils.getPathForFile(file),
  selectFile: () => ipcRenderer.invoke('dialog:selectFile'),
  getFileMetadata: (filePath: string) => ipcRenderer.invoke('file:getMetadata', filePath),
  extractAudio: (filePath: string) => ipcRenderer.invoke('file:extractAudio', filePath),
  cleanupTemp: (tempDir: string) => ipcRenderer.invoke('file:cleanupTemp', tempDir),
  probeAudio: (filePath: string) => ipcRenderer.invoke('file:probeAudio', filePath),
  resolveMedia: (url: string) => ipcRenderer.invoke('file:resolveMedia', url),
  downloadMedia: (sessionId: string, kind: 'audio' | 'video', height?: number | null) =>
    ipcRenderer.invoke('file:downloadMedia', { sessionId, kind, height }),
  cancelMediaDownload: (sessionId: string) =>
    ipcRenderer.invoke('file:cancelMediaDownload', sessionId),
  releaseMediaSession: (sessionId: string) => ipcRenderer.invoke('file:releaseMediaSession', sessionId),
  saveMediaAs: (sessionId: string) => ipcRenderer.invoke('file:saveMediaAs', sessionId),
  // 下载要跑几分钟，invoke 只能给最后的结果；进度必须像转写那样推回来，界面才不会像卡死
  onMediaProgress: (callback: (data: MediaProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: MediaProgressEvent) => callback(data)
    ipcRenderer.on('file:mediaProgress', listener)
    return () => {
      ipcRenderer.removeListener('file:mediaProgress', listener)
    }
  },
  selectTextFile: () => ipcRenderer.invoke('dialog:selectTextFile'),
  readTextFile: (filePath: string) => ipcRenderer.invoke('file:readTextFile', filePath),
  saveTextFile: (suggestedName: string, content: string) =>
    ipcRenderer.invoke('file:saveText', { suggestedName, content }),

  startTranscription: (filePath: string, options: unknown) =>
    ipcRenderer.invoke('asr:start', filePath, options),
  cancelTranscription: (jobId: string) => ipcRenderer.invoke('asr:cancel', jobId),
  restartLocalEngine: () => ipcRenderer.invoke('asr:restartEngine'),

  onTranscriptionProgress: (
    callback: (data: {
      jobId: string
      progress: number
      segment?: unknown
      stage?: string
      model?: { tier: string; weightsMb: number | null }
    }) => void
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        jobId: string
        progress: number
        segment?: unknown
        stage?: string
        model?: { tier: string; weightsMb: number | null }
      }
    ) => callback(data)
    ipcRenderer.on('asr:progress', listener)
    return () => {
      ipcRenderer.removeListener('asr:progress', listener)
    }
  },

  correctText: (text: string, options: unknown) => ipcRenderer.invoke('ai:correct', text, options),
  explainDifferences: (differences: unknown[]) =>
    ipcRenderer.invoke('ai:explainDifferences', differences),
  analyzeReference: (referenceText: string) =>
    ipcRenderer.invoke('ai:analyzeReference', referenceText),

  proofreadLocal: (segments: unknown[]) => ipcRenderer.invoke('proofread:local', segments),
  proofreadExplain: (differences: unknown[]) =>
    ipcRenderer.invoke('proofread:explain', differences),

  // 配音：一次调用只合成一句，供批量之前试听；产物路径是本机文件，播放器直接吃 file://
  previewVoice: (text: string, options?: VoiceCallOptions) => ipcRenderer.invoke('tts:preview', text, options),
  releaseVoicePreview: () => ipcRenderer.invoke('tts:release'),
  synthesizeVoice: (segments: VoiceSegment[], options?: VoiceCallOptions) =>
    ipcRenderer.invoke('tts:synthesize', segments, options),
  cancelVoiceJob: (jobId: string) => ipcRenderer.invoke('tts:cancel', jobId),
  saveVoiceTrack: (jobId: string) => ipcRenderer.invoke('tts:saveTrack', jobId),
  releaseVoiceBatch: (jobId: string) => ipcRenderer.invoke('tts:releaseBatch', jobId),
  // 本地配音引擎：只读状态（不会因此拉起引擎）、应用内重启与停止
  getLocalVoiceStatus: (engine?: string) => ipcRenderer.invoke('tts:localStatus', engine),
  restartLocalVoiceEngine: () => ipcRenderer.invoke('tts:localRestart'),
  stopLocalVoiceEngine: () => ipcRenderer.invoke('tts:localStop'),
  // 一批要跑几分钟（每段一次网络请求，串行），invoke 只给最后结果；段号得推回来界面才不会像卡死
  onVoiceProgress: (callback: (data: VoiceProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: VoiceProgressEvent) => callback(data)
    ipcRenderer.on('tts:progress', listener)
    return () => {
      ipcRenderer.removeListener('tts:progress', listener)
    }
  },

  lookupWord: (word: string) => ipcRenderer.invoke('dictionary:lookup', word),
  lookupMultipleWords: (words: string[]) => ipcRenderer.invoke('dictionary:lookupMultiple', words),
  checkDictionaryUpdate: () => ipcRenderer.invoke('dictionary:checkUpdate'),
  downloadDictionaryUpdate: () => ipcRenderer.invoke('dictionary:downloadUpdate'),
  getDictionaryVersion: () => ipcRenderer.invoke('dictionary:getVersion'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  testConnection: (kind: 'asr' | 'ai' | 'tts', values: unknown) =>
    ipcRenderer.invoke('settings:testConnection', kind, values),

  getServiceReady: () => ipcRenderer.invoke('app:getServiceReady'),

  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkAppUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  getYtDlpLocal: () => ipcRenderer.invoke('ytDlp:getLocal'),
  checkYtDlpUpdate: () => ipcRenderer.invoke('ytDlp:check'),
  applyYtDlpUpdate: () => ipcRenderer.invoke('ytDlp:apply'),

  // 按需组件（本地配音引擎与模型）：不联网的那份先回，清单要用户点「检查」才读
  listComponents: () => ipcRenderer.invoke('component:list'),
  checkComponents: () => ipcRenderer.invoke('component:check'),
  installComponent: (id: string) => ipcRenderer.invoke('component:install', id),
  cancelComponentInstall: (id: string) => ipcRenderer.invoke('component:cancel', id),
  removeComponent: (id: string) => ipcRenderer.invoke('component:remove', id),
  getComponentBusy: () => ipcRenderer.invoke('component:busy'),
  // 下载/解压进度是事件推回来的（129MB 的模型在慢网里要跑几分钟），不包一层界面就只剩一个转圈
  onComponentProgress: (
    callback: (data: { id: string; phase: 'download' | 'extract' | 'verify'; done: number; total: number }) => void
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; phase: 'download' | 'extract' | 'verify'; done: number; total: number }
    ) => callback(data)
    ipcRenderer.on('component:progress', listener)
    return () => {
      ipcRenderer.removeListener('component:progress', listener)
    }
  },
  // 下载进度是事件推回来的（37MB 在慢网里要跑几分钟），不包一层渲染层就看不见它在动
  onYtDlpProgress: (callback: (data: { received: number; total: number }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { received: number; total: number }
    ) => callback(data)
    ipcRenderer.on('ytDlp:progress', listener)
    return () => {
      ipcRenderer.removeListener('ytDlp:progress', listener)
    }
  },
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  openSystemSettings: () => ipcRenderer.invoke('app:openSystemSettings'),
  contactDeveloper: () => ipcRenderer.invoke('app:contactDeveloper'),

  openLogDirectory: () => ipcRenderer.invoke('app:openLogDirectory'),

  toggleWindowMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),

  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),

  closeWindow: () => ipcRenderer.invoke('window:close'),

  log: (entry: unknown) => ipcRenderer.invoke('app:log', entry),
}

contextBridge.exposeInMainWorld('electronAPI', api)
