/**
 * 字幕配音工作台状态（Zustand）
 *
 * 为什么状态放这里而不是组件里：配音从弹窗改成页面之后，「切走再切回来」是正常动作，
 * 而一批合成是主进程在跑的分钟级任务。状态跟着组件走，切一次 tab 就丢了进度、
 * 也丢了那批已经花掉的钱换来的产物。
 *
 * 两条口径：
 * - 音色/倍速是「这一次任务」的参数，不写回 settings.json：工作台上的试错不该变成用户的长期默认值。
 * - 中间产物由 jobId 记账，在「重新发起一批」「清空」「离开工作台」三处回收，不靠组件卸载。
 */
import { create } from 'zustand'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { toast } from '@/components/ui/Toast'
import { checkVoiceReady, raiseReadinessBlock } from '@/utils/readiness'
import { splitPlainText } from '@/utils/splitPlainText'
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
  /** 只读展示用的那两样，来自设置 */
  configModel: string
  configVoice: string

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
  setSpeed: (speed: number) => void
  loadConfig: () => Promise<void>
  previewOne: () => Promise<void>
  buildQueue: () => VoiceSegment[]
  start: () => Promise<void>
  cancel: () => Promise<void>
  save: () => Promise<void>
  clearResult: () => void
  /** 回到上传视图（首页/换一份稿子）：跑完的那批当场回收，正在跑的那批不动 */
  backToUpload: () => void
  /** 回收这一批的中间产物临时目录（清空结果、重开一批、回首页时用；切 tab 不回收，产物要留着能回来听） */
  releaseBatch: () => void
  applyProgress: (data: VoiceProgress) => void
}

const emptyLive: LiveCount = { done: 0, failed: 0, skipped: 0 }

/** 进度订阅只挂一次（模块级，不放 state）：store 是单例，监听跟着它活到渲染进程结束 */
let progressUnsubscribe: (() => void) | null = null

function ensureProgressSubscription() {
  if (progressUnsubscribe) return
  const api = getElectronAPI()
  if (!api) return
  progressUnsubscribe = api.onVoiceProgress((data) => {
    useVoiceStudioStore.getState().applyProgress(data)
  })
}

export const useVoiceStudioStore = create<VoiceStudioState>((set, get) => ({
  tab: 'file',

  source: 'text',
  text: '',
  voice: '',
  speed: 1,
  configModel: '',
  configVoice: '',

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
  setSpeed: (speed) => set({ speed }),

  loadConfig: async () => {
    const api = getElectronAPI()
    if (!api) return
    try {
      const settings = await api.getSettings()
      const model = typeof settings.ttsModel === 'string' ? settings.ttsModel : ''
      const voice = typeof settings.ttsVoice === 'string' ? settings.ttsVoice : ''
      set({ configModel: model, configVoice: voice })
    } catch {
      set({ configModel: '', configVoice: '' })
    }
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
    set({ previewing: true })
    try {
      const { voice, speed } = get()
      const res = await api.previewVoice(queue[0].text, { voice, speed })
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
      const { voice, speed } = get()
      const res = await api.synthesizeVoice(queue, { voice, speed })
      set({ result: res, phase: 'done', jobId: res.jobId, progress: null })
      if (res.error) toast.error(res.error)
      else if (res.abortedReason) toast.error(res.abortedReason)
      else if (res.canceled) toast.info(`已取消，已完成的 ${res.clipCount} 段拼成了一条轨`)
      else toast.success(`字幕配音完成，${res.clipCount} 段`)
    } catch (err) {
      set({ phase: 'idle', queue: [] })
      toast.error(err instanceof Error ? err.message : '字幕配音没能跑完')
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
    if (res.success) {
      set({ cancelRequested: true })
      toast.info('已请求取消，正在收尾')
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
