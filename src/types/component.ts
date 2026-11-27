/**
 * 按需组件（本地配音引擎与模型）的前端数据结构
 * 与 electron/preload/index.d.ts 的同名类型对齐：跨 IPC 的边界只有这一份声明，
 * 组件里各写一份会各自漂移。
 */

/** binary=一个可执行文件，archive=解压成一个目录 */
export type ComponentKind = 'binary' | 'archive'

/** tts=本地字幕配音用的引擎/模型，asr=本地转写用的 Whisper 权重（面板按这一位分组） */
export type ComponentPurpose = 'tts' | 'asr'

export interface ComponentState {
  id: string
  /** 名字与说明都由主进程的白名单给，界面不自己拼 */
  title: string
  kind: ComponentKind
  purpose: ComponentPurpose
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
  /** 清单有没有本机这一条；还没检查过清单时为 null */
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
  /** 逐文件取上游那条才给（如「第 3/17 个文件」），单件下载时为空 */
  step?: string
}

export interface ComponentResult {
  ok: boolean
  error: string | null
  state?: ComponentState
  /** 失败特征像「系统拦住了写入/执行」，界面据此给「打开隐私设置」按钮 */
  systemSettingsHint?: boolean
  /** 用户自己按的「取消下载」，不是故障：界面据此走中性提示 */
  canceled?: boolean
  /** 这一行的货其实住在组件目录之外（那一棵树），调用方自己决定要不要接着清 */
  outsideOnly?: boolean
}

export interface ComponentCheckResult {
  ok: boolean
  error: string | null
  components: ComponentState[]
}
