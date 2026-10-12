/**
 * 文本对齐引擎
 * 将参考稿纯文本与带时间戳的转写段落进行字符级对齐
 * 使用 diff 库的 Myers 算法，O(n*d) 复杂度
 */
import { diffChars } from 'diff'
import type { TranscriptionSegment } from '@/types/transcription'
import type { ReferenceSpan } from '@/types/reference'

/** 去除空白和标点，保留原始索引映射 */
function normalize(text: string): { normalized: string; indexMap: number[] } {
  let normalized = ''
  const indexMap: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/\s/.test(ch)) continue
    if (/[，。！？、；：""''（）【】《》—…·\-,\.!?;:'"()\[\]{}<>]/.test(ch)) continue
    normalized += ch
    indexMap.push(i)
  }
  return { normalized, indexMap }
}

/**
 * 将参考稿文本对齐到转写段落
 * 返回每个段落在参考稿中对应的字符区间
 */
export function alignReferenceToSegments(
  segments: TranscriptionSegment[],
  referenceText: string,
): ReferenceSpan[] {
  if (segments.length === 0 || !referenceText.trim()) return []

  const transcriptFull = segments.map((s) => s.text).join('')

  const normTranscript = normalize(transcriptFull)
  const normReference = normalize(referenceText)

  const diffs = diffChars(normTranscript.normalized, normReference.normalized)

  // 构建归一化转写索引 → 段落索引的映射
  const charToSegmentIdx: number[] = []
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    for (let c = 0; c < segments[segIdx].text.length; c++) {
      charToSegmentIdx.push(segIdx)
    }
  }

  // 遍历 diff，建立归一化转写偏移 → 归一化参考偏移的对应关系
  let transcriptOffset = 0
  let referenceOffset = 0

  // 每个段落在归一化转写中的起始/结束位置
  const segNormBounds: Array<{ start: number; end: number }> = []
  let normIdx = 0
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const start = normIdx
    for (let c = 0; c < segments[segIdx].text.length; c++) {
      const origIdx = normIdx < normTranscript.indexMap.length ? normIdx : -1
      if (origIdx >= 0) normIdx++
    }
    segNormBounds.push({ start, end: normIdx })
  }

  // 通过 diff 建立归一化转写索引 → 归一化参考索引的映射
  const transcriptToRef: number[] = new Array(normTranscript.normalized.length + 1).fill(-1)

  for (const part of diffs) {
    if (!part.added && !part.removed) {
      for (let i = 0; i < part.value.length; i++) {
        if (transcriptOffset < transcriptToRef.length) {
          transcriptToRef[transcriptOffset] = referenceOffset
        }
        transcriptOffset++
        referenceOffset++
      }
    } else if (part.removed) {
      for (let i = 0; i < part.value.length; i++) {
        if (transcriptOffset < transcriptToRef.length) {
          transcriptToRef[transcriptOffset] = referenceOffset
        }
        transcriptOffset++
      }
    } else if (part.added) {
      referenceOffset += part.value.length
    }
  }
  transcriptToRef[transcriptOffset] = referenceOffset

  // 将每个段落的归一化边界映射回参考稿原始索引
  const result: ReferenceSpan[] = []
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const { start, end } = segNormBounds[segIdx]
    const refNormStart = transcriptToRef[start] ?? -1
    const refNormEnd = transcriptToRef[Math.min(end, transcriptToRef.length - 1)] ?? -1

    if (refNormStart === -1 || refNormEnd === -1 || refNormStart >= refNormEnd) {
      result.push({
        segmentId: segments[segIdx].id,
        referenceStart: -1,
        referenceEnd: -1,
      })
    } else {
      const origStart = refNormStart < normReference.indexMap.length
        ? normReference.indexMap[refNormStart]
        : normReference.normalized.length
      const origEnd = refNormEnd - 1 < normReference.indexMap.length
        ? (normReference.indexMap[refNormEnd - 1] + 1)
        : normReference.normalized.length

      result.push({
        segmentId: segments[segIdx].id,
        referenceStart: origStart,
        referenceEnd: Math.max(origEnd, origStart),
      })
    }
  }

  return result
}
