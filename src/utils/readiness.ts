/**
 * 开工前置校验
 * 把「这套配置干不了活」提前到用户点开始的那一刻，而不是等音频提取完、
 * 甚至转写到一半才失败。命中时返回要直达的设置 Tab，界面据此提示并打开配置页。
 */
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { toast } from '@/components/ui/Toast'
import { useSettingsModalStore } from '@/stores/useSettingsModalStore'

export interface ReadinessBlock {
  message: string
  settingsTab: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export async function checkTranscriptionReady(): Promise<ReadinessBlock | null> {
  const api = getElectronAPI()
  if (!api) return null

  const settings = await api.getSettings().catch(() => null)
  const provider = str(settings?.asrProvider)

  // 云端优先：缺 Key/地址就拦下。宁可让用户补配置或改回本地，也不要默默降级成另一套引擎
  if (provider === 'cloud') {
    if (!str(settings?.asrApiKey) || !str(settings?.asrApiBase)) {
      return {
        message: '转写模式是「云端优先」，但 API Base 或 API Key 还没填。请补全并保存，或把模式改回「本地转写」',
        settingsTab: 'asr',
      }
    }
    return null
  }

  // 本地模式：现问一次引擎，而不是信启动时缓存的布尔值——引擎可能在应用开着的时候被杀掉
  const check = await api.testConnection('asr', { provider: 'local', apiBase: '', apiKey: '', model: '' })
  if (check.level === 'fail') {
    return { message: check.message, settingsTab: 'asr' }
  }
  return null
}

export async function checkCorrectionReady(): Promise<ReadinessBlock | null> {
  const api = getElectronAPI()
  if (!api) return null

  const settings = await api.getSettings().catch(() => null)
  if (!str(settings?.aiApiKey)) {
    return {
      message: 'AI 校对需要先配置 API Key，请在「校对配置」里填写',
      settingsTab: 'ai',
    }
  }
  return null
}

/** 拦住之后：说清原因，并直接打开要改的那个设置页 */
export function raiseReadinessBlock(block: ReadinessBlock) {
  toast.error(block.message)
  useSettingsModalStore.getState().open(block.settingsTab)
}
