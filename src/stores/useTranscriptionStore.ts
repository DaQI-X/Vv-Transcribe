/**
 * 转写状态管理（Zustand）
 * 管理文件信息、转写进度、段落数据、错误状态等全局状态
 * 提供段落增删改、进度监听订阅/取消、整体重置等操作方法
 */
import { create } from 'zustand'
import type { TranscriptionSegment, TranscriptionStatus } from '@/types/transcription'

/**
 * 引擎随状态事件上报的模型信息，形状与 electron/preload/index.d.ts 那处一致（跨 IPC 的手抄一份）。
 * - download 是宿主自己取件那一段（#435）的实测字节——只传字节，单位留给渲染层唯一的 formatBytes。
 * - source 是引擎自报的出处（#436）：'directory' ＝吃「按需组件」装好的那份、这一步不联网。
 */
export interface TranscriptionModelInfo {
  tier: string
  weightsMb: number | null
  source?: 'directory' | 'repo'
  download?: { done: number; total: number }
}

interface TranscriptionState {
  filePath: string | null
  fileName: string | null
  fileSize: number | null
  duration: number | null
  status: TranscriptionStatus
  progress: number
  /** 引擎阶段性状态：首转取件 downloading_model、装载 loading_model、排队 waiting_order；无阶段事件时为 null */
  stage: string | null
  /** 引擎自报的档位与权重体积，首次转写的「要下载多大」这句提示靠它 */
  modelInfo: TranscriptionModelInfo | null
  segments: TranscriptionSegment[]
  error: string | null
  jobId: string | null
  asrProvider: 'local' | 'cloud' | null
  /** 这次转写用的 Whisper 语言码；校对分支要靠它判断中文规则是否成立 */
  asrLanguage: string
  unsubscribeProgress: (() => void) | null

  setFile: (info: {
    filePath: string
    fileName: string
    fileSize: number
    duration: number
  }) => void
  setStatus: (status: TranscriptionStatus) => void
  setProgress: (progress: number) => void
  setStage: (stage: string | null) => void
  setModelInfo: (modelInfo: TranscriptionModelInfo | null) => void
  setJobId: (jobId: string | null) => void
  setAsrProvider: (provider: 'local' | 'cloud') => void
  setAsrLanguage: (language: string) => void
  addSegment: (segment: TranscriptionSegment) => void
  setSegments: (segments: TranscriptionSegment[]) => void
  updateSegment: (id: string, text: string) => void
  setError: (error: string | null) => void
  setUnsubscribeProgress: (fn: (() => void) | null) => void
  reset: () => void
}

const initialState = {
  filePath: null,
  fileName: null,
  fileSize: null,
  duration: null,
  status: 'idle' as TranscriptionStatus,
  progress: 0,
  stage: null as string | null,
  modelInfo: null as TranscriptionModelInfo | null,
  segments: [] as TranscriptionSegment[],
  error: null,
  jobId: null,
  asrProvider: null as 'local' | 'cloud' | null,
  asrLanguage: 'zh',
  unsubscribeProgress: null as (() => void) | null,
}

export const useTranscriptionStore = create<TranscriptionState>((set) => ({
  ...initialState,

  setFile: ({ filePath, fileName, fileSize, duration }) =>
    set({
      filePath,
      fileName,
      fileSize,
      duration,
      status: 'idle',
      progress: 0,
      stage: null,
      modelInfo: null,
      error: null,
    }),

  setStatus: (status) => set({ status }),

  setProgress: (progress) => set({ progress }),

  setStage: (stage) => set({ stage }),

  setModelInfo: (modelInfo) => set({ modelInfo }),

  setJobId: (jobId) => set({ jobId }),

  setAsrProvider: (provider) => set({ asrProvider: provider }),

  setAsrLanguage: (language) => set({ asrLanguage: language }),

  addSegment: (segment) =>
    set((state) => ({ segments: [...state.segments, segment] })),

  setSegments: (segments) => set({ segments }),

  updateSegment: (id, text) =>
    set((state) => ({
      segments: state.segments.map((seg) =>
        seg.id === id ? { ...seg, text, isEdited: true } : seg,
      ),
    })),

  setError: (error) => set({ error, status: error ? 'error' : 'idle' }),

  setUnsubscribeProgress: (fn) => set({ unsubscribeProgress: fn }),

  reset: () => {
    const state = useTranscriptionStore.getState()
    state.unsubscribeProgress?.()
    set(initialState)
  },
}))
