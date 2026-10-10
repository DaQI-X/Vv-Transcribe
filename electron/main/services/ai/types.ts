/**
 * AI 纠错模块类型定义
 * 定义 AI Provider 接口规范：接收原文，返回纠错后文本和改动说明
 */
export interface AIProvider {
  readonly name: string
  correctText(
    text: string,
    options?: {
      language?: string
      promptTemplate?: string
    },
  ): Promise<{ corrected: string; changes: string[] }>
}
