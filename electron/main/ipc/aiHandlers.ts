/**
 * AI 文本纠错 IPC 处理器
 * 读取用户设置的 AI 配置，调用 OpenAI 兼容接口进行文本纠错
 * 未配置 API Key 时返回原文并提示用户
 */
import { ipcMain } from 'electron'
import { OpenAICompatibleProvider } from '../services/ai/openaiCompatible'
import { loadSettings } from '../services/settingsService'

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
}
