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

/** 与主进程 settingsService 的 SecretStatus 对应；界面只拿得到状态，拿不到 Key 本身 */
export type KeyStatus = 'none' | 'encrypted' | 'plaintext' | 'unreadable'

/** 密文解不开＝Key 在配置里、但这台机器读不出来，说「还没填」会让人以为是自己漏填 */
export const UNREADABLE_KEY_MESSAGE =
  '这台机器读不出已保存的 API Key（可能换过电脑，或系统密钥库被清过）。重新填一次并保存即可'

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 认不出的状态一律按「没有」处理，别让一个多余的可能值把校验绕过去 */
function keyStatus(settings: Record<string, unknown> | null, field: string): KeyStatus {
  const raw = settings?.[field]
  return raw === 'encrypted' || raw === 'plaintext' || raw === 'unreadable' ? raw : 'none'
}

export async function checkTranscriptionReady(): Promise<ReadinessBlock | null> {
  const api = getElectronAPI()
  if (!api) return null

  const settings = await api.getSettings().catch(() => null)
  const provider = str(settings?.asrProvider)

  // 云端优先：缺 Key/地址就拦下。宁可让用户补配置或改回本地，也不要默默降级成另一套引擎
  if (provider === 'cloud') {
    const asrKey = keyStatus(settings, 'asrKeyStatus')
    if (asrKey === 'unreadable') return { message: UNREADABLE_KEY_MESSAGE, settingsTab: 'asr' }
    if (asrKey === 'none' || !str(settings?.asrApiBase)) {
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
  const aiKey = keyStatus(settings, 'aiKeyStatus')
  if (aiKey === 'unreadable') return { message: UNREADABLE_KEY_MESSAGE, settingsTab: 'ai' }
  if (aiKey === 'none') {
    return {
      message: 'AI 校对需要先配置 API Key，请在「校对配置」里填写',
      settingsTab: 'ai',
    }
  }
  return null
}

/**
 * 有没有一把「现在能用」的校对 Key：决定「校对」按钮是弹方式选择，还是直接跑本地校对。
 * 解不开的那把算「有」——直接跑本地会给出「未配置校对模型」的误导说法，
 * 不如让用户在弹窗里选到 AI 这条路，撞上明确的原因并跳去重填。
 */
export async function hasCorrectionModel(): Promise<boolean> {
  const api = getElectronAPI()
  if (!api) return false
  const settings = await api.getSettings().catch(() => null)
  return keyStatus(settings, 'aiKeyStatus') !== 'none'
}

/**
 * 配音的前置校验：Key、配音模型、配音音色，缺任何一样整批调用都会失败。
 * 单独查模型是必要的——音频接口吃的是配音模型 id，拿 chat 模型去调必然被拒，
 * 而那时用户已经点了「开始配音」，烧掉的是他自己 Key 上的调用额度。
 */
export async function checkVoiceReady(): Promise<ReadinessBlock | null> {
  const api = getElectronAPI()
  if (!api) return null

  const settings = await api.getSettings().catch(() => null)
  const aiKey = keyStatus(settings, 'aiKeyStatus')
  if (aiKey === 'unreadable') return { message: UNREADABLE_KEY_MESSAGE, settingsTab: 'ai' }
  if (aiKey === 'none') {
    return { message: '配音需要先配置 API Key，请在「校对配置」里填写', settingsTab: 'ai' }
  }
  const missing = !str(settings?.aiTtsModel)
    ? '配音模型'
    : !str(settings?.aiTtsVoice)
      ? '配音音色'
      : null
  if (missing) {
    return {
      message: `配音还缺「${missing}」，请在「设置 → 校对配置」里填写并保存`,
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
