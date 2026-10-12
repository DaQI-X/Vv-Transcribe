/**
 * 段落级 diff 计算
 * 对单个段落的转写文本与参考稿片段做字级对比
 */
import { diffChars } from 'diff'
import type { DiffChunk, SegmentDiff } from '@/types/reference'

/** 计算单个段落的 diff */
export function computeSegmentDiff(
  segmentText: string,
  referenceSlice: string,
  segmentId: string,
): SegmentDiff {
  if (!referenceSlice) {
    return {
      segmentId,
      chunks: [{ type: 'equal', value: segmentText }],
      explanations: [null],
      referenceIssues: [],
      hasDifference: false,
      totalChanges: 0,
    }
  }

  const diffs = diffChars(segmentText, referenceSlice)
  const chunks: DiffChunk[] = []
  let totalChanges = 0

  for (const part of diffs) {
    if (part.added) {
      chunks.push({ type: 'insert', value: part.value })
      totalChanges++
    } else if (part.removed) {
      chunks.push({ type: 'delete', value: part.value })
      totalChanges++
    } else {
      chunks.push({ type: 'equal', value: part.value })
    }
  }

  return {
    segmentId,
    chunks,
    explanations: new Array(chunks.length).fill(null),
    referenceIssues: [],
    hasDifference: totalChanges > 0,
    totalChanges,
  }
}
