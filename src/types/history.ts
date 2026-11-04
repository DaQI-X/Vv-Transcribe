/**
 * 历史记录（#247）的前端数据结构。
 * 一律与 electron/preload/index.d.ts 的同名类型对齐：跨 IPC 的边界只有那一份声明，
 * 组件里再各写一份会各自漂移。
 */

export type HistoryKind = 'transcribe' | 'download' | 'voice'

/** 这次作业各自用了哪条方案；null＝那一档当时没有「当前使用」，下载链路三个都是 null */
export interface HistoryProfiles {
  asr: string | null
  ai: string | null
  tts: string | null
}

export interface TranscribeDetail {
  kind: 'transcribe'
  provider: string
  model: string
  language: string
  segments: number
  durationSec: number | null
  elapsedMs: number | null
}

export interface DownloadDetail {
  kind: 'download'
  mediaKind: string
  durationSec: number | null
  height: number | null
  sizeBytes: number
}

export interface VoiceDetail {
  kind: 'voice'
  engine: string
  model: string
  voice: string
  speed: number
  clips: number
  queueTotal: number
  trackBytes: number
  trackDuration: number
  pushedCount: number
}

export type HistoryDetail = TranscribeDetail | DownloadDetail | VoiceDetail

/**
 * 一行的样子。产物在主进程盘上的位置不出边界，这里只有「有没有」和「还在不在」，
 * 所以界面点得动的那一颗是「留住 / 在文件夹里显示」，永远不是「打开这个文件」。
 */
export interface HistoryItem {
  id: string
  /** 完成那一刻的 ISO 时间 */
  at: string
  name: string
  kind: HistoryKind
  profiles: HistoryProfiles
  detail: HistoryDetail
  keptProduct: boolean
  keptDraft: boolean
  /** 原件此刻还在不在盘上——24 小时清扫跑过之后是 false，那一勾也就点不动了 */
  productAvailable: boolean
  /**
   * 这一条留住的份占多少字节（没勾留住的恒为 0）。留住的行不参与自动修剪，所以这一栏必须
   * 自己把「一共占了多大」说出来——不说就等于让用户等盘满那天才发现。
   */
  keptBytes: number
}

/** `items: null` 是「这本账读不出来」，`[]` 是「读过了，确实一条都没有」——界面必须分这两句说 */
export interface HistoryListResult {
  items: HistoryItem[] | null
  error: string | null
}

export interface HistoryResult {
  ok: boolean
  error?: string
}
