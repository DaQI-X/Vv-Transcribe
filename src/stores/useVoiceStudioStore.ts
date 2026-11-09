/**
 * 字幕配音工作台状态（Zustand）
 *
 * 为什么状态放这里而不是组件里：配音从弹窗改成页面之后，「切走再切回来」是正常动作，
 * 而一批合成是主进程在跑的分钟级任务。状态跟着组件走，切一次 tab 就丢了进度、
 * 也丢了那批已经花掉的钱换来的产物。
 *
 * 三条口径：
 * - 音色/倍速/本地模型是「这一次任务」的参数，不写回 settings.json：工作台上的试错不该变成用户的长期默认值。
 *   云端配音模型也不在这里——1.1.0 起它跟着「配音方案」整套走，界面只给「换一套」，不给「换这一项」。
 *   「云端还是本地」这一档同样不在可覆盖之列：它决定的是要不要花钱、要不要拉起本机进程，是用户保存过的长期选择。
 * - 本地档的音色只有编号，编号的上限由引擎报（模型没读进内存前谁也不知道有几个），界面上不写死也不编名字。
 * - 中间产物由 jobId 记账，在「重新发起一批」「清空」「离开工作台」三处回收，不靠组件卸载。
 */
import { create } from 'zustand'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { toast } from '@/components/ui/Toast'
import { checkVoiceReady, raiseReadinessBlock } from '@/utils/readiness'
import { splitPlainText } from '@/utils/splitPlainText'
import { LOCAL_TTS_DEFAULT_ENGINE, LOCAL_TTS_ENGINE_OPTIONS } from '@/utils/localTtsEngines'
import { ttsCloneSpec, ttsVendorClonesVoices } from '@/utils/profileSpec'
import { frontendLogger } from '@/utils/logger'
import type { VoiceProgress, VoiceSegment, VoiceSynthesizeResult } from '@/types/voice'
import { useProfileStore } from './useProfileStore'
import { useTranscriptionStore } from './useTranscriptionStore'

/** 首页与工作台共用的顶部 tab：转写的两个入口 + 配音 */
export type StudioTab = 'file' | 'url' | 'voice'
/** 输入来源：自己打的文本（没有时间轴）/ 当前转写段落（按字幕时间轴铺） */
export type VoiceSource = 'text' | 'subtitle'
export type VoicePhase = 'idle' | 'running' | 'done'

/**
 * 「音色」那一格的候选（1.1.2 #340，`tts:voiceList` 回的那一份）。
 * source 是为了在候选里说清出处：厂商内置的那一批，和这个账号自己复刻出来的那一批，
 * 混在一张表里却分不清，用户就会以为复刻音色是厂商提供的公共音色。
 */
export interface VendorVoiceOption {
  id: string
  name: string
  source: 'system' | 'clone'
}

/**
 * 倍速只给固定档位：接口字段是 0.25–4.0 的连续值，但让用户手打 8 只会得到一条废音轨，
 * 而这些档是不是被服务商照单实现由接口说了算（界面把这句写在旁边，不替服务商承诺）。
 */
export const VOICE_SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

/**
 * 成功的段数就是事件里的 index：主进程在「这一段拿到音频」之后才推 synthesizing，index 0 是开工前的占位。
 * reused 是其中「复用缓存、没花钱」的那几段（#362）——它同时算进 done，因为那一段确实有音频了，
 * 但界面必须能把它单说出来：跑 300 段时用户想知道的是这一趟扣了几段的钱，不是总共动了多少段。
 */
interface LiveCount {
  done: number
  failed: number
  skipped: number
  reused: number
}

interface VoiceStudioState {
  tab: StudioTab

  source: VoiceSource
  text: string
  /** 空串＝不覆盖：有保存过的音色就用那个，没有就干脆不把这一项发给接口（有的模型不收音色） */
  voice: string
  speed: number
  /** 本地档选的那一档模型（引擎 id）；空串＝不覆盖，用设置里保存的 */
  engine: string
  /** 配音引擎这一档，来自已保存设置（界面不覆盖它） */
  mode: 'cloud' | 'local'
  /** 只读展示用的那两样，来自设置；含义跟着 mode 变（本地档的音色是编号，模型这一项用不上） */
  configModel: string
  configVoice: string
  /**
   * 「当前使用那一条配音方案」是哪家（1.1.1）。空串＝磁盘上没这一项的老方案，按 OpenAI 兼容读，
   * 界面上的音色那一格要跟着它换说法：MiniMax／百炼不收空音色，那句「留空＝不发这一项」对它们是谎话。
   */
  configProvider: string
  /** 设置里保存的本地档引擎 id，也是模型下拉的当前值（没在界面上改过时） */
  configEngine: string
  /** 本地音色上限：引擎把模型读进内存后 /health 才报得出，0＝还不知道 */
  speakers: number
  /**
   * 各档模型在不在磁盘上：只给下拉里那行「（模型还没下载）」用，不让用户选完才发现要下载。
   * 它是进页面/跑完一次时缓存的那一份，所以不拿它当闸门——闸门走 checkVoiceReady 的现问，
   * 否则用户在别处下载完或手工挪走目录之后，这里会一直按旧账拦人或放人。
   */
  engineModelPresent: Record<string, boolean>
  /**
   * 云端档「音色」那一格的候选（1.1.2 #340）。只有那家有列表接口的厂商（现在是 MiniMax）会给东西，
   * 其余三家与本地档一律空数组——所以空数组的意思是「没有候选可给」，**不是**「这家一个音色都没有」，
   * 界面对它的处理就是照旧手输，一个字都不用多说。
   */
  vendorVoices: VendorVoiceOption[]
  /** 非空＝这家有列表接口、但这一次没问到（Key 空、网络、对方回错误码）。界面换成一行灰字，不弹红条 */
  vendorVoicesError: string | null

  /**
   * 声音复刻那一块（1.1.2 #330）的四个值。它们是「这一次工作台上的动作」，所以与音色/倍速同一档：
   * 不写回 settings.json，切走再回来也不该留着一个已经复刻完的名字让人以为还要再点一次。
   * `cloneFile` 存的是完整路径（主进程要读它），界面上只显示文件名。
   */
  cloneFile: string
  cloneName: string
  cloning: boolean
  /** 非空＝这一次没成，原因照原话摆在那一块里（复刻失败往往要说清是哪一格，toast 一句话装不下） */
  cloneError: string | null
  /**
   * 非空＝上一趟成了，摆的是厂商回执里的音色 id。#347 原本一成功就关窗（理由是「id 已经填进背后那格，
   * 窗里再摆一份是第二个出处」），2026-11-07 用户实测推翻了它：窗一关，人只剩一条几秒的 toast，
   * 当场要核对的那个 id 反而没地方看——而复刻是唯一一个「产物是一串别人给的编号」的动作。
   * 所以成功态留在这扇窗里，直到用户自己关。
   */
  cloneResult: string
  /**
   * 单独指定这一趟复刻打的地址（#346）。空串＝用配音方案那一格洗回根的那一份。
   * 它和音色、倍速同一档：只作用于这一次，不落盘，也不动配音方案里那一格。
   */
  cloneEndpoint: string
  /** 待会儿真打的那几条地址，按发出的先后。由主进程算：那份推导不许有第二处 */
  cloneTargets: string[]

  phase: VoicePhase
  /** 这一批实际提交出去的段，进行中按段号回显文本用；用户中途改输入不影响它 */
  queue: VoiceSegment[]
  jobId: string | null
  progress: VoiceProgress | null
  live: LiveCount
  result: VoiceSynthesizeResult | null
  preview: { filePath: string; duration: number } | null
  previewing: boolean
  cancelRequested: boolean
  saving: boolean

  setTab: (tab: StudioTab) => void
  setSource: (source: VoiceSource) => void
  setText: (text: string) => void
  setVoice: (voice: string) => void
  setEngine: (engine: string) => void
  setSpeed: (speed: number) => void
  loadConfig: () => Promise<void>
  refreshVendorVoices: () => Promise<void>
  setCloneName: (name: string) => void
  /** 换那一格地址，并重取一次「待会儿打到哪几条」 */
  setCloneEndpoint: (endpoint: string) => void
  /** 问主进程这一趟会打到哪几条地址（#346，纯展示，不联网、不发消息） */
  refreshCloneEndpoints: () => Promise<void>
  /** 弹原生面板选一段要拿去复刻的音频；取消或这一家不支持时什么都不改 */
  pickCloneAudio: () => Promise<void>
  /**
   * 真发一次复刻。成功后把回执里的 voiceId 填进「音色」那一格，并重取一次候选。
   * 回的是「这一次成没成」——成与没成都由弹窗自己决定收场：成了留着显示那个 id，没成留着那句原话。
   */
  runVoiceClone: () => Promise<boolean>
  /** 重新打开弹窗时清掉上一趟的回执：那一串 id 说的是**上一次**复刻，别让新一次开局就挂着一个旧答案 */
  resetCloneResult: () => void
  setProfile: (profileId: string) => Promise<void>
  previewOne: () => Promise<void>
  buildQueue: () => VoiceSegment[]
  start: () => Promise<void>
  cancel: () => Promise<void>
  save: () => Promise<void>
  clearResult: () => void
  /** 清空输入框里那份文稿（连带它派生的试听片段）；已经配出来的那条轨不动 */
  clearDraft: () => void
  /** 回到上传视图（首页/换一份稿子）：跑完的那批当场回收，正在跑的那批不动 */
  backToUpload: () => void
  /** 回收这一批的中间产物临时目录（清空结果、重开一批、回首页时用；切 tab 不回收，产物要留着能回来听） */
  releaseBatch: () => void
  applyProgress: (data: VoiceProgress) => void
}

const emptyLive: LiveCount = { done: 0, failed: 0, skipped: 0, reused: 0 }

/** 进度订阅只挂一次（模块级，不放 state）：store 是单例，监听跟着它活到渲染进程结束 */
let progressUnsubscribe: (() => void) | null = null

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 单次调用的三个可覆盖参数。空串一律「不覆盖」，由主进程按已保存的设置取值——
 * 界面没填的东西不该在这里替用户猜一个（尤其音色：VITS 的 0 和 Kokoro 的 0 不是同一个人，
 * 而云端有的模型压根不收音色）。
 * 同一份也交给 checkVoiceReady：拦人的那道问的参数，必须和真跑起来用的参数是同一份，
 * 否则会出现「按设置拦下、按界面跑通」这种两头都说不清的失败。
 */
function callOptions(state: { voice: string; speed: number; engine: string }) {
  return {
    voice: state.voice,
    speed: state.speed,
    localEngine: state.engine,
  }
}

/**
 * 历史记录（#247）里这一行叫什么。主进程收到的只有段落正文，它分不清这份稿子是手打的
 * 还是从哪份素材转出来的，所以这个名字只能由界面报上去。素材名读的是转写那份 store——
 * 「按字幕时间轴配音」用的就是它那一串段落，两条链路说的是同一份素材。
 */
function draftName(source: VoiceSource): string {
  if (source !== 'subtitle') return '手输文本'
  return useTranscriptionStore.getState().fileName ?? '转写素材'
}

function ensureProgressSubscription() {
  if (progressUnsubscribe) return
  const api = getElectronAPI()
  if (!api) return
  progressUnsubscribe = api.onVoiceProgress((data) => {
    useVoiceStudioStore.getState().applyProgress(data)
  })
}

/**
 * 问一次本地档的状态：这一档有几个音色，和两档的模型各自在不在磁盘上。
 * 查状态不会把引擎拉起来（懒启动），所以进页面就查不花钱；音色数也不等引擎——引擎还没把模型
 * 读进内存时主进程按那份钉死 sha256 的模型表回实测值（VITS 5 个），只有没核实过的档位才回 0，
 * 那是「还不知道」而不是「只有一个」。真跑过一次之后再查一遍，实报的数会覆盖表里那份。
 */
async function refreshLocalVoiceState(requested: string) {
  const api = getElectronAPI()
  if (!api) return
  const ids = LOCAL_TTS_ENGINE_OPTIONS.map((option) => option.value)
  const statuses = await Promise.all(ids.map((id) => api.getLocalVoiceStatus(id).catch(() => null)))
  const engineModelPresent: Record<string, boolean> = {}
  ids.forEach((id, index) => {
    engineModelPresent[id] = statuses[index]?.modelPresent === true
  })
  const current = statuses[ids.indexOf(requested)]
  useVoiceStudioStore.setState({
    engineModelPresent,
    // 音色数量只认「当前要用的这一档」报的数：换档时上一档的数不能沿用
    speakers: current?.speakers ?? 0,
  })
}

export const useVoiceStudioStore = create<VoiceStudioState>((set, get) => ({
  tab: 'file',

  source: 'text',
  text: '',
  voice: '',
  speed: 1,
  engine: '',
  mode: 'cloud',
  configModel: '',
  configVoice: '',
  configProvider: 'openai',
  configEngine: LOCAL_TTS_DEFAULT_ENGINE,
  speakers: 0,
  engineModelPresent: {},
  vendorVoices: [],
  vendorVoicesError: null,
  cloneFile: '',
  cloneName: '',
  cloning: false,
  cloneError: null,
  cloneResult: '',
  cloneEndpoint: '',
  cloneTargets: [],

  phase: 'idle',
  queue: [],
  jobId: null,
  progress: null,
  live: emptyLive,
  result: null,
  preview: null,
  previewing: false,
  cancelRequested: false,
  saving: false,

  setTab: (tab) => {
    const from = get().tab
    // 切页这件事以前只有结果（日志里 FileUploader 重新挂载），没有原因：
    // 「谁把用户从配音页甩出去了」只能靠猜。加上 from→to 之后，这一行和 `App | Renderer document loaded`
    // 是两条互斥的分叉——有这一行是先点了一下，只出现后者是渲染层自己重载了一次。
    if (from !== tab) frontendLogger.userAction('Studio tab switched', { from, to: tab })
    set({ tab })
    // 每次进配音页都重读一次设置：用户可能刚在「配音配置」里换了方案，或换了本地引擎那一档的模型
    if (tab === 'voice') void get().loadConfig()
  },

  setSource: (source) => set({ source }),
  setText: (text) => set({ text }),
  setVoice: (voice) => set({ voice }),
  setSpeed: (speed) => set({ speed }),

  /**
   * 换本地模型（引擎）时把音色清空并重新问一次状态：
   * sid 是「这一档模型里的第几个说话人」，VITS 的 3 和 Kokoro 的 3 不是同一个声音，
   * 带着旧引擎的编号切过去，用户听到的不是他刚才试听通过的那把嗓子。
   */
  setEngine: (engine) => {
    set({ engine, voice: '', speakers: 0 })
    void refreshLocalVoiceState(engine)
  },

  loadConfig: async () => {
    const api = getElectronAPI()
    if (!api) return
    let mode: 'cloud' | 'local' = 'cloud'
    let requested = LOCAL_TTS_DEFAULT_ENGINE
    try {
      const settings = await api.getSettings()
      // 与主进程 normalizeTtsEngine 同口径：认不出的一律按云端处理，不替用户猜
      mode = str(settings?.ttsEngine) === 'local' ? 'local' : 'cloud'
      const saved = str(settings?.ttsLocalEngine)
      // 下拉的当前值必须在选项里，否则渲染成空白：主进程那边也是这么回落到默认档的
      requested = LOCAL_TTS_ENGINE_OPTIONS.some((option) => option.value === saved)
        ? saved
        : LOCAL_TTS_DEFAULT_ENGINE
      set({
        mode,
        configEngine: requested,
        // 两档各读各的字段：本地档的「音色」是编号，云端档的是服务商的音色名，
        // 把它们混成一个 configVoice 就会把云端残留的 alloy 显示成本地编号
        configModel: mode === 'local' ? '' : str(settings?.ttsModel),
        configVoice: mode === 'local' ? str(settings?.ttsLocalVoice) : str(settings?.ttsVoice),
        configProvider: str(settings?.ttsProvider),
      })
      // 读设置失败回的是 null（IPC 收口后不再 reject，见 ipc/guard.ts），而 null 会落成上面那个云端档：
      // 设置里明明选了本地配音，这里却显示走云端接口。不说这一句，用户会去云端的地址框里
      // 找一个根本不存在的问题
      if (settings === null) {
        toast.info('配音设置读不出来，本页先按云端档显示；去设置里重新保存一次可恢复', 10000)
      }
    } catch {
      set({ mode, configModel: '', configVoice: '', configProvider: '', configEngine: requested })
    }
    if (mode === 'local') await refreshLocalVoiceState(get().engine || requested)
    else await get().refreshVendorVoices()
    // 「这一趟复刻打到哪几条」跟着方案与那一格地址变，读设置时顺手取一次；主进程纯算，不联网
    await get().refreshCloneEndpoints()
    // 方案列表和设置是两回事：设置读不出（null）不代表列表读不出，反过来也一样。
    // 列表那份归 useProfileStore（三档共用，见那个文件头），换完方案必须跟着重读一次，
    // 否则下拉里挂的还是切之前的「当前使用」。
    await useProfileStore.getState().load()
  },

  /**
   * 重取「音色」那一格的候选（#340）。挂在 `loadConfig` 上而不是自己起一个 effect：
   * 进页面与换方案都会走到 loadConfig，这两处正好是需要重取的两个时机，
   * 而 effect 得自己盯住 mode/profileId 两个依赖，漏一个就会挂着上一套的候选。
   *
   * 这一条从不弹 toast、也从不拦任何操作：候选只是便利，取不到那一格就是原来的手输框。
   */
  refreshVendorVoices: async () => {
    const api = getElectronAPI()
    if (!api) return
    const { mode } = get()
    if (mode !== 'cloud') {
      set({ vendorVoices: [], vendorVoicesError: null })
      return
    }
    const result = await api.listVoices()
    // ok:false + error:null＝这一家没有可问的地方，静默清掉上一套留下的候选：
    // 换到不收名单的那家还挂着 MiniMax 的音色，正是 #327 那种「界面写着 A、发出去是 B」
    if (!result?.ok) {
      set({ vendorVoices: [], vendorVoicesError: result?.error ?? null })
      return
    }
    set({ vendorVoices: result.voices ?? [], vendorVoicesError: null })
  },

  setCloneName: (name) => set({ cloneName: name, cloneError: null, cloneResult: '' }),

  /**
   * 问主进程「这一趟会打到哪几条」（#346）。这一条从不弹 toast、也从不拦复刻：那一行只是把主进程
   * 已经存在的那份推导念给人看。宁可问一次也不在渲染层拼，是因为拼法一旦有两处，界面就可能说一句
   * 和请求不一致的话——而照着错的那句去排查，比不念更糟（#327 那轮的症状正是界面写着 A、发出去是 B）。
   */
  refreshCloneEndpoints: async () => {
    const api = getElectronAPI()
    if (!api) return
    const { mode, cloneEndpoint, configProvider } = get()
    // 本地档没有复刻这回事，不支持的那两家主进程也回空数组——两边都不用多问一次
    if (mode !== 'cloud' || !ttsVendorClonesVoices(configProvider)) {
      set({ cloneTargets: [] })
      return
    }
    const result = await api.cloneEndpoints({ endpointOverride: cloneEndpoint.trim() })
    set({ cloneTargets: result?.urls ?? [] })
  },

  setCloneEndpoint: (endpoint) => {
    set({ cloneEndpoint: endpoint, cloneError: null })
    void get().refreshCloneEndpoints()
  },

  /**
   * 选一段要拿去复刻的音频。这一条不自己判「这一家支不支持」：主进程按已保存的方案判，
   * 不支持就回 null，界面那一块本来也不摆（按 `ttsVendorClonesVoices`）。
   * 换了文件就清掉上一次的失败原因——那句话说的多半是**上一个文件**哪里不合规矩，
   * 留着它等于让新选的这个文件背一句不属于它的诊断。
   *
   * 顺手把主进程给的建议名填进「新音色 ID」那一格，但只在格子空着时填：用户已经自己起了名，
   * 再选一次文件不该把他的名字换掉。这一步是 #349 的交互核心——2026-11-07 用户的理解一直是
   * 「选完录音，id 就该出现在框里」，而原本这一格要他先自己想一个名字。
   */
  pickCloneAudio: async () => {
    const api = getElectronAPI()
    if (!api || get().cloning) return
    const picked = await api.pickCloneAudio()
    if (!picked) return
    set({
      cloneFile: picked.filePath,
      cloneError: null,
      cloneResult: '',
      cloneName: get().cloneName.trim() === '' ? picked.suggestedName : get().cloneName,
    })
  },

  /**
   * 真发一次复刻。两件收尾都不能省：
   * - 「音色」那一格填的是**回执里的** voiceId：百炼那一家它是对方拼出来的（模型-前缀-唯一标识），
   *   拿用户刚填的前缀当音色用，后面每次合成都会失败在「没有这个音色」上；
   * - 重取一次候选：MiniMax 复刻出来的那把会出现在列音色接口的 `voice_cloning` 里（#340 标成「自己复刻」），
   *   重取之后用户在候选里看得见自己刚建的那一条，而不是只信我们一句 toast。
   *
   * 复刻本身在两家都不收合成费（MiniMax 按音色数量算资产、百炼建音色不收费，收的是之后用它合成那些字），
   * 所以这里不做配音批次那种费用确认；但它**不可逆**——账号里多出来的那把音色只能去对方控制台删。
   * `endpointOverride` 只作用于这一趟（#346）：中转网关常只转发配音那条端点，那一格留空就是把
   * 「配音的地址」当成「复刻的地址」用。它不落盘，也不动配音方案里那一格。
   */
  runVoiceClone: async () => {
    const api = getElectronAPI()
    if (!api) return false
    const { cloneFile, cloneName, cloneEndpoint, cloning, configProvider } = get()
    if (cloning) return false
    // 这两句在 #347 之后一直是走不到的死话：那颗按钮原本 `disabled={!ready}`，而 ready 收的就是
    // 同样这两项——缺什么的时候按钮根本点不动，于是用户看到的只有「点了没反应」（2026-11-07 实测）。
    // 现在按钮只在真的在跑时禁用，缺项由这两句当场说，界面上不再有一层默默吞掉点击的闸门。
    // 两句都点名界面上的那个控件或那一格，因为「先起个名」这种说法在#349 之后已经不属于界面：
    // 名字选完录音就自动填好了，格子空着只可能是用户自己清掉的
    if (!cloneFile) {
      const reason = '先点「选一段录音」挑一个文件——这一步只在本地挑，还没发出去'
      set({ cloneError: reason, cloneResult: '' })
      toast.error(reason, 6000)
      return false
    }
    if (!cloneName.trim()) {
      const reason = `先把「${ttsCloneSpec(configProvider)?.nameLabel ?? '新音色 ID'}」那一格填上`
      set({ cloneError: reason, cloneResult: '' })
      toast.error(reason, 6000)
      return false
    }
    set({ cloning: true, cloneError: null, cloneResult: '' })
    const result = await api.cloneVoice({
      filePath: cloneFile,
      name: cloneName.trim(),
      endpointOverride: cloneEndpoint.trim(),
    })
    if (!result?.ok || !result.voiceId) {
      set({ cloning: false, cloneError: result?.error ?? '复刻没成功，主进程没给原因' })
      toast.error(result?.error ?? '复刻没成功，主进程没给原因', 10000)
      return false
    }
    // 草稿清空、但把回执留在 cloneResult 里给弹窗摆：这一趟的输入已经不欠什么了，
    // 而那个 id 是用户接下来要抄去别处用的东西
    set({
      cloning: false,
      cloneError: null,
      cloneFile: '',
      cloneName: '',
      cloneResult: result.voiceId,
      voice: result.voiceId,
    })
    toast.success(`复刻好了，「音色」那一格已经填上 ${result.voiceId}`, 8000)
    await get().refreshVendorVoices()
    return true
  },

  resetCloneResult: () => set({ cloneResult: '', cloneError: null }),

  /**
   * 这一页的「配音方案」下拉：选中的那条＝把配音档的**当前使用**换过去。
   * 落盘、话术、失败分支都在 useProfileStore.setProfile 那一个动作里（校对那一格走的是
   * 同一条），这里只留配音这一档独有的收尾。
   * 为什么这不是「这一次配音用哪套」的覆盖：「云端还是本地」在重写第⑧步之后是**全局段**那一份
   * `ttsEngine`，不在任何一条方案里，而这一档本页刻意不给选——它决定花不花钱、要不要拉起本机进程
   * （见文件头 #238 那段）。做成当场覆盖等于把那扇门从侧面推开；做成「设为当前使用」，
   * 用户看到的还是同一个长期选择换了哪条。
   */
  setProfile: async (profileId) => {
    const { phase, previewing } = get()
    // 跑着的那一批用的是开跑时读好的那套；试听也是同一条链路（引擎可能被这个动作下面的重读打断）
    if (phase === 'running' || previewing) return
    // 切换在途那一层由 store 的那个动作自己挡（三档共用同一个标记）
    if (!(await useProfileStore.getState().setProfile('tts', profileId))) return
    // 单次参数是照着**原来那套**挑的：配音模型就在方案里，跟着整套换掉，页面上那次临时改动
    // 已经不属于新这一套；音色不在方案里（1.1.0 起它是全局那一份），清空只是把手输的覆盖收回，
    // 改由下面这次 loadConfig 重读的那一份接管。留着就会出现「下拉里挂着 A 套挑的音色、
    // 实际按 B 套跑」这种最难解释的分歧。倍速不在方案字段里，是这一页自己的参数，留着。
    // 复刻那一块也一起收：它是照着**原来那家**的规矩填的（MiniMax 要一个 8–256 的音色 id，
    // 百炼只要一个 ≤10 字符的前缀），换到另一家那些值全不成立，留着就是让人拿旧名字点一次注定被拒的复刻
    set({
      voice: '',
      engine: '',
      speakers: 0,
      cloneFile: '',
      cloneName: '',
      cloneError: null,
      cloneResult: '',
      cloneEndpoint: '',
    })
    // 换完必须重读设置：下面那行「配音引擎：云端/本地 · 模型 X」和 checkVoiceReady 走的都是这一份
    await get().loadConfig()
  },

  buildQueue: () => {
    const { source, text } = get()
    if (source === 'subtitle') {
      return useTranscriptionStore
        .getState()
        .segments.filter((segment) => !!segment && segment.text.trim() !== '')
        .map((segment) => ({
          id: segment.id,
          startTime: segment.startTime,
          endTime: segment.endTime,
          text: segment.text.trim(),
        }))
    }
    // 纯文本没有时间轴：起止都给 0，主进程的排布就成了「首尾相接」，一段挨着一段念
    return splitPlainText(text).map((chunk, index) => ({
      id: `text-${index + 1}`,
      startTime: 0,
      endTime: 0,
      text: chunk,
    }))
  },

  previewOne: async () => {
    const api = getElectronAPI()
    if (!api) return
    const queue = get().buildQueue()
    if (queue.length === 0) {
      toast.info('先给它一点文本')
      return
    }
    // 试听与「开始配音」撞同一道门：#265 之前这里只看模型，引擎二进制没下载时点试听
    // 会一路掉到主进程的兜底文案——那句是给人看机器话的最后一道保险，不该是用户第一次
    // 看到「还差引擎」的地方。走 readiness 才能给出「去哪一行下载」并把设置页开到那一栏。
    const blocked = await checkVoiceReady(callOptions(get()))
    if (blocked) {
      raiseReadinessBlock(blocked)
      return
    }
    set({ previewing: true })
    try {
      const res = await api.previewVoice(queue[0].text, callOptions(get()))
      if (res.error) {
        set({ preview: null })
        toast.error(res.error)
        return
      }
      if (res.clip) {
        set({ preview: { filePath: res.clip.filePath, duration: res.clip.duration } })
        toast.success(
          res.clip.duration > 0
            ? `试听已生成，${res.clip.duration.toFixed(1)} 秒`
            : '试听已生成（这条没读到时长，不影响播放）',
        )
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '试听失败')
    } finally {
      set({ previewing: false })
      // 本地档：试听跑过之后模型一定已经进内存了，这时再问一次才拿得到全部音色编号
      if (get().mode === 'local') void refreshLocalVoiceState(get().engine || get().configEngine)
    }
  },

  start: async () => {
    const api = getElectronAPI()
    if (!api) return
    const queue = get().buildQueue()
    if (queue.length === 0) {
      toast.info(get().source === 'subtitle' ? '没有非空段落，没什么可以配音' : '先输入要配音的文本')
      return
    }
    const blocked = await checkVoiceReady(callOptions(get()))
    if (blocked) {
      raiseReadinessBlock(blocked)
      return
    }

    // 上一批不留着：重新发起意味着上一版产物不再需要，中间片段是几十上百个文件
    get().releaseBatch()

    ensureProgressSubscription()
    set({
      phase: 'running',
      queue,
      jobId: null,
      progress: null,
      live: emptyLive,
      result: null,
      cancelRequested: false,
    })

    try {
      const res = await api.synthesizeVoice(queue, {
        ...callOptions(get()),
        sourceName: draftName(get().source),
      })
      set({ result: res, phase: 'done', jobId: res.jobId, progress: null })
      // 复用了几段必须说在这一句里（#362）：「完成 300 段」听起来像烧了 300 段的钱，
      // 而真实情况可能是 297 段一分没花——这一版功能的意义就在这句反馈上，不说等于没做
      const costLine = res.reused > 0 ? `复用 ${res.reused} 段、新合成 ${res.clipCount - res.reused} 段` : ''
      if (res.error) toast.error(res.error)
      else if (res.abortedReason) toast.error(res.abortedReason)
      else if (res.canceled)
        toast.info(
          `已取消，已完成的 ${res.clipCount} 段拼成了一条轨${costLine ? `（${costLine}）` : ''}`
        )
      else if (costLine) toast.success(`字幕配音完成，${res.clipCount} 段：${costLine}`, 8000)
      else toast.success(`字幕配音完成，${res.clipCount} 段`)
    } catch (err) {
      set({ phase: 'idle', queue: [] })
      toast.error(err instanceof Error ? err.message : '字幕配音没能跑完')
    } finally {
      if (get().mode === 'local') void refreshLocalVoiceState(get().engine || get().configEngine)
    }
  },

  cancel: async () => {
    const api = getElectronAPI()
    if (!api) return
    const { jobId } = get()
    // 第一段还在飞的时候 jobId 还没推回来，这时先置标志等它；不这么处理就只能等下一段
    if (!jobId) {
      set({ cancelRequested: true })
      return
    }
    const res = await api.cancelVoiceJob(jobId)
    if (res.error) {
      // 取消这一步自己出错了，不能塞进下面那三条分支：
      // 分支是按 reason 走的，收口后的失败值只能给一个占位的 'gone'，说出来就是「这批任务已经不在了」那句谎
      toast.error(`取消没落进去：${res.error}`)
    } else if (res.reason === 'stopped') {
      set({ cancelRequested: true })
      toast.info('已请求取消，正在收尾')
    } else if (res.reason === 'late') {
      // 这一步不再置 cancelRequested：置了界面就写「正在取消…」，而拼接照旧跑完，等于跟着一起骗人
      toast.info(
        '逐段那一步已经跑完了，现在是本地 ffmpeg 在拼这一条轨——不再调接口、不再花钱，也停不下来。' +
          '等它跑完，轨照常给你（已经合成好的段扔掉就白费了）',
        9000
      )
    } else {
      toast.error('这批任务已经不在了')
    }
  },

  save: async () => {
    const api = getElectronAPI()
    const { result } = get()
    if (!api || !result?.jobId) return
    set({ saving: true })
    try {
      const res = await api.saveVoiceTrack(result.jobId)
      if (res.canceled) return
      if (res.success) toast.success(`已保存 ${res.name}`)
      else toast.error(res.error || '保存失败')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      set({ saving: false })
    }
  },

  clearResult: () => {
    get().releaseBatch()
    // 试听目录主进程只留一份（下一次试听会自己回收上一份），但用户明确说「清空」时就当场还掉
    void getElectronAPI()?.releaseVoicePreview()
    set({
      phase: 'idle',
      result: null,
      jobId: null,
      progress: null,
      live: emptyLive,
      queue: [],
      cancelRequested: false,
      preview: null,
    })
  },

  backToUpload: () => {
    if (get().phase === 'done') get().clearResult()
    // 走 setTab 而不是直接 set：切页那条 from→to 日志只有一个出处，不会这一支记、那一支不记
    get().setTab('file')
  },

  /**
   * 清空文稿：输入框是这一页唯一的「上一版」，想重来不该靠手选删除。
   * 两条边界：产物与队列都不动——那是已经跑过的东西（云端花过钱、本地跑过引擎），
   * 删它另有入口（结果卡那颗「清空」）；「从转写带入」那份文稿来自转写结果，
   * 这一键清不动它，也不该去动，否则点一下就删了用户的转写稿。
   */
  clearDraft: () => {
    const { phase, source, text, preview } = get()
    if (phase === 'running' || source !== 'text') return
    if (text.trim() === '' && !preview) return
    // 试听片段是那句文稿的派生物：文稿没了还留着播放器，等于给一段已经不存在的文本挂着一段音频
    if (preview) void getElectronAPI()?.releaseVoicePreview()
    set({ text: '', preview: null })
  },

  releaseBatch: () => {
    const api = getElectronAPI()
    const { jobId } = get()
    if (!api || !jobId) return
    void api.releaseVoiceBatch(jobId)
  },

  applyProgress: (data) => {
    set((prev) => {
      const live = { ...prev.live }
      if (data.stage === 'synthesizing') live.done = data.index
      // 复用与真合成在「这一段有音频了」上是同一件事，所以 done 一样往前推；
      // 单独记一笔 reused 才说得出这一趟花了几段的钱（#362）
      else if (data.stage === 'reused') {
        live.done = data.index
        live.reused += 1
      } else if (data.stage === 'failed') live.failed += 1
      else if (data.stage === 'skipped') live.skipped += 1
      return { jobId: data.jobId, progress: data, live }
    })
    // 用户点取消时 jobId 可能还没推回来（第一段还在接口那边），那时只置了标志；
    // 现在拿到 id 了，每来一条进度就补发一次，主进程那边是幂等的
    if (!get().cancelRequested) return
    if (
      data.stage === 'synthesizing' ||
      data.stage === 'reused' ||
      data.stage === 'failed' ||
      data.stage === 'skipped'
    ) {
      void getElectronAPI()?.cancelVoiceJob(data.jobId)
    }
  },
}))
