/**
 * AI 校对模块类型定义
 * 定义 AI Provider 接口规范：接收原文，返回校对后文本和改动说明
 */
export interface DifferenceItem {
  original: string
  corrected: string
  context: string
}

export interface ExplanationResult {
  explanation: string
  dictionaryHint?: string
}

export interface ReferenceIssue {
  text: string
  suggestion?: string
  explanation: string
  dictionaryHint?: string
  refStart: number
  refEnd: number
}

export interface AIProvider {
  readonly name: string
  correctText(
    text: string,
    options?: {
      language?: string
      promptTemplate?: string
    },
  ): Promise<{ corrected: string; changes: string[] }>
  explainDifferences(
    differences: DifferenceItem[],
  ): Promise<ExplanationResult[]>
  analyzeReference(
    referenceText: string,
  ): Promise<ReferenceIssue[]>
}
