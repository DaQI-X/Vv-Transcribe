/**
 * 开工前置校验
 * 把「这套配置干不了活」提前到用户点开始的那一刻，而不是等音频提取完、
 * 甚至转写到一半才失败。命中时返回要直达的设置 Tab，界面据此提示并打开配置页。
 */
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { toast } from '@/components/ui/Toast'
import { useSettingsModalStore } from '@/stores/useSettingsModalStore'
import { hasInAppDownload, missingBinaryHint, missingModelHint } from '@/utils/localTtsEngines'
import {
  PROFILE_CAP_SPEC,
  asrVendorLabel,
  asrVendorWantsAppCredentials,
  ttsVendorNeedsModel,
} from '@/utils/profileSpec'
import type { ProfileCapability } from '@/types/settingsProfile'

export interface ReadinessBlock {
  message: string
  /**
   * 出路在设置页时给这一格（拦下时顺手把那一栏打开）。出路就在配音页自己那几格时不给：
   * 把设置弹到用户脸上，反而让他找不到该重选的那一格。
   */
  settingsTab?: string
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

  // 云端优先：缺凭据就拦下。宁可让用户补配置或改回本地，也不要默默降级成另一套引擎
  if (provider === 'cloud') {
    const asrKey = keyStatus(settings, 'asrKeyStatus')
    // 讯飞那一档还有第二把密文。它读不出来时的成因与出路和 API Key 完全一样（这台机器的密钥库
    // 认不出这份密文，重填一次并保存），所以复用同一句话，不为它另编一种措辞
    const asrSecret = keyStatus(settings, 'asrSecretStatus')
    if (asrKey === 'unreadable' || asrSecret === 'unreadable') {
      return { message: UNREADABLE_KEY_MESSAGE, settingsTab: 'asr' }
    }
    const blocked = await noCurrentProfileMessage(
      api,
      'asr',
      '转写模式是「云端优先」，但',
      '接口地址、API Key 和模型（讯飞那一家是 AppID、API Key 与 APISecret）',
      '；或把模式改回「本地转写」'
    )
    if (blocked) return { message: blocked, settingsTab: 'asr' }
    const vendor = str(settings?.asrVendor)
    /**
     * 讯飞那一档要三样凭据外加一个非空地址，缺哪一格都得在这儿点名：
     * 缺着发出去只会被回一条 100009「鉴权失败」，那句不会说是哪一格错了，用户只能三格挨个试。
     * 地址也一样——这一家留空时不会回落到 OpenAI 的官方地址（见 `asrManager.createCloudProvider`），
     * 所以「留空也能用」那条省事口径对它不成立。
     */
    if (asrVendorWantsAppCredentials(vendor)) {
      const missing = [
        !str(settings?.asrAppId) && 'AppID',
        asrKey === 'none' && 'API Key',
        asrSecret === 'none' && 'APISecret',
        !str(settings?.asrApiBase) && '接口地址',
      ].filter((item): item is string => !!item)
      if (missing.length) {
        return {
          message: `转写模式是「云端优先」，但这套${asrVendorLabel(vendor)}方案还缺 ${missing.join('、')}（都在讯飞开放平台那个应用的信息页里）。请在「转写配置」里点它的「编辑」，在弹窗里补全并点「保存」；或把模式改回「本地转写」`,
          settingsTab: 'asr',
        }
      }
      return null
    }
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
 * 云端档查 Key 和配音模型（模型这一问 1.1.2 起还看厂商：豆包那一档空着才是对的）；
 * 本地档只查组件在不在场和音色是不是一个编号——
 * 拿云端那两样去问本地档，就会把已经能干活的用户拦在门外（#220/#227 的教训是判松判严都栽过）。
 * 单独查配音模型是必要的——音频接口吃的是配音模型 id，拿 chat 模型去调必然被拒，
 * 而那时用户已经点了「开始配音」，烧掉的是他自己 Key 上的调用额度。
 * 音色从 1.1.0 起**不查**：能不能填、填什么由服务商决定（各家字段名与取值都不一样），
 * 空着发出去反而是一些模型的正确用法，拦下来等于替用户猜一份清单。
 *
 * overrides 是配音工作台当前填的那几个参数（本地档／音色）。这一问必须跟着界面走：
 * 只读 settings 会出现「用户在页面上换了档、校验却按旧档拦人」，也会让「试听」绕过它该撞的那道门
 * （主进程 withOverrides 用的就是这几个值，两边口径得一样：空串＝不覆盖，回落 settings）。
 */
export interface VoiceOverrides {
  /** 本地档：界面模型下拉当前选中的引擎 id */
  localEngine?: string
  /** 界面音色输入当前值（本地档是编号，云端档是服务商的 voice id；空串＝不覆盖） */
  voice?: string
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
      // 不给 settingsTab：这一格就在配音页上，把设置弹到用户脸上反而让他找不到该重选的那一格
      return {
        message: `本地配音的音色要选配音页「音色」里的那一项，当前是「${voice}」。在这一格重选一个编号即可（这串值多半是从旧版本带上来的，不是这次填的）`,
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
      // 豆包那一档不收模型（见下面那一条），这句「把哪几格填好」也得跟着少一样
      ttsVendorNeedsModel(settings?.ttsProvider) ? '接口地址、API Key 和配音模型' : '接口地址和 API Key',
      '；也可以在「校对配置」里填一把 Key 供两边共用，或把「配音引擎」换成「本地配音」'
    )
    return {
      message:
        blocked ??
        '字幕配音需要 API Key：请在「配音配置」里点那一行的「编辑」，在弹窗里填一把 Key 并点「保存」；也可以在「校对配置」里填一把供两边共用',
      settingsTab: 'tts',
    }
  }
  // 只查配音模型这一样，且按「当前生效的那一份」问（口径与主进程 getTTSConfig 一致）：
  // 它从 1.1.0 起住在方案里，页面上没有那一格可填，所以不存在「界面填全了、设置还空着」的分歧。
  // 音色不在这里查——空着是合法调用（见 ttsConfigProblem 那段）。
  // 模型这一问也得跟着厂商走：豆包那一档空着才是对的（原厂写 req_params.model 只给复刻音色用），
  // 在这儿一刀切就是把一个配对了的人拦在门外，而主进程那边根本不拦——判严判松都栽过（#220/#227）。
  if (ttsVendorNeedsModel(settings?.ttsProvider) && !str(settings?.ttsModel)) {
    return {
      message:
        '字幕配音还缺「配音模型」：在「设置 → 配音配置」里点当前那一行的「编辑」，在弹窗里填模型 id 并点「保存」。填错模型的代价是每次调用都白烧一次额度',
      settingsTab: 'tts',
    }
  }
  return null
}

/** 拦住之后：说清原因；出路在设置页的那些顺带把要改的那一栏打开，出路在本页的只弹这一句 */
export function raiseReadinessBlock(block: ReadinessBlock) {
  toast.error(block.message)
  if (block.settingsTab) useSettingsModalStore.getState().open(block.settingsTab)
}
