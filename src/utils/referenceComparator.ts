/**
 * 参考稿比对编排器
 * 串联对齐 → diff 计算 → 返回所有段落的比对结果
 */
import type { TranscriptionSegment } from '@/types/transcription'
import type { SegmentDiff } from '@/types/reference'
import { alignReferenceToSegments } from './textAlignment'
import { computeSegmentDiff } from './segmentDiff'

/** 执行完整的参考稿比对流程 */
export function compareWithReference(
  segments: TranscriptionSegment[],
  referenceText: string,
): Map<string, SegmentDiff> {
  const alignment = alignReferenceToSegments(segments, referenceText)
  const results = new Map<string, SegmentDiff>()

  for (const span of alignment) {
    const segment = segments.find((s) => s.id === span.segmentId)
    if (!segment) continue

    const refSlice =
      span.referenceStart >= 0 && span.referenceEnd > span.referenceStart
        ? referenceText.slice(span.referenceStart, span.referenceEnd)
        : ''

    const diff = computeSegmentDiff(segment.text, refSlice, segment.id)
    results.set(segment.id, diff)
  }

  return results
}
