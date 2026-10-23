/**
 * 本地校对（不联网、不消耗 Token）
 * 只做两件事：误听表确定性替换、用词库给改动补一条释义。
 * 规则解释不了的地方不硬凑结论，宁可如实说「以参考稿为准」。
 */
import { applyASRErrorCorrections } from './ruleProofread'
import { ASR_ERROR_MAP, ASR_USAGE_DISTINCTIONS, type ASRErrorEntry } from './asrErrorMap'
import { lookupMultipleWords } from './dictionaryService'
import type { DifferenceItem, ExplanationResult } from './ai/types'

const CATEGORY_LABEL: Record<string, string> = {
  同音字: '语音识别常见同音误听',
  成语错误: '成语固定写法',
  用词规范: '用词规范',
}

export interface LocalChange {
  before: string
  after: string
  reason: string
  dictionaryHint?: string
}

export interface LocalSegmentResult {
  segmentId: string
  corrected: string
  changes: LocalChange[]
}

function describeEntry(entry: ASRErrorEntry): string {
  const label = CATEGORY_LABEL[entry.category] ?? entry.category
  return entry.note ? `${label}（${entry.note}）` : label
}

/**
 * 释义只留一句给行内气泡。
 * 不能只切第一行——词库不少条目本身就是单行长文（如「西湖」一条 200+ 字），
 * 那样等于不截，会把气泡框撑爆。
 */
function brief(explanation: string): string {
  const line = explanation.split('\n')[0].trim()
  return line.length > 40 ? `${line.slice(0, 40)}…` : line
}

async function lookupHints(words: string[]): Promise<Record<string, string>> {
  if (words.length === 0) return {}
  const definitions = await lookupMultipleWords([...new Set(words)])
  return Object.fromEntries(
    Object.entries(definitions).map(([word, explanation]) => [word, brief(explanation)]),
  )
}

export async function proofreadSegmentsLocally(
  segments: Array<{ id: string; text: string }>,
): Promise<LocalSegmentResult[]> {
  const passes = segments.map((segment) => ({
    segmentId: segment.id,
    ...applyASRErrorCorrections(segment.text),
  }))

  const hints = await lookupHints(passes.flatMap((pass) => pass.applied.map((e) => e.correct)))

  return passes.map((pass) => ({
    segmentId: pass.segmentId,
    corrected: pass.corrected,
    changes: pass.applied.map((entry) => ({
      before: entry.wrong,
      after: entry.correct,
      reason: describeEntry(entry),
      dictionaryHint: hints[entry.correct],
    })),
  }))
}

/**
 * 参考稿差异的规则解释。
 * diff 是字级的，一次替换会拆成 delete（只有转写原文）和 insert（只有参考稿）两条，
 * 所以除了整词相等，还要接受「只给了一侧」的情况——但必须这一段里确实出现了表里的误听形态。
 * 单侧至少两个字，否则「性」这种半截片段会匹到不相干的词对上。
 */
function matchEntry(item: DifferenceItem, entry: ASRErrorEntry): boolean {
  const { original, corrected, context } = item
  if (entry.wrong === original && entry.correct === corrected) return true
  if (entry.wrong === corrected && entry.correct === original) return true
  if (!context.includes(entry.wrong)) return false
  if (original.length >= 2 && entry.wrong.includes(original)) return true
  return corrected.length >= 2 && entry.correct.includes(corrected)
}

export async function explainDifferencesLocally(
  items: DifferenceItem[],
): Promise<ExplanationResult[]> {
  const hits = items.map((item) => {
    const exact = ASR_ERROR_MAP.find((entry) => matchEntry(item, entry))
    if (exact) return { item, entry: exact, kind: 'rule' as const }
    const distinction = ASR_USAGE_DISTINCTIONS.find((entry) => matchEntry(item, entry))
    if (distinction) return { item, entry: distinction, kind: 'distinction' as const }
    return { item, entry: null, kind: 'none' as const }
  })

  // 命中规则的用词补它自己的释义；没命中的退一步查参考稿用词本身的释义
  const lookupWords = hits.flatMap((hit) =>
    hit.entry
      ? [hit.entry.correct]
      : /^[\u4e00-\u9fa5]{2,4}$/.test(hit.item.corrected)
        ? [hit.item.corrected]
        : [],
  )
  const hints = await lookupHints(lookupWords)

  return hits.map((hit) => {
    if (hit.entry) {
      return {
        explanation:
          hit.kind === 'rule'
            ? `${describeEntry(hit.entry)}：「${hit.entry.wrong}」应为「${hit.entry.correct}」`
            : `同音近义词，按语义判断：${hit.entry.note ?? ''}`,
        dictionaryHint: hints[hit.entry.correct],
      }
    }
    const definition = hints[hit.item.corrected]
    return {
      explanation: '以参考稿为准',
      dictionaryHint: definition,
    }
  })
}
