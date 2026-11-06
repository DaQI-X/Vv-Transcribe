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
  /** 「这次用哪套配音配置」；空/不传＝该档当前默认方案 */
  profileId?: string
  /** 历史记录里这一行叫什么（#247）。纯展示，主进程收到的只有正文，起不出这份稿子从哪来 */
  sourceName?: string
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

/** 与 index.d.ts 的 ProfileCreatePayload 对齐：新建方案只收一个对象，不再走三个位置参数 */
interface ProfileCreatePayload {
  /** 界面上不再起名时可以不传；主进程按「给的名 → 模型名 → 方案 N」兜底 */
  name?: string
  /** 省略＝照该档当前那条复制；给 id＝照那条；空串＝一条全空白（连 Key 都不带） */
  fromProfileId?: string
  /** 界面此刻表单上的凭据，键名用界面上那套扁平名（asrApiBase / asrModel / asrApiKey…） */
  values?: Record<string, string>
  /** 建完就设为当前使用；该档原本一条都没有时不用给，第一条自动是它 */
  setDefault?: boolean
}

const api = {
  /**
   * 平台标识直接带过来，不走 IPC：创建窗口时 `titleBarStyle: 'hiddenInset'` 看的也是这一个值
   * （`electron/main/index.ts`），界面要避让的红绿灯在不在场，得和那个决定同源。
   * 渲染层自己嗅 `navigator.userAgent` 也能猜，但猜错了没人报错——同一类误判在开屏页上已经
   * 赔过一次（那条改成主进程判定，见 README「开屏动画」）。
   */
  platform: process.platform,
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
  // 三条 AI 通道都多接一个可选的方案 id（#222 第②步）：空/不传＝用该档当前默认方案，
  // 所以现在的调用点一个字都不用改
  explainDifferences: (differences: unknown[], profileId?: string) =>
    ipcRenderer.invoke('ai:explainDifferences', differences, profileId),
  analyzeReference: (referenceText: string, profileId?: string) =>
    ipcRenderer.invoke('ai:analyzeReference', referenceText, profileId),

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
  // profileId 是「问哪一套配音配置里的引擎」，不传就是问当前默认那套
  getLocalVoiceStatus: (engine?: string, profileId?: string) =>
    ipcRenderer.invoke('tts:localStatus', engine, profileId),
  restartLocalVoiceEngine: () => ipcRenderer.invoke('tts:localRestart'),
  stopLocalVoiceEngine: () => ipcRenderer.invoke('tts:localStop'),
  // 音色名单（1.1.2 #340）：只有云端档里那家有列表接口的厂商会给候选，取不到就照旧手输，
  // 所以这一条从不影响配音本身。profileId 与其余通道同义：不传＝当前默认那套
  listVoices: (profileId?: string) => ipcRenderer.invoke('tts:voiceList', profileId),
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
  // 第三个参数是「这一次自检用的是哪一套方案」，只带被测那一档的 id：
  // 配音留空地址时会回落到「校对那套」，而那条回落真干活时走的是校对的**默认**方案
  // （getTTSConfig 只挑 tts 一条），一个 id 不该同时指到两档。
  testConnection: (kind: 'asr' | 'ai' | 'tts', values: unknown, profileId?: string) =>
    ipcRenderer.invoke('settings:testConnection', kind, values, profileId),

  // 多套配置（#222）：三档各自的方案列表，增删改各一条。
  // createProfile 收一个对象：凭据以界面此刻的输入为准，`fromProfileId` 才是「照哪一条复制」
  // （空串＝一条全空白，省略＝照该档当前那条）。以前这里是三个位置参数，改名不改成对象
  // 就会出现「名字被静默吞掉、复制源当成名字」这种不报错的错法。
  listProfiles: () => ipcRenderer.invoke('settings:listProfiles'),
  createProfile: (capability: 'asr' | 'ai' | 'tts', input?: ProfileCreatePayload) =>
    ipcRenderer.invoke('settings:createProfile', capability, input),
  renameProfile: (capability: 'asr' | 'ai' | 'tts', profileId: string, name: string) =>
    ipcRenderer.invoke('settings:renameProfile', capability, profileId, name),
  deleteProfile: (capability: 'asr' | 'ai' | 'tts', profileId: string) =>
    ipcRenderer.invoke('settings:deleteProfile', capability, profileId),
  setDefaultProfile: (capability: 'asr' | 'ai' | 'tts', profileId: string) =>
    ipcRenderer.invoke('settings:setDefaultProfile', capability, profileId),

  // 历史记录（#247）：界面向记录只拿 id，产物的路径一刻都不出主进程。
  // keepHistory 的第二个参数是这一刻渲染层手上那份稿子正文——记账时它没在盘上待过，
  // 只有用户点了「留住」才过桥一次，这也是「全文按需」这句承诺的范围。
  listHistory: () => ipcRenderer.invoke('history:list'),
  keepHistory: (id: string, draftText?: string) => ipcRenderer.invoke('history:keep', id, draftText),
  dropHistoryCopies: (id: string) => ipcRenderer.invoke('history:dropCopies', id),
  deleteHistoryRecord: (id: string) => ipcRenderer.invoke('history:delete', id),
  revealHistoryFile: (id: string) => ipcRenderer.invoke('history:reveal', id),

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

  // 主进程崩溃兜底推来的一句话（渲染进程还活着才走这条；界面没了它只能弹系统对话框）。
  // 通道名与 electron/main/services/crashWatch.ts 的 ERROR_NOTICE_CHANNEL 是同一串：
  // 这里不 import 那个模块，否则会把它依赖的 app/dialog 一起打进 preload。
  onErrorNotice: (callback: (message: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message)
    ipcRenderer.on('app:errorNotice', listener)
    return () => {
      ipcRenderer.removeListener('app:errorNotice', listener)
    }
  },

  openLogDirectory: () => ipcRenderer.invoke('app:openLogDirectory'),
  openUserDataDirectory: () => ipcRenderer.invoke('app:openUserDataDirectory'),

  toggleWindowMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),

  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),

  closeWindow: () => ipcRenderer.invoke('window:close'),

  log: (entry: unknown) => ipcRenderer.invoke('app:log', entry),
}

contextBridge.exposeInMainWorld('electronAPI', api)
