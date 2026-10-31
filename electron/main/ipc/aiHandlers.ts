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
import { getAIConfig, resolveProfileId } from '../services/settingsService'
import { logger } from '../services/logger'
import type { DifferenceItem } from '../services/ai/types'
import { ipcHandle } from './guard'

export function registerAIHandlers() {
  ipcHandle(
    'ai:correct',
    async (
      _event,
      text: string,
      options?: { language?: string; promptTemplate?: string; profileId?: string }
    ) => {
      // profileId＝「这次校对用哪套校对配置」；空或指不到人时走该档当前默认方案，
      // 也就是界面上还没长出方案选择器时的行为。
      // 日志记的是 resolveProfileId 问出来的**实际**那条，不是传进来的那个——落回默认时后者会说谎
      const profileId = await resolveProfileId('ai', options?.profileId)
      const config = await getAIConfig(profileId)
      // 只报「有没有 Key」这一个布尔：Key 本身和它的长度都不能进日志。
      // 键名要避开 `apikey` 这个词（`hasApiKey` 会被脱敏闸门按键名吃掉，理由见 logRedact.ts）
      logger.info('AI', 'Correction config', { profileId, keyStatus: !!config.apiKey })

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
    async (_event, differences: DifferenceItem[], profileId?: string) => {
      const usedProfileId = await resolveProfileId('ai', profileId)
      const config = await getAIConfig(usedProfileId)
      logger.info('AI', 'Explain differences config', {
        profileId: usedProfileId,
        keyStatus: !!config.apiKey,
        count: differences.length,
      })

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
    async (_event, referenceText: string, profileId?: string) => {
      const usedProfileId = await resolveProfileId('ai', profileId)
      const config = await getAIConfig(usedProfileId)
      // 参考稿的正文与长度都不进日志，这里只记「按哪套跑的、有没有 Key」
      logger.info('AI', 'Analyze reference config', {
        profileId: usedProfileId,
        keyStatus: !!config.apiKey,
      })

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
