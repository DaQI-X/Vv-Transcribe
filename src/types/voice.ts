/**
 * 配音（TTS）的前端数据结构
 * 一律与 electron/preload/index.d.ts 的同名类型对齐：跨 IPC 的边界只有这一份声明，
 * 组件里再各写一份会各自漂移（原先弹窗就是这么干的）。
 */

/** 过 IPC 的段落形状：时间轴只存在于渲染层，主进程不存第二份 */
export interface VoiceSegment {
  /** 段落 id，主进程只用来回指失败清单，不透明 */
  id: string
  /** 秒，浮点。纯文本朗读没有字幕时间轴，两边都给 0＝按顺序首尾相接 */
  startTime: number
  endTime: number
  text: string
}

/** 进度推送：index/total 是真实段号，不做假百分比 */
export interface VoiceProgress {
  jobId: string
  stage: 'synthesizing' | 'skipped' | 'failed' | 'assembling' | 'done'
  /** 1 起算的真实段号；0＝已发起、第一段还在接口那边；assembling/done 时等于总数 */
  index: number
  total: number
  segmentId?: string
  /** 失败原因，或「空段落，未调用接口」 */
  note?: string
}

/** 拼好的整条配音轨 */
export interface VoiceTrack {
  filePath: string
  bytes: number
  /** 配音轨总时长（ffprobe 实测，秒） */
  duration: number
  /** 因为「配音比字幕槽位长」被往后推的段数——整条可能比原片长，必须如实报 */
  pushedCount: number
  /** 接口时长没读出来、只能按字幕槽位估算的段数 */
  estimatedCount: number
  /** 原时间轴最后一段的结束点；纯文本朗读没有时间轴，这个值是 0，界面别拿它说话 */
  originalEnd: number
}

/** 整批跑完的返回值：track 为 null 时（一段都没成/被取消在拼接前）只有失败清单可看 */
export interface VoiceSynthesizeResult {
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
