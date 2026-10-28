/**
 * 长文本切块（纯文本配音用）
 *
 * 配音接口按「一次一段文本」工作，各家对单次长度的限制不一样，把整篇稿子原丢过去是
 * 「迟早撞上某家上限」的写法；切成小块除了躲上限，还能让进度有真实段号、单段失败不拖垮整批。
 * 800 字取的是远低于常见上限的量，一次请求也就几秒音频，失败重来的代价足够小。
 *
 * 切点优先落在句末，其次逗号一类的停顿，最后才硬切——朗读的断句比字符数更影响听感。
 */

/** 一块最多多少字 */
export const TTS_MAX_CHARS_PER_CHUNK = 800

/** 句末边界（中英标点都认） */
const HARD_BOUNDARY = /[。！？；!?;]/
/** 停顿边界：一句太长时退到这里切 */
const SOFT_BOUNDARY = /[，、：:,]/

/** 按单个字符边界切开，并把标点留在前一片上——切完拼回去时标点不能丢 */
function splitKeepingPunctuation(text: string, boundary: RegExp): string[] {
  const parts: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (boundary.test(text[i])) {
      parts.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) parts.push(text.slice(start))
  return parts.filter((part) => part !== '')
}

/**
 * 把一整篇文本切成「每块不超过 maxChars」的朗读单元。
 * 换行按分段处理（段与段之间一定切开），段内先按句末、再按停顿、最后按长度切。
 */
export function splitPlainText(text: string, maxChars = TTS_MAX_CHARS_PER_CHUNK): string[] {
  const units: string[] = []

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    for (const sentence of splitKeepingPunctuation(trimmed, HARD_BOUNDARY)) {
      if (sentence.length <= maxChars) {
        units.push(sentence)
        continue
      }
      for (const clause of splitKeepingPunctuation(sentence, SOFT_BOUNDARY)) {
        if (clause.length <= maxChars) {
          units.push(clause)
        } else {
          // 没有任何标点可退的超长串（无标点口语、长英文句）：只能按字数硬切
          for (let i = 0; i < clause.length; i += maxChars) units.push(clause.slice(i, i + maxChars))
        }
      }
    }
  }

  // 贪心合并：一个逗号单元就发一次请求太碎（每段一次网络调用，几百次就是几十分钟），够长再发
  const chunks: string[] = []
  let current = ''
  for (const unit of units) {
    if (current && current.length + unit.length > maxChars) {
      chunks.push(current)
      current = ''
    }
    current += unit
  }
  if (current) chunks.push(current)

  return chunks.map((chunk) => chunk.trim()).filter(Boolean)
}
