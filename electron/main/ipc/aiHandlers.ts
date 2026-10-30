/**
 * AI 文本校对 IPC 处理器
 * 读取用户设置的 AI 配置，调用 OpenAI 兼容接口进行文本校对
 * 未配置 Key 或调用失败时通过 error 字段回传原因，避免渲染进程把「失败」当成「无需纠正」
 *
 * 「没配置」和「调用失败」是两句不同的话，都得由 error 槽位说出来；而解释那一条按条数回等长清单，
 * 因为差异本身是本地 diff 算出来的，不能被大模型的失败连带抹掉。
 * 三条都收在 guard.ts 的 ipcHandle 里：`await getAIConfig()` 原先就落在各段 try 外面，
 * 配置文件读不出来时那一下是真会 reject 到渲染层的。
 */
import { OpenAICompatibleProvider } from '../services/ai/openaiCompatible'
import { getAIConfig } from '../services/settingsService'
import type { DifferenceItem } from '../services/ai/types'
import { ipcHandle } from './guard'

export function registerAIHandlers() {
  ipcHandle(
    'ai:correct',
    async (_event, text: string, options?: { language?: string; promptTemplate?: string }) => {
      const config = await getAIConfig()

      if (!config.apiKey) {
        return {
          corrected: text,
          changes: [],
          error: '未配置 AI 校对 API Key，请在「设置 → 校对配置」中填写',
        }
      }

      const provider = new OpenAICompatibleProvider(config)
      return await provider.correctText(text, options)
    },
    // corrected 回原文而不是回空串：界面已经按「corrected 与原文一样＝没改」判过一次，
    // 这里再配一句 error，调用点就能把失败和「无需纠正」分开说
    (message, _event, text) => ({
      corrected: text,
      changes: [],
      error: `AI 校对失败: ${message}`,
    })
  )

  ipcHandle(
    'ai:explainDifferences',
    async (_event, differences: DifferenceItem[]) => {
      const config = await getAIConfig()

      if (!config.apiKey) {
        return differences.map(() => ({
          explanation: '未配置 AI API Key',
        }))
      }

      const provider = new OpenAICompatibleProvider(config)
      const BATCH_SIZE = 50
      const results: Array<{ explanation: string; dictionaryHint?: string }> = []

      for (let i = 0; i < differences.length; i += BATCH_SIZE) {
        const batch = differences.slice(i, i + BATCH_SIZE)
        const batchResults = await provider.explainDifferences(batch)
        results.push(...batchResults)
      }

      return results
    },
    // 等长是这条通道的契约：渲染层按下标把解释填回各自的差异，少一条就少一句解释且不说明原因
    (message, _event, differences) =>
      differences.map(() => ({ explanation: `解释失败: ${message}` }))
  )

  ipcHandle(
    'ai:analyzeReference',
    async (_event, referenceText: string) => {
      const config = await getAIConfig()

      if (!config.apiKey) {
        return {
          issues: [],
          error: '未配置 AI 校对 API Key，请在「设置 → 校对配置」中填写',
        }
      }

      const provider = new OpenAICompatibleProvider(config)
      return { issues: await provider.analyzeReference(referenceText), error: null }
    },
    (message) => ({ issues: [], error: `参考稿 AI 分析失败: ${message}` })
  )
}
