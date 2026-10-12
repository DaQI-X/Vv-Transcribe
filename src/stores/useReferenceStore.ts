/**
 * 参考稿比对状态管理（Zustand）
 * 管理参考稿文本、对齐结果、段落 diff、AI 解释等状态
 */
import { create } from 'zustand'
import type {
  SegmentDiff,
  ReferenceSpan,
  ReferenceComparisonStatus,
} from '@/types/reference'

interface ReferenceState {
  referenceText: string | null
  referenceFileName: string | null

  alignment: ReferenceSpan[]
  segmentDiffs: Map<string, SegmentDiff>

  status: ReferenceComparisonStatus
  error: string | null

  expandedSegments: Set<string>
  showAllDiffs: boolean

  setReference: (text: string, fileName: string) => void
  clearReference: () => void
  setAlignment: (alignment: ReferenceSpan[]) => void
  setSegmentDiff: (segmentId: string, diff: SegmentDiff) => void
  setAllSegmentDiffs: (diffs: Map<string, SegmentDiff>) => void
  setStatus: (status: ReferenceComparisonStatus) => void
  setError: (error: string | null) => void
  toggleSegmentExpanded: (segmentId: string) => void
  setShowAllDiffs: (show: boolean) => void
  reset: () => void
}

const initialState = {
  referenceText: null as string | null,
  referenceFileName: null as string | null,
  alignment: [] as ReferenceSpan[],
  segmentDiffs: new Map<string, SegmentDiff>(),
  status: 'idle' as ReferenceComparisonStatus,
  error: null as string | null,
  expandedSegments: new Set<string>(),
  showAllDiffs: false,
}

export const useReferenceStore = create<ReferenceState>((set) => ({
  ...initialState,

  setReference: (text, fileName) =>
    set({ referenceText: text, referenceFileName: fileName }),

  clearReference: () =>
    set({
      referenceText: null,
      referenceFileName: null,
      alignment: [],
      segmentDiffs: new Map(),
      status: 'idle',
      error: null,
      expandedSegments: new Set(),
      showAllDiffs: false,
    }),

  setAlignment: (alignment) => set({ alignment }),

  setSegmentDiff: (segmentId, diff) =>
    set((state) => {
      const next = new Map(state.segmentDiffs)
      next.set(segmentId, diff)
      return { segmentDiffs: next }
    }),

  setAllSegmentDiffs: (diffs) => set({ segmentDiffs: diffs }),

  setStatus: (status) => set({ status }),

  setError: (error) => set({ error, status: error ? 'error' : 'idle' }),

  toggleSegmentExpanded: (segmentId) =>
    set((state) => {
      const next = new Set(state.expandedSegments)
      if (next.has(segmentId)) {
        next.delete(segmentId)
      } else {
        next.add(segmentId)
      }
      return { expandedSegments: next }
    }),

  setShowAllDiffs: (show) => set({ showAllDiffs: show }),

  reset: () => set(initialState),
}))
