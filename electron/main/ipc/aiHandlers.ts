/**
 * AI 文本纠错 IPC 处理器
 * 读取用户设置的 AI 配置，调用 OpenAI 兼容接口进行文本纠错
 * 未配置 API Key 时返回原文并提示用户
 */
import { ipcMain } from 'electron'
import { OpenAICompatibleProvider } from '../services/ai/openaiCompatible'
import { loadSettings } from '../services/settingsService'
import type { DifferenceItem } from '../services/ai/types'

export function registerAIHandlers() {
  ipcMain.handle(
    'ai:correct',
    async (
      _event,
      text: string,
      options?: { language?: string; promptTemplate?: string },
    ) => {
      const settings = await loadSettings()
      const config = {
        apiKey: settings.aiApiKey,
        apiBase: settings.aiApiBase,
        model: settings.aiModel,
      }

      if (!config.apiKey) {
        return {
          corrected: text,
          changes: ['未配置 AI API Key，请在设置中配置'],
        }
      }

      try {
        const provider = new OpenAICompatibleProvider(config)
        return await provider.correctText(text, options)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'AI 纠错失败'
        return { corrected: text, changes: [`纠错失败: ${message}`] }
      }
    },
  )

  ipcMain.handle(
    'ai:explainDifferences',
    async (_event, differences: DifferenceItem[]) => {
      const settings = await loadSettings()
      const config = {
        apiKey: settings.aiApiKey,
        apiBase: settings.aiApiBase,
        model: settings.aiModel,
      }

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
      const settings = await loadSettings()
      const config = {
        apiKey: settings.aiApiKey,
        apiBase: settings.aiApiBase,
        model: settings.aiModel,
      }

      if (!config.apiKey) {
        return []
      }

      try {
        const provider = new OpenAICompatibleProvider(config)
        return await provider.analyzeReference(referenceText)
      } catch (err) {
        console.error('AI 参考文本分析失败:', err)
        return []
      }
    },
  )
}
