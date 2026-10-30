/**
 * 本地校对 IPC 处理器
 * 与 aiHandlers 的区别只有一条：这条路径全程不读 API Key，没配置也能用
 *
 * 失败形状跟着 aiHandlers 那三条走，好让渲染层不必按模式分两套判断：
 * - proofread:local 的返回是一份「逐段改后的结果」，`[]` 在界面里等于「没发现需要纠正的内容」，
 *   那是句谎，所以这条自己带一个 error 槽；
 * - proofread:explain 与 ai:explainDifferences 同一个口径——按条数回一份等长的说明文本，
 *   每条都写清楚为什么没有解释（差异本身是本地算出来的，不该被释义的失败连带抹掉）。
 */
import {
  proofreadSegmentsLocally,
  explainDifferencesLocally,
} from '../services/localProofread'
import type { LocalSegmentResult } from '../services/localProofread'
import type { DifferenceItem } from '../services/ai/types'
import { ipcHandle } from './guard'

export interface LocalProofreadResult {
  results: LocalSegmentResult[]
  error: string | null
}

export function registerProofreadHandlers() {
  ipcHandle(
    'proofread:local',
    async (_event, segments: Array<{ id: string; text: string }>): Promise<LocalProofreadResult> => ({
      results: await proofreadSegmentsLocally(segments),
      error: null,
    }),
    (message) => ({ results: [], error: message })
  )

  ipcHandle(
    'proofread:explain',
    (_event, differences: DifferenceItem[]) => explainDifferencesLocally(differences),
    // 释义查词库时读盘失败会让整批解释没跑成；这里不返回空数组（界面按下标取用，
    // 空数组的表现是所有气泡都少一句解释而不说为什么），而是每条都写明原因
    (message, _event, differences) =>
      differences.map(() => ({ explanation: `解释失败: ${message}` }))
  )
}
