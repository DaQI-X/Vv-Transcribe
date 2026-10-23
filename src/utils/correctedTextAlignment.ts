/**
 * AI 校对文本对齐工具
 * 将 AI 校对后的完整文本对齐回原始转写段落
 */
import { diffChars } from 'diff'
import type { TranscriptionSegment } from '@/types/transcription'

/**
 * 将 AI 校对后的文本对齐到原始段落
 * 返回每个段落对应的校对后文本
 */
export function alignCorrectedToSegments(
  segments: TranscriptionSegment[],
  correctedText: string,
): string[] {
  if (segments.length === 0) return []
  if (!correctedText || !correctedText.trim()) {
    return segments.map((s) => s.text)
  }

  // 拼接所有段落的原始文本
  const originalFull = segments.map((s) => s.text).join('')

  // 使用 diff 对比原始文本和校对后文本
  const diffs = diffChars(originalFull, correctedText)

  // 构建原始文本字符索引 → 校对后文本的映射
  const originalToCorrected: number[] = []
  let origOffset = 0
  let corrOffset = 0

  for (const part of diffs) {
    if (!part.added && !part.removed) {
      // 相同部分：建立映射关系
      for (let i = 0; i < part.value.length; i++) {
        originalToCorrected[origOffset] = corrOffset
        origOffset++
        corrOffset++
      }
    } else if (part.removed) {
      // 原始文本中被删除的部分：映射到当前位置
      for (let i = 0; i < part.value.length; i++) {
        originalToCorrected[origOffset] = corrOffset
        origOffset++
      }
    } else if (part.added) {
      // 校对后新增的部分：只移动校对偏移
      corrOffset += part.value.length
    }
  }
  // 边界情况：最后一个字符的映射
  originalToCorrected[origOffset] = corrOffset

  // 根据每个段落在原始文本中的位置，提取对应的校对后文本
  const result: string[] = []
  let segStart = 0

  for (const seg of segments) {
    const segEnd = segStart + seg.text.length

    // 获取这个段落在校对后文本中的对应范围
    const corrStart = originalToCorrected[segStart] ?? 0
    const corrEnd = originalToCorrected[segEnd] ?? correctedText.length

    // 提取对应的校对后文本
    const segCorrected = correctedText.slice(corrStart, corrEnd)
    result.push(segCorrected || seg.text)

    segStart = segEnd
  }

  return result
}
