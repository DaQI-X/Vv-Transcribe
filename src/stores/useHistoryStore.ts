/**
 * 历史记录抽屉（#247④）的状态
 *
 * 为什么不放组件里：开开关关分处两地——入口那颗图标在标题栏，抽屉自己浮在 main 之外，两边点的必须是同一颗状态。
 * 顺带还把「刚从磁盘读回来的列表」和「用户停在哪个标签」留在了组件外面。
 *
 * 三条口径跟着主进程走：
 * - `items: null` 与 `[]` 是两句话（前者「这本账读不出来」、后者「确实一条都没有」），这里不许折成一个。
 * - keep／unkeep／remove 只在写完之后 refresh：磁盘此刻什么样，列表就该还显示什么样，不提前演一个成功态。
 * - 稿子正文只在这一次「留住」上跨过 IPC（记账时它从没落过盘），所以取正文收在本文件，
 *   不让组件各找各的段落。
 */
import { create } from 'zustand'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { toast } from '@/components/ui/Toast'
import { exportTranscript } from '@/utils/exportTranscript'
import { useTranscriptionStore } from './useTranscriptionStore'
import type { HistoryItem, HistoryKind } from '@/types/history'

/** 抽屉里的分组：三种作业各一个标签，外加「全部」——按 kind 分，与行上那枚徽标同一个取值 */
export type HistoryTab = 'all' | HistoryKind

interface HistoryState {
  /** null＝还没读过或读不出来；[]＝读过，确实一条都没有 */
  items: HistoryItem[] | null
  error: string | null
  loading: boolean
  /** 正在写盘的那一行（同一时刻只让一个动作在飞），行上的按钮据此按死 */
  busyId: string
  /** 抽屉开没开：顶部那颗入口图标和「关闭」改的都是这一格 */
  open: boolean
  tab: HistoryTab

  refresh: () => Promise<void>
  setOpen: (open: boolean) => void
  toggleOpen: () => void
  setTab: (tab: HistoryTab) => void
  /** 勾上「留住」：产物由主进程按 id 去复制，正文只有当前这一单给得出来 */
  keep: (id: string) => Promise<void>
  /** 反悔：只删副本，记录本身留着 */
  unkeep: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  reveal: (id: string) => Promise<void>
}

/**
 * 这一行的稿子正文：只有「本次会话刚转完的那一条」给得出来。
 *
 * 段落只活在渲染层（主进程记账时一个字节都没收），更早的记录没有正文可给——组件按这条决定
 * 那一勾是「留住产物」、「留住稿子」，还是干脆说明为什么这一条什么都留不了。
 */
function draftOf(id: string): string | undefined {
  const { jobId, segments } = useTranscriptionStore.getState()
  if (id !== jobId || segments.length === 0) return undefined
  // 跟「导出 → 纯文本 TXT」同一把尺：留住的那份稿子和导出去的那份不该是两个内容
  return exportTranscript(segments, 'txt')
}

/** 写动作共用的收口：没成就把主进程那句原话弹出来，成了才重读列表 */
async function runWrite(
  call: (api: Window['electronAPI']) => Promise<{ ok: boolean; error?: string } | null | undefined>,
  successCopy: string
): Promise<void> {
  const api = getElectronAPI()
  try {
    // 拿不到桥（只有纯浏览器里跑渲染层才会这样）也要把在途标记清掉，不然这一栏永远按不动
    const result = api ? await call(api) : null
    // 连信封都没拿到不等于「成了」：这里一声不出，行上那勾就会自己变灰骗人
    if (!result) {
      toast.error('这一步没拿到回执，列表没变——先别重复点，重开这一栏', 9000)
      return
    }
    if (!result.ok) {
      // 「留住一半」也算 ok:false（产物原件被清扫收走、稿子已进盘）：盘确实变了，所以照样刷
      await useHistoryStore.getState().refresh()
      toast.error(result.error || '这一步没做成', 9000)
      return
    }
    toast.success(successCopy, 4000)
    await useHistoryStore.getState().refresh()
  } finally {
    useHistoryStore.setState({ busyId: '' })
  }
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  items: null,
  error: null,
  loading: false,
  busyId: '',
  open: false,
  tab: 'all',

  setOpen: (open) => set({ open }),
  toggleOpen: () => set((state) => ({ open: !state.open })),
  setTab: (tab) => set({ tab }),

  refresh: async () => {
    const api = getElectronAPI()
    if (!api) return
    set({ loading: true })
    // 收口之后 invoke 不再 reject，回 null 正是「读不出来」那一格要的形状
    const result = await api.listHistory().catch(() => null)
    if (!result) {
      set({ items: null, error: '这次没从应用那边拿到历史记录（详情看应用日志）' })
    } else {
      set({ items: result.items, error: result.error })
    }
    set({ loading: false })
  },

  keep: async (id) => {
    if (get().busyId) return
    set({ busyId: id })
    await runWrite((api) => api.keepHistory(id, draftOf(id)), '已经留住一份，它在应用数据目录里，不会被清理')
  },

  unkeep: async (id) => {
    if (get().busyId) return
    set({ busyId: id })
    await runWrite((api) => api.dropHistoryCopies(id), '留住的副本删掉了，这条记录本身还在')
  },

  remove: async (id) => {
    if (get().busyId) return
    set({ busyId: id })
    await runWrite((api) => api.deleteHistoryRecord(id), '这条记录删掉了')
  },

  reveal: async (id) => {
    const api = getElectronAPI()
    if (!api) return
    const result = await api.revealHistoryFile(id).catch(() => null)
    // success 只代表「这一条确实有留住的副本、它此刻还在盘上」；shell 那一步没有回执，不许演成「用户已看见」
    if (!result?.success) toast.error(result?.error || '没能在文件夹里找到它', 9000)
  },
}))
