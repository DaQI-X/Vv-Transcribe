/**
 * AI 文本纠错 IPC 处理器
 * 读取用户设置的 AI 配置，调用 OpenAI 兼容接口进行文本纠错
 * 未配置 Key 或调用失败时通过 error 字段回传原因，避免渲染进程把「失败」当成「无需纠正」
 */
import { ipcMain } from 'electron'
import { OpenAICompatibleProvider } from '../services/ai/openaiCompatible'
import { getAIConfig } from '../services/settingsService'
import type { DifferenceItem } from '../services/ai/types'

export function registerAIHandlers() {
  ipcMain.handle(
    'ai:correct',
    async (
      _event,
      text: string,
      options?: { language?: string; promptTemplate?: string },
    ) => {
      const config = await getAIConfig()

      if (!config.apiKey) {
        return {
          corrected: text,
          changes: [],
          error: '未配置 AI 纠错 API Key，请在「设置 → 纠错配置」中填写',
        }
      }

      try {
        const provider = new OpenAICompatibleProvider(config)
        return await provider.correctText(text, options)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'AI 纠错失败'
        return { corrected: text, changes: [], error: `AI 纠错失败: ${message}` }
      }
    },
  )

  ipcMain.handle(
    'ai:explainDifferences',
    async (_event, differences: DifferenceItem[]) => {
      const config = await getAIConfig()

      if (!config.apiKey) {
        return differences.map(() => ({
          explanation: '未配置 AI API Key',
        }))
      }

      try {
        const provider = new OpenAICompatibleProvider(config)
        const BATCH_SIZE = 50
        const results: Array<{ explanation: string; dictionaryHint?: string }> = []

        for (let i = 0; i < differences.length; i += BATCH_SIZE) {
          const batch = differences.slice(i, i + BATCH_SIZE)
          const batchResults = await provider.explainDifferences(batch)
          results.push(...batchResults)
        }

        return results
      } catch (err) {
        const message = err instanceof Error ? err.message : 'AI 解释失败'
        return differences.map(() => ({ explanation: `解释失败: ${message}` }))
      }
    },
  )

  ipcMain.handle(
    'ai:analyzeReference',
    async (_event, referenceText: string) => {
      const config = await getAIConfig()

      if (!config.apiKey) {
        return {
          issues: [],
          error: '未配置 AI 纠错 API Key，请在「设置 → 纠错配置」中填写',
        }
      }

      try {
        const provider = new OpenAICompatibleProvider(config)
        return { issues: await provider.analyzeReference(referenceText), error: null }
      } catch (err) {
        const message = err instanceof Error ? err.message : '参考稿 AI 分析失败'
        console.error('AI 参考文本分析失败:', err)
        return { issues: [], error: `参考稿 AI 分析失败: ${message}` }
      }
    },
  )
}
