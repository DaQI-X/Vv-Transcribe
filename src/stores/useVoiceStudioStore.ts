/**
 * 字幕配音工作台状态（Zustand）
 *
 * 为什么状态放这里而不是组件里：配音从弹窗改成页面之后，「切走再切回来」是正常动作，
 * 而一批合成是主进程在跑的分钟级任务。状态跟着组件走，切一次 tab 就丢了进度、
 * 也丢了那批已经花掉的钱换来的产物。
 *
 * 三条口径：
 * - 音色/倍速/模型/本地引擎是「这一次任务」的参数，不写回 settings.json：工作台上的试错不该变成用户的长期默认值。
 *   「云端还是本地」这一档不在可覆盖之列——它决定的是要不要花钱、要不要拉起本机进程，是用户保存过的长期选择。
 * - 本地档的音色只有编号，编号的上限由引擎报（模型没读进内存前谁也不知道有几个），界面上不写死也不编名字。
 * - 中间产物由 jobId 记账，在「重新发起一批」「清空」「离开工作台」三处回收，不靠组件卸载。
 */
import { create } from 'zustand'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { toast } from '@/components/ui/Toast'
import { checkVoiceReady, raiseReadinessBlock } from '@/utils/readiness'
import { splitPlainText } from '@/utils/splitPlainText'
import { LOCAL_TTS_DEFAULT_ENGINE, LOCAL_TTS_ENGINE_OPTIONS, missingModelHint } from '@/utils/localTtsEngines'
import type { VoiceProgress, VoiceSegment, VoiceSynthesizeResult } from '@/types/voice'
import { useTranscriptionStore } from './useTranscriptionStore'

/** 首页与工作台共用的顶部 tab：转写的两个入口 + 配音 */
export type StudioTab = 'file' | 'url' | 'voice'
/** 输入来源：自己打的文本（没有时间轴）/ 当前转写段落（按字幕时间轴铺） */
export type VoiceSource = 'text' | 'subtitle'
export type VoicePhase = 'idle' | 'running' | 'done'

/**
 * 倍速只给固定档位：接口字段是 0.25–4.0 的连续值，但让用户手打 8 只会得到一条废音轨，
 * 而这些档是不是被服务商照单实现由接口说了算（界面把这句写在旁边，不替服务商承诺）。
 */
export const VOICE_SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

/** 成功的段数就是事件里的 index：主进程在「这一段拿到音频」之后才推 synthesizing，index 0 是开工前的占位 */
interface LiveCount {
  done: number
  failed: number
  skipped: number
}

interface VoiceStudioState {
  tab: StudioTab

  source: VoiceSource
  text: string
  /** 空串＝不覆盖，按「设置 → 配音配置」里那个音色走 */
  voice: string
  speed: number
  /** 云端档手输的配音模型 id；空串＝不覆盖 */
  model: string
  /** 本地档选的那一档模型（引擎 id）；空串＝不覆盖，用设置里保存的 */
  engine: string
  /** 配音引擎这一档，来自已保存设置（界面不覆盖它） */
  mode: 'cloud' | 'local'
  /** 只读展示用的那两样，来自设置；含义跟着 mode 变（本地档的音色是编号，模型这一项用不上） */
  configModel: string
  configVoice: string
  /** 设置里保存的本地档引擎 id，也是模型下拉的当前值（没在界面上改过时） */
  configEngine: string
  /** 本地音色上限：引擎把模型读进内存后 /health 才报得出，0＝还不知道 */
  speakers: number
  /** 各档模型在不在磁盘上：下拉里那行「还没下载」按它标，不让用户选完才发现要下载 */
  engineModelPresent: Record<string, boolean>

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
  setModel: (model: string) => void
  setEngine: (engine: string) => void
  setSpeed: (speed: number) => void
  loadConfig: () => Promise<void>
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

const emptyLive: LiveCount = { done: 0, failed: 0, skipped: 0 }

/** 进度订阅只挂一次（模块级，不放 state）：store 是单例，监听跟着它活到渲染进程结束 */
let progressUnsubscribe: (() => void) | null = null

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 单次调用的四个可覆盖参数。空串一律「不覆盖」，由主进程按已保存的设置取值——
 * 界面没填的东西不该在这里替用户猜一个（尤其音色：VITS 的 0 和 Kokoro 的 0 不是同一个人）。
 */
function callOptions(state: { voice: string; speed: number; model: string; engine: string }) {
  return {
    voice: state.voice,
    speed: state.speed,
    model: state.model,
    localEngine: state.engine,
  }
}

/**
 * 本地档：界面上选中的那一档模型在不在磁盘上。
 * 这一问必须问「界面当前选的」而不是「设置里保存的」——用户在配音页换了档，
 * 前置校验（readiness）读的还是设置那一份，两边对不上就会出现「拦下了能干的、放过了干不了的」。
 * 不在时回它的 id，调用方据此提示去哪下载；engineModelPresent 还没填（第一次状态没读回来）时回空，
 * 按「不拦」处理——那只是还没查到，不是查到了缺。
 */
function missingLocalModel(state: VoiceStudioState): string {
  if (state.mode !== 'local') return ''
  const selected = state.engine || state.configEngine
  return state.engineModelPresent[selected] === false ? selected : ''
}

/** 拦下缺件时的那句 toast：说清缺哪一档模型、下一步怎么走，别让用户自己找 */
function missingModelToast(engineId: string): string {
  return `本地配音跑不了：${missingModelHint(engineId)}`
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
  model: '',
  engine: '',
  mode: 'cloud',
  configModel: '',
  configVoice: '',
  configEngine: LOCAL_TTS_DEFAULT_ENGINE,
  speakers: 0,
  engineModelPresent: {},

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
    set({ tab })
    // 每次进配音页都重读一次设置：用户可能刚在「配音配置」里换了模型或音色
    if (tab === 'voice') void get().loadConfig()
  },

  setSource: (source) => set({ source }),
  setText: (text) => set({ text }),
  setVoice: (voice) => set({ voice }),
  setModel: (model) => set({ model }),
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
      mode = str(settings.ttsEngine) === 'local' ? 'local' : 'cloud'
      const saved = str(settings.ttsLocalEngine)
      // 下拉的当前值必须在选项里，否则渲染成空白：主进程那边也是这么回落到默认档的
      requested = LOCAL_TTS_ENGINE_OPTIONS.some((option) => option.value === saved)
        ? saved
        : LOCAL_TTS_DEFAULT_ENGINE
      set({
        mode,
        configEngine: requested,
        // 两档各读各的字段：本地档的「音色」是编号，云端档的是服务商的音色名，
        // 把它们混成一个 configVoice 就会把云端残留的 alloy 显示成本地编号
        configModel: mode === 'local' ? '' : str(settings.ttsModel),
        configVoice: mode === 'local' ? str(settings.ttsLocalVoice) : str(settings.ttsVoice),
      })
    } catch {
      set({ mode, configModel: '', configVoice: '', configEngine: requested })
    }
    if (mode === 'local') await refreshLocalVoiceState(get().engine || requested)
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
    const absent = missingLocalModel(get())
    if (absent) {
      toast.error(missingModelToast(absent))
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
    const blocked = await checkVoiceReady()
    if (blocked) {
      raiseReadinessBlock(blocked)
      return
    }
    const absent = missingLocalModel(get())
    if (absent) {
      toast.error(missingModelToast(absent))
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
      const res = await api.synthesizeVoice(queue, callOptions(get()))
      set({ result: res, phase: 'done', jobId: res.jobId, progress: null })
      if (res.error) toast.error(res.error)
      else if (res.abortedReason) toast.error(res.abortedReason)
      else if (res.canceled) toast.info(`已取消，已完成的 ${res.clipCount} 段拼成了一条轨`)
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
    if (res.reason === 'stopped') {
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
    set({ tab: 'file' })
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
      else if (data.stage === 'failed') live.failed += 1
      else if (data.stage === 'skipped') live.skipped += 1
      return { jobId: data.jobId, progress: data, live }
    })
    // 用户点取消时 jobId 可能还没推回来（第一段还在接口那边），那时只置了标志；
    // 现在拿到 id 了，每来一条进度就补发一次，主进程那边是幂等的
    if (!get().cancelRequested) return
    if (data.stage === 'synthesizing' || data.stage === 'failed' || data.stage === 'skipped') {
      void getElectronAPI()?.cancelVoiceJob(data.jobId)
    }
  },
}))
