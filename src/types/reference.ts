/**
 * 参考稿比对类型定义
 * 用于播出稿与转写结果的差异对比、标注和 AI 解释
 */

/** 字级 diff 片段 */
export interface DiffChunk {
  type: 'equal' | 'insert' | 'delete'
  value: string
}

/** 单个 diff 片段的 AI 解释 */
export interface DiffExplanation {
  explanation: string
  dictionaryHint?: string
}

/** 参考稿本身的问题（AI 分析得出） */
export interface ReferenceIssue {
  text: string
  suggestion?: string
  explanation: string
  dictionaryHint?: string
}

/** 单段落的比对结果 */
export interface SegmentDiff {
  segmentId: string
  chunks: DiffChunk[]
  explanations: (DiffExplanation | null)[]
  referenceIssues: ReferenceIssue[]
  hasDifference: boolean
  totalChanges: number
}

/** 段落在参考稿中的映射区间 */
export interface ReferenceSpan {
  segmentId: string
  referenceStart: number
  referenceEnd: number
}

export type ReferenceComparisonStatus =
  | 'idle'
  | 'aligning'
  | 'comparing'
  | 'explaining'
  | 'completed'
  | 'error'
