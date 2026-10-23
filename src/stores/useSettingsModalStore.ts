/**
 * 设置弹窗的开关状态
 * 放在全局是因为多个入口都要「跳去设置」：开工前置校验、链接依赖检测、纠错缺 Key。
 * tab 为 null 表示关闭。
 */
import { create } from 'zustand'

interface SettingsModalState {
  tab: string | null
  open: (tab: string) => void
  close: () => void
}

export const useSettingsModalStore = create<SettingsModalState>((set) => ({
  tab: null,
  open: (tab) => set({ tab }),
  close: () => set({ tab: null }),
}))
