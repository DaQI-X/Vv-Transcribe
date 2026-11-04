/**
 * 开工前置校验
 * 把「这套配置干不了活」提前到用户点开始的那一刻，而不是等音频提取完、
 * 甚至转写到一半才失败。命中时返回要直达的设置 Tab，界面据此提示并打开配置页。
 */
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { toast } from '@/components/ui/Toast'
import { useSettingsModalStore } from '@/stores/useSettingsModalStore'
import { hasInAppDownload, missingBinaryHint, missingModelHint } from '@/utils/localTtsEngines'
import { PROFILE_CAP_SPEC } from '@/utils/profileSpec'
import type { ProfileCapability } from '@/types/settingsProfile'

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

/** 拦下之后打开的那个设置 Tab 对用户的叫法（与 SettingsModal 的 TAB_TITLES 同一份说法） */
const READY_TAB_LABEL: Record<ProfileCapability, string> = {
  asr: '转写配置',
  ai: '校对配置',
  tts: '配音配置',
}

/**
 * 「这一档开不了工」其实有两种，出路不一样，必须分开说：
 * 一条方案都没建过（去点「新建API接入」），和建了几套却没选定哪套（进那一行勾上「当前使用」）。
 * 判据只能问方案列表——脱敏视图里那把空 Key 两种都可能是原因，说错的那句会把用户领到一条走不通的出路上。
 * 列表没读出来时返回 null：拿不到证据就不编原因，由调用方落回那句本来就说得出结果的话。
 *
 * 三档共用这一处（#222 重写第⑧步：列表与弹窗三档同一套 UI，拦人的话也必须是同一套），
 * 所以出路里只提「弹窗里那颗保存」，不再提右下角的「保存设置」——凭据落不落盘跟它无关了。
 */
async function noCurrentProfileMessage(
  api: Window['electronAPI'],
  cap: ProfileCapability,
  lead: string,
  fields: string,
  tail: string
): Promise<string | null> {
  const view = await api.listProfiles().catch(() => null)
  if (!view || view.defaultProfileId[cap]) return null
  const activity = PROFILE_CAP_SPEC[cap].activity
  const tab = READY_TAB_LABEL[cap]
  const body =
    view.profiles[cap].length === 0
      ? `${lead}一条${activity}方案都还没有：在「${tab}」里点「新建API接入」，在弹窗里把${fields}填好，点弹窗底部的「保存」`
      : `${lead}那 ${view.profiles[cap].length} 套方案里现在没有「当前使用」的那一套：在「${tab}」里点要用的那一行的「编辑」，在弹窗里勾上「当前使用」再点「保存」`
  return `${body}${tail}`
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
    const blocked = await noCurrentProfileMessage(
      api,
      'asr',
      '转写模式是「云端优先」，但',
      '接口地址、API Key 和模型',
      '；或把模式改回「本地转写」'
    )
    if (blocked) return { message: blocked, settingsTab: 'asr' }
    if (asrKey === 'none' || !str(settings?.asrApiBase)) {
      return {
        message:
          '转写模式是「云端优先」，但这套方案的 API Base 或 API Key 还没填。请在「转写配置」里点它的「编辑」，在弹窗里把那几格补全并点「保存」；或把模式改回「本地转写」',
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
    const blocked = await noCurrentProfileMessage(
      api,
      'ai',
      'AI 校对靠的是云端方案，',
      '服务商、接口地址、API Key 和模型',
      '；也可以关掉这一页改走不依赖 Key 的本地校对'
    )
    return {
      message:
        blocked ?? 'AI 校对需要先配置 API Key：请在「校对配置」里点那一行的「编辑」，在弹窗里填一把 Key 并点「保存」',
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
 *
 * overrides 是配音工作台当前填的那几个参数（档／模型／音色）。这一问必须跟着界面走：
 * 只读 settings 会出现「用户在页面上换了档、校验却按旧档拦人」，也会让「试听」绕过它该撞的那道门
 * （主进程 withOverrides 用的就是这几个值，两边口径得一样：空串＝不覆盖，回落 settings）。
 */
export interface VoiceOverrides {
  /** 本地档：界面模型下拉当前选中的引擎 id */
  localEngine?: string
  /** 界面音色输入当前值（本地档是编号，云端档是服务商的 voice id） */
  voice?: string
  /** 云端档：界面模型输入当前值 */
  model?: string
}

export async function checkVoiceReady(overrides: VoiceOverrides = {}): Promise<ReadinessBlock | null> {
  const api = getElectronAPI()
  if (!api) return null

  const settings = await api.getSettings().catch(() => null)

  if (str(settings?.ttsEngine) === 'local') {
    // 只拦「组件不在场」这一种：本地引擎是懒启动的，ready:false 只代表还没起过，
    // 不代表用不了——把它当阻塞条件，就等于要求用户先手动去点一次「启动引擎」。
    const requested = str(overrides.localEngine) || str(settings?.ttsLocalEngine) || undefined
    const status = await api.getLocalVoiceStatus(requested).catch(() => null)
    if (status && !status.binaryPresent) {
      // 引擎那一行有没有下载按钮，由「本版清单里有没有它」决定——这一位现在由主进程的会话缓存
      // 随状态一起回（binaryInManifest），所以这里能像模型那一支一样分叉，而不是统一一句导向下载：
      // 明确没有包时把人领到 about，对面是一行收着按钮的记录；那时的出路是换回云端档。
      // 句子整体交给 missingBinaryHint，这里不再加前缀——它那一句已经把「这台机器上还没有」说完了。
      return {
        message: missingBinaryHint(status.binaryInManifest),
        settingsTab: status.binaryInManifest === false ? 'tts' : 'about',
      }
    }
    if (status && !status.modelPresent) {
      // 拦下时打开哪个 tab 取决于这句话给的出路：能下载的去按需组件，本版没包的去处是换档
      return {
        message: missingModelHint(status.requestedEngine),
        settingsTab: hasInAppDownload(status.requestedEngine) ? 'about' : 'tts',
      }
    }
    // 与主进程 ttsConfigProblem 同一口径：音色得是列表里的一项（存的是 0-based 的 sid）。
    // 空着不算问题（主进程按推荐档 0 处理，界面显示成「音色 1」）
    const voice = str(overrides.voice) || str(settings?.ttsLocalVoice)
    if (voice && !/^\d+$/.test(voice)) {
      return {
        message: `本地配音的音色要选「本地音色」列表里的一项，当前是「${voice}」。请在「设置 → 配音配置 → 本地音色」里重选一个`,
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
    const blocked = await noCurrentProfileMessage(
      api,
      'tts',
      '配音引擎是「云端接口」，',
      '接口地址、API Key、配音模型和音色',
      '；也可以在「校对配置」里填一把 Key 供两边共用，或把「配音引擎」换成「本地配音」'
    )
    return {
      message:
        blocked ??
        '字幕配音需要 API Key：请在「配音配置」里点那一行的「编辑」，在弹窗里填一把 Key 并点「保存」；也可以在「校对配置」里填一把供两边共用',
      settingsTab: 'tts',
    }
  }
  // 模型与音色按「界面填的那一份」问，口径与主进程 withOverrides 一致：覆盖值为空才回落设置。
  // 只看设置会拦下已经在工作台里把这两样填全的人——他被拦下的理由在他的屏幕上根本找不到。
  const missing = !str(overrides.model) && !str(settings?.ttsModel)
    ? '配音模型'
    : !str(overrides.voice) && !str(settings?.ttsVoice)
      ? '配音音色'
      : null
  if (missing) {
    return {
      message: `字幕配音还缺「${missing}」——可以在配音页那一栏直接填，也可以在「设置 → 配音配置」的方案列表里点那一行的「编辑」，在弹窗里补上并点「保存」`,
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
