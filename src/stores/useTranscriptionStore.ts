/**
 * 转写状态管理（Zustand）
 * 管理文件信息、转写进度、段落数据、错误状态等全局状态
 * 提供段落增删改、进度监听订阅/取消、整体重置等操作方法
 */
import { create } from 'zustand'
import type { TranscriptionSegment, TranscriptionStatus } from '@/types/transcription'

interface TranscriptionState {
  filePath: string | null
  fileName: string | null
  fileSize: number | null
  duration: number | null
  status: TranscriptionStatus
  progress: number
  /** 引擎上报的阶段，如本地首次转写的 loading_model；无阶段事件时为 null */
  stage: string | null
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
    set({ filePath, fileName, fileSize, duration, status: 'idle', progress: 0, stage: null, error: null }),

  setStatus: (status) => set({ status }),

  setProgress: (progress) => set({ progress }),

  setStage: (stage) => set({ stage }),

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
