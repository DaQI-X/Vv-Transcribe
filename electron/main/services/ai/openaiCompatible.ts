/**
 * OpenAI 兼容 AI 纠错提供者
 * 调用 OpenAI / DeepSeek / 通义千问等兼容接口进行文本纠错
 * 
 * 纠错流程：
 * 1. 从原文中提取 2-4 字中文词汇
 * 2. 查询本地词典获取释义，注入到 prompt 中作为参考
 * 3. 调用 AI 接口进行纠错，要求以 JSON 格式返回修正文本和改动说明
 */
import type { AIProvider } from './types'
import { lookupMultipleWords } from '../dictionaryService'
import { lookupMultipleWords } from '../dictionaryService'

interface OpenAICompatibleConfig {
  apiKey: string
  apiBase: string
  model: string
}

function extractChineseWords(text: string): string[] {
  const matches = text.match(/[\u4e00-\u9fa5]{2,4}/g)
  if (!matches) return []
  return [...new Set(matches)]
}

async function buildDictionaryContext(text: string): Promise<string> {
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

const DEFAULT_PROMPT = `你是一个专业的中文文本校对助手。以下是一段语音识别生成的文本，其中可能包含同音字错误、断句不当、标点符号错误、用词不当等问题。

请按照以下要求处理：
1. 修正同音字、近音字错误
2. 修正标点符号使用不当
3. 严格参照提供的词典释义，确保用词准确。如果原文用词与词典释义不符，必须修正
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
    const dictContext = await buildDictionaryContext(text)
    const basePrompt = options?.promptTemplate || DEFAULT_PROMPT
    const prompt = basePrompt + text + dictContext

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
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`AI 纠错请求失败 (${response.status}): ${errorText}`)
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
  }
}
