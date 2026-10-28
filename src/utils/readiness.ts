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
 * 字幕配音的前置校验：先按「配音引擎」这一档分叉，再查该档真正需要的东西。
 * 云端档查 Key、配音模型、音色；本地档只查组件在不在场和音色是不是一个编号——
 * 拿云端那三样去问本地档，就会把已经能干活的用户拦在门外（#220/#227 的教训是判松判严都栽过）。
 * 单独查配音模型是必要的——音频接口吃的是配音模型 id，拿 chat 模型去调必然被拒，
 * 而那时用户已经点了「开始配音」，烧掉的是他自己 Key 上的调用额度。
 */
export async function checkVoiceReady(): Promise<ReadinessBlock | null> {
  const api = getElectronAPI()
  if (!api) return null

  const settings = await api.getSettings().catch(() => null)

  if (str(settings?.ttsEngine) === 'local') {
    // 只拦「组件不在场」这一种：本地引擎是懒启动的，ready:false 只代表还没起过，
    // 不代表用不了——把它当阻塞条件，就等于要求用户先手动去点一次「启动引擎」。
    const status = await api.getLocalVoiceStatus(str(settings?.ttsLocalEngine) || undefined).catch(() => null)
    if (status && !status.binaryPresent) {
      return {
        message: '本地配音引擎还没下载好。请在「设置 → 配音配置」里下载本地配音组件',
        settingsTab: 'tts',
      }
    }
    if (status && !status.modelPresent) {
      return {
        message: `本地配音的模型还没下载（${status.requestedEngine}）。请在「设置 → 配音配置」里下载对应模型`,
        settingsTab: 'tts',
      }
    }
    // 与主进程 ttsConfigProblem 同一口径：音色得是编号。空着不算问题（主进程按推荐档 0 处理）
    const voice = str(settings?.ttsLocalVoice)
    if (voice && !/^\d+$/.test(voice)) {
      return {
        message: `本地配音的音色是一个编号（如 0），当前是「${voice}」。请在「设置 → 配音配置 → 本地音色」里重选一个`,
        settingsTab: 'tts',
      }
    }
    return null
  }

  const ttsKey = keyStatus(settings, 'ttsKeyStatus')
  const aiKey = keyStatus(settings, 'aiKeyStatus')
  // 与主进程 getTTSConfig 同一个口径：配音那把留空时用的是校对那把，所以两把都指望不上才算没配。
  // 这里判得比主进程严或松都不行——松了会带着空 Authorization 去打接口，紧了会拦下本来能干活的人。
  const usable = (s: KeyStatus) => s === 'encrypted' || s === 'plaintext'
  if (!usable(ttsKey) && !usable(aiKey)) {
    if (ttsKey === 'unreadable') return { message: UNREADABLE_KEY_MESSAGE, settingsTab: 'tts' }
    if (aiKey === 'unreadable') return { message: UNREADABLE_KEY_MESSAGE, settingsTab: 'ai' }
    return {
      message: '字幕配音需要 API Key：可以在「配音配置」里单独填一把，也可以在「校对配置」里填一把供两边共用',
      settingsTab: 'tts',
    }
  }
  const missing = !str(settings?.ttsModel)
    ? '配音模型'
    : !str(settings?.ttsVoice)
      ? '配音音色'
      : null
  if (missing) {
    return {
      message: `字幕配音还缺「${missing}」，请在「设置 → 配音配置」里填写并保存`,
      settingsTab: 'tts',
    }
  }
  return null
}

/** 拦住之后：说清原因，并直接打开要改的那个设置页 */
export function raiseReadinessBlock(block: ReadinessBlock) {
  toast.error(block.message)
  useSettingsModalStore.getState().open(block.settingsTab)
}
