/**
 * 本地校对 IPC 处理器
 * 与 aiHandlers 的区别只有一条：这条路径全程不读 API Key，没配置也能用
 */
import { ipcMain } from 'electron'
import {
  proofreadSegmentsLocally,
  explainDifferencesLocally,
} from '../services/localProofread'
import type { DifferenceItem } from '../services/ai/types'

export function registerProofreadHandlers() {
  ipcMain.handle(
    'proofread:local',
    async (_event, segments: Array<{ id: string; text: string }>) =>
      proofreadSegmentsLocally(segments),
  )

  ipcMain.handle(
    'proofread:explain',
    async (_event, differences: DifferenceItem[]) => explainDifferencesLocally(differences),
  )
}
