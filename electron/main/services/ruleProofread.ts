/**
 * 规则校对层
 * 不依赖大模型、不联网的确定性修正：误听表替换 + 词典释义提取 + 同音近义词辨析
 *
 * 从 openaiCompatible.ts 抽出，因为本地校对要用同一套规则但不能经过 AI provider
 * （那条路径要求配置 API Key）。AI 校对仍然在上面这些结果之上再叠一层模型判断。
 */
import { lookupMultipleWords } from './dictionaryService'
import { ASR_ERROR_MAP, ASR_USAGE_DISTINCTIONS, type ASRErrorEntry } from './asrErrorMap'

export type { ASRErrorEntry }

/** 确定性替换误听表命中的错别字，返回改后文本与实际命中的条目 */
export function applyASRErrorCorrections(
  text: string,
): { corrected: string; applied: ASRErrorEntry[] } {
  const applied: ASRErrorEntry[] = []
  let result = text

  for (const entry of ASR_ERROR_MAP) {
    if (result.includes(entry.wrong)) {
      result = result.split(entry.wrong).join(entry.correct)
      applied.push(entry)
    }
  }

  return { corrected: result, applied }
}

/** 互逆词对不能盲替换，只能把辨析规则交给模型，按语义判断 */
export function buildDistinctionContext(): string {
  const lines = ASR_USAGE_DISTINCTIONS.map((e) => `「${e.wrong}」/「${e.correct}」：${e.note ?? ''}`)
  return `\n\n同音近义词辨析（两个词都成立，按语义判断，不确定就保留原文）：\n${lines.join('\n')}`
}

export function extractChineseWords(text: string): string[] {
  const matches = text.match(/[\u4e00-\u9fa5]{2,4}/g)
  if (!matches) return []
  return [...new Set(matches)]
}

export async function buildDictionaryContext(text: string): Promise<string> {
  const words = extractChineseWords(text)
  if (words.length === 0) return ''

  const definitions = await lookupMultipleWords(words.slice(0, 50))
  const entries = Object.entries(definitions)

  if (entries.length === 0) return ''

  const dictLines = entries
    .slice(0, 20)
    .map(([word, explanation]) => `【${word}】${explanation.split('\n')[0]}`)
    .join('\n')

  return `\n\n参考词典释义：\n${dictLines}`
}
