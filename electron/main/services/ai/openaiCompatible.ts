/**
 * OpenAI 兼容 AI 校对提供者
 * 调用 OpenAI / DeepSeek / 通义千问等兼容接口进行文本校对
 * 
 * 校对流程（三层架构）：
 * 1. ASR 错误表：确定性修正已知同音字错误（如"决性→觉性"）
 * 2. 词典验证：用修正后的词查词典，获取释义注入 prompt
 * 3. Prompt 强化：强调语音识别同音字错误，附带已修正线索
 */
import type { AIProvider, DifferenceItem, ExplanationResult, ReferenceIssue } from './types'
import {
  applyASRErrorCorrections,
  buildDictionaryContext,
  buildDistinctionContext,
} from '../ruleProofread'

interface OpenAICompatibleConfig {
  apiKey: string
  apiBase: string
  model: string
}

/** 校对用的基础 prompt。「测试连接」要复用同一个契约，否则测的就不是干活时发的那份请求 */
export const DEFAULT_PROMPT = `你是一个专业的中文文本校对助手。以下是一段语音识别生成的文本。

**重要提示**：这是语音识别（ASR）生成的文本，存在同音字、近音字误识别问题。已根据常见 ASR 错误表进行了初步修正。

请按照以下要求处理：
1. **优先修正同音字、近音字错误**（这是语音识别最常见的错误类型）
2. 修正标点符号使用不当
3. 严格参照提供的词典释义，确保用词准确
4. 保持原意不变，不要增删内容
5. 对于不确定的词汇，优先保留原文，避免过度纠正

请以JSON格式返回结果：
{
  "corrected": "修正后的完整文本",
  "changes": ["改动1说明", "改动2说明"]
}

只返回JSON，不要添加其他内容。

原始文本：
`

export class OpenAICompatibleProvider implements AIProvider {
  readonly name = 'openai-compatible'
  private config: OpenAICompatibleConfig

  constructor(config: OpenAICompatibleConfig) {
    this.config = config
  }

  async correctText(
    text: string,
    options?: { language?: string; promptTemplate?: string },
  ): Promise<{ corrected: string; changes: string[] }> {
    const { corrected: preCorrected, applied } = applyASRErrorCorrections(text)
    
    const dictContext = await buildDictionaryContext(preCorrected)
    
    let correctionHint = ''
    if (applied.length > 0) {
      const hints = applied.map(e => `"${e.wrong}"→"${e.correct}"`).join('、')
      correctionHint = `\n\n已根据 ASR 常见错误表修正：${hints}\n请在此基础上进一步校对。`
    }
    
    const basePrompt = options?.promptTemplate || DEFAULT_PROMPT
    const prompt =
      basePrompt + preCorrected + correctionHint + buildDistinctionContext() + dictContext

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 60000)

    try {
      const response = await fetch(`${this.config.apiBase}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`AI 校对请求失败 (${response.status}): ${errorText}`)
      }

      const result = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = result.choices?.[0]?.message?.content

      if (!content) {
        throw new Error('AI 返回内容为空')
      }

      try {
        const parsed = JSON.parse(content)
        return {
          corrected: parsed.corrected ?? text,
          changes: parsed.changes ?? [],
        }
      } catch {
        return { corrected: content, changes: ['AI 返回格式异常，已返回原始响应'] }
      }
    } catch (err) {
      clearTimeout(timeoutId)
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('AI 校对请求超时（60秒），请检查网络连接或 API 配置')
      }
      throw err
    }
  }

  async explainDifferences(
    differences: DifferenceItem[],
  ): Promise<ExplanationResult[]> {
    if (differences.length === 0) return []

    const allText = differences.map((d) => `${d.original} ${d.corrected}`).join(' ')
    const dictContext = await buildDictionaryContext(allText)

    const prompt = `你是一个专业的中文语言顾问。以下是语音识别文本与参考播出稿之间的差异列表。
对每个差异，请解释：
1. 为什么要这样修改（指出原文的错误类型：同音字、近音字、断句错误等）
2. 修正后的词/字的含义（如果有词典释义请参考）

请以JSON数组格式返回：
[
  { "explanation": "修改原因及释义", "dictionaryHint": "词典释义（如有）" }
]

只返回JSON数组，不要添加其他内容。

差异列表：
${JSON.stringify(differences, null, 2)}
${dictContext}`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 60000)

    try {
      const response = await fetch(`${this.config.apiBase}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`AI 解释请求失败 (${response.status}): ${errorText}`)
      }

      const result = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = result.choices?.[0]?.message?.content

      if (!content) {
        throw new Error('AI 解释返回为空')
      }

      try {
        const parsed = JSON.parse(content)
        const explanations = Array.isArray(parsed) ? parsed : parsed.explanations ?? []
        return explanations.map((e: any) => ({
          explanation: e.explanation ?? '',
          dictionaryHint: e.dictionaryHint,
        }))
      } catch {
        return differences.map(() => ({ explanation: 'AI 返回格式异常' }))
      }
    } catch (err) {
      clearTimeout(timeoutId)
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('AI 解释请求超时（60秒），请检查网络连接或 API 配置')
      }
      throw err
    }
  }

  async analyzeReference(
    referenceText: string,
  ): Promise<ReferenceIssue[]> {
    if (!referenceText || !referenceText.trim()) return []

    const dictContext = await buildDictionaryContext(referenceText)

    const prompt = `你是一个资深的中文语言顾问和编辑。请分析以下参考文本，找出其中可能存在的问题：

1. 已经过时或不常用的词汇，建议替换为更现代、更常用的表达
2. 可能用错的字或词（同音字、形近字等）
3. 表述不够准确或清晰的地方
4. 可能有争议或需要用户判断的用词

注意：
- 只指出确实有疑问的地方，不要过度纠正
- 对于不确定的问题，也要指出供用户参考
- 每个问题都要给出详细的解释

请以JSON数组格式返回：
[
  {
    "text": "有问题的文本片段",
    "suggestion": "建议替换的内容（可选）",
    "explanation": "详细说明为什么这里有问题",
    "dictionaryHint": "相关词典释义（如有）",
    "refStart": 问题文本在原文中的起始位置（字符索引，从0开始）,
    "refEnd": 问题文本在原文中的结束位置（字符索引，不包含）
  }
]

只返回JSON数组，不要添加其他内容。如果没有发现问题，返回空数组 []。

参考文本：
${referenceText}
${dictContext}`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 60000)

    try {
      const response = await fetch(`${this.config.apiBase}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`AI 参考文本分析请求失败 (${response.status}): ${errorText}`)
      }

      const result = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = result.choices?.[0]?.message?.content

      if (!content) {
        throw new Error('AI 参考文本分析返回为空')
      }

      try {
        const parsed = JSON.parse(content)
        const issues = Array.isArray(parsed) ? parsed : parsed.issues ?? []
        return issues.map((issue: any) => ({
          text: issue.text ?? '',
          suggestion: issue.suggestion,
          explanation: issue.explanation ?? '',
          dictionaryHint: issue.dictionaryHint,
          refStart: typeof issue.refStart === 'number' ? issue.refStart : 0,
          refEnd: typeof issue.refEnd === 'number' ? issue.refEnd : 0,
        }))
      } catch {
        return []
      }
    } catch (err) {
      clearTimeout(timeoutId)
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('AI 参考文本分析请求超时（60秒），请检查网络连接或 API 配置')
      }
      throw err
    }
  }
}
