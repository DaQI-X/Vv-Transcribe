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

/** 一档可下载的清晰度。height=null 表示「站点给到的最高清晰度」 */
export interface MediaQualityOption {
  height: number | null
  label: string
  /** 站点自报的估算体积；取不到是 null，界面要显示「大小未知」而不是编一个数 */
  approxBytes: number | null
  /** 1=站点给带音轨的整片；2=视频轨与音频轨分开下再合并（进度会走两遍） */
  streams: number
}

export interface MediaInfo {
  title: string
  durationSeconds: number | null
  uploader: string | null
  isLive: boolean
  audioApproxBytes: number | null
  /** 空数组＝这条链接只有音频，没有可下载的画面 */
  videoOptions: MediaQualityOption[]
}

export interface ResolveMediaResult {
  success: boolean
  /** 后续下载/另存为/释放都要带上它：会话独占一个临时目录 */
  sessionId?: string
  info?: MediaInfo
  error?: string
  systemSettingsHint?: boolean
}

export interface MediaDownloadResult {
  success: boolean
  filePath?: string
  fileSizeBytes?: number
  canceled?: boolean
  error?: string
  systemSettingsHint?: boolean
}

export interface MediaProgress {
  sessionId: string
  kind: 'audio' | 'video'
  stage: 'downloading' | 'merging' | 'converting'
  streamIndex: number
  streamCount: number
  percent: number | null
  /** yt-dlp 原样吐出的字符串（"1.23MiB/s" / "00:09"），不做二次换算 */
  speed: string | null
  eta: string | null
}

/** 转写段落：本地逐段推流时挂在进度事件上，云端整份返回时挂在 asr:start 的返回值上 */
export interface TranscribedSegment {
  startTime: number
  endTime: number
  text: string
  confidence?: number
}

export interface VoiceSegment {
  /** 段落 id，主进程只用来回指失败清单，不透明 */
  id: string
  /** 秒，浮点（与 src/types/transcription.ts 同一单位） */
  startTime: number
  endTime: number
  text: string
}

/** 单次调用的可覆盖参数：配音页选音色/倍速时用，只作用于这一次任务，不写回 settings.json */
export interface VoiceCallOptions {
  /** 空串＝不覆盖，按「设置 → 配音配置」里那个音色走 */
  voice?: string
  /** OpenAI 标准 speed 的取值范围 0.25–4.0；不填按 1，主进程会夹边界 */
  speed?: number
}

export interface VoiceProgress {
  jobId: string
  stage: 'synthesizing' | 'skipped' | 'failed' | 'assembling' | 'done'
  /** 1 起算的真实段号；0＝已发起、第一段还在接口那边（让界面早点拿到 jobId 好放「取消」）；assembling/done 时等于总数 */
  index: number
  total: number
  segmentId?: string
  /** 失败原因，或「空段落，未调用接口」 */
  note?: string
}

export interface VoiceTrack {
  filePath: string
  bytes: number
  /** 配音轨总时长（ffprobe 实测，秒） */
  duration: number
  /** 因为「配音比字幕槽位长」被往后推的段数——整条可能比原片长，必须如实报 */
  pushedCount: number
  /** 接口时长没读出来、只能按字幕槽位估算的段数 */
  estimatedCount: number
  /** 原时间轴最后一段的结束点，用来跟 duration 对照 */
  originalEnd: number
}

/**
 * 本地配音引擎的状态快照。查状态本身不会把引擎拉起来（本地档是懒启动的），
 * 所以打开设置页不会凭空吃掉一次解包和几百 MB 内存。
 * mode/configuredEngine 来自已保存的设置；requestedEngine 是界面当前问的那个，
 * 设置表单里刚换、还没点保存时两者会不一样——组件在不在场按 requestedEngine 判。
 */
export interface LocalTtsStatus {
  ready: boolean
  /** 未就绪时可直接展示给用户的原因（人话，含「该下载组件」和「端口被占」这两类） */
  error: string | null
  /** 按需组件在场情况：配音页的首次下载引导按这两位决定文案 */
  binaryPresent: boolean
  modelPresent: boolean
  /** 端口上那个进程绑定的引擎；没起来时是 null */
  engine: string | null
  /** 真的加载进内存的引擎；模型是惰性的，这一位为 null 不代表用不了 */
  engineLoaded: string | null
  /** 音色上限：本地音色下拉按它决定 sid 能选到几；模型没加载时是 0 */
  speakers: number
  sampleRate: number
  port: number
  mode: 'cloud' | 'local'
  configuredEngine: string
  requestedEngine: string
}

/**
 * 按需组件（本地配音引擎二进制、配音模型）在磁盘与清单两边的状态。
 * 「没检查过清单」和「清单里没有本机这一条」是两回事，所以远端那三位都可以是 null。
 */
export interface ComponentState {
  id: string
  title: string
  /** binary=一个可执行文件，archive=解压成一个目录 */
  kind: 'binary' | 'archive'
  /** 这一项是干什么用的，界面直接印出来 */
  hint: string
  installed: boolean
  /** 磁盘实际占用（目录已展开求和），没装是 0 */
  bytes: number
  /** installed.json 记的版本；手工放进组件目录的那份没有记录，为 null */
  localVersion: string | null
  remoteVersion: string | null
  /** 清单声明的下载体积（压缩包本身）；还没查清单时为 null */
  remoteBytes: number | null
  /** install=没装，update=版本不同，repair=装了但没版本记录，none=与清单一致 */
  action: 'install' | 'update' | 'repair' | 'none'
  inManifest: boolean | null
}

/** download=拉字节，extract=解包（archive 才有），verify=比对指纹 */
export type ComponentPhase = 'download' | 'extract' | 'verify'

export interface ComponentProgress {
  id: string
  phase: ComponentPhase
  done: number
  /** 这一阶段的分母；未知时为 0，界面按「不显示百分比」处理，不给假百分比 */
  total: number
}

export interface ComponentResult {
  ok: boolean
  error: string | null
  state?: ComponentState
  /** 失败特征像「系统拦住了写入/执行」，界面据此给「打开隐私设置」按钮 */
  systemSettingsHint?: boolean
}

export interface ComponentCheckResult {
  ok: boolean
  error: string | null
  components: ComponentState[]
}

export interface TTSSynthesizeResult {
  /** 取消与释放都按这个 id 找主进程自己的记录；一段都没成时为 null */
  jobId: string | null
  track: VoiceTrack | null
  clipCount: number
  failures: Array<{ segmentId: string; index: number; error: string }>
  /** 空段落 id：没调接口、没花钱 */
  skipped: string[]
  canceled: boolean
  /** 连续失败熔断的原因；跟「用户自己点了取消」分开报 */
  abortedReason: string | null
  error: string | null
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
  /** 配音用：音频接口除了模型还要音色 id，两项都是必填 */
  voice?: string
}

export interface ElectronAPI {
  getDroppedFilePath: (file: File) => string
  selectFile: () => Promise<string | null>
  getFileMetadata: (filePath: string) => Promise<FileMetadata | null>
  extractAudio: (filePath: string) => Promise<ExtractAudioResult>
  cleanupTemp: (tempDir: string) => Promise<void>
  probeAudio: (filePath: string) => Promise<ProbeAudioResult>
  /** 解析链接：只拿标题/时长/清晰度，不落媒体。成功后返回 sessionId，后续步骤都靠它 */
  resolveMedia: (url: string) => Promise<ResolveMediaResult>
  /** 拿解析好的会话去下载。audio 的产物直接进转写；video 下完再走 saveMediaAs */
  downloadMedia: (
    sessionId: string,
    kind: 'audio' | 'video',
    height?: number | null
  ) => Promise<MediaDownloadResult>
  cancelMediaDownload: (sessionId: string) => Promise<{ success: boolean }>
  /** 临时目录归会话管：不释放就等于把 cookies 和几十 MB 媒体留在 /tmp 里 */
  releaseMediaSession: (sessionId: string) => Promise<{ success: boolean }>
  saveMediaAs: (
    sessionId: string
  ) => Promise<{ success: boolean; savedPath?: string; canceled?: boolean; error?: string }>
  /** 订阅下载进度，返回取消订阅的函数（与 onTranscriptionProgress 同一写法） */
  onMediaProgress: (callback: (data: MediaProgress) => void) => () => void
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
    /** 云端不逐段推流，整份结果只在这里；本地已经流式填好时界面不再覆盖 */
    segments?: TranscribedSegment[]
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
      segment?: TranscribedSegment
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

  /**
   * 配音试听：合成一句，回本机文件路径 + 字节数 + 时长（秒）。
   * 时长的来源按档不同：云端档是 ffprobe 的容器估算（mp3 偏大，只够给「这句有多长」用），
   * 本地档是引擎自己数的采样数（准确）。
   * duration 为 0 是「时长没读出来」，不是「这条音频是空的」——产物本身已经落盘成功。
   * 失败一律走 error（人话原因），主进程不跨 IPC 抛。
   */
  previewVoice: (text: string, options?: VoiceCallOptions) => Promise<{
    clip: { filePath: string; bytes: number; duration: number } | null
    error: string | null
  }>
  /** 离开配音工作台时回收试听临时目录；漏调也会被启动清扫兜住 */
  releaseVoicePreview: () => Promise<{ ok: boolean }>

  /**
   * 整批配音：逐段合成后由 ffmpeg 铺成一条对齐时间轴的音轨。
   * 分钟级耗时，段号走 onVoiceProgress 推回来，invoke 只给最后结果。
   * 串行调用、每段一次请求，花的是用户 Key 的钱，所以调用点必须先在界面上确认段数。
   */
  synthesizeVoice: (segments: VoiceSegment[], options?: VoiceCallOptions) => Promise<TTSSynthesizeResult>
  /** 取消：正在飞出去的那次请求不打断，从下一段起不再调用；已成功的片段照常拼 */
  cancelVoiceJob: (jobId: string) => Promise<{ success: boolean }>
  /** 成品另存为用户选的位置（走系统保存框，主进程写盘） */
  saveVoiceTrack: (jobId: string) => Promise<{
    success: boolean
    canceled: boolean
    name?: string
    error: string | null
  }>
  /** 没另存就清空这批时回收整批中间产物（另存成功后同样回收） */
  releaseVoiceBatch: (jobId: string) => Promise<{ ok: boolean }>
  onVoiceProgress: (callback: (data: VoiceProgress) => void) => () => void

  /** 本地配音引擎状态快照（只读，不拉起引擎）；engine 传界面当前选中的那个引擎 id */
  getLocalVoiceStatus: (engine?: string) => Promise<LocalTtsStatus>
  /**
   * 应用内重启本地配音引擎。引擎只取已保存的设置——设置页「点保存才生效」这条口径不在这儿破例。
   * 首次启动要解包，最长可能等两分钟。
   */
  restartLocalVoiceEngine: () => Promise<{ ok: boolean; error: string | null }>
  /**
   * 停掉后台的本地配音引擎。组件下载/删除前必须先停——那几个文件正被进程占着。
   * 有一批配音正在逐段合成时主进程会拒绝，因为这里停了剩下的段落会全失败。
   */
  stopLocalVoiceEngine: () => Promise<{ ok: boolean; stopped: boolean; error: string | null }>

  /**
   * 按需组件：只读磁盘在场情况与占用体积，不联网。打开「关于与更新」先吃这一份，
   * 要不要下载由用户点「检查」触发——直连 GitHub 时清单可能要十几秒。
   */
  listComponents: () => Promise<ComponentState[]>
  checkComponents: () => Promise<ComponentCheckResult>
  installComponent: (id: string) => Promise<ComponentResult>
  cancelComponentInstall: (id: string) => Promise<{ ok: boolean; error: string | null }>
  removeComponent: (id: string) => Promise<ComponentResult>
  /** 这几个文件现在能不能动；两种占用分开报，界面给的不一样 */
  getComponentBusy: () => Promise<{ engineRunning: boolean; synthesizing: boolean }>
  onComponentProgress: (callback: (data: ComponentProgress) => void) => () => void

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
   * 脱敏视图：三把 API Key 不回明文（值根本不过 IPC），只给状态。
   * 字段是 asrKeyStatus / aiKeyStatus / ttsKeyStatus（none / encrypted / plaintext / unreadable）
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
  testConnection: (
    kind: 'asr' | 'ai' | 'tts',
    values: ConnectionTestValues
  ) => Promise<TestOutcome>

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
