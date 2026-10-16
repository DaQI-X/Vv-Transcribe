/**
 * 主题状态管理
 * 管理亮色/暗色主题切换，持久化到 localStorage
 */
import { create } from 'zustand'

type Theme = 'light' | 'dark'

interface ThemeState {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

const THEME_KEY = 'vv_theme'

const getInitialTheme = (): Theme => {
  const stored = localStorage.getItem(THEME_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  // 默认跟随系统
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: getInitialTheme(),
  
  setTheme: (theme: Theme) => {
    localStorage.setItem(THEME_KEY, theme)
    document.documentElement.setAttribute('data-theme', theme)
    set({ theme })
  },
  
  toggleTheme: () => {
    const newTheme = getInitialTheme() === 'light' ? 'dark' : 'light'
    localStorage.setItem(THEME_KEY, newTheme)
    document.documentElement.setAttribute('data-theme', newTheme)
    set((state) => ({ theme: state.theme === 'light' ? 'dark' : 'light' }))
  },
}))

// 初始化主题
const initTheme = () => {
  const theme = getInitialTheme()
  document.documentElement.setAttribute('data-theme', theme)
}

initTheme()
