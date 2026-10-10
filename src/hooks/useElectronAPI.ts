/**
 * Electron API 安全获取 Hook
 * 返回 window.electronAPI 对象，非 Electron 环境（如浏览器）返回 null
 */
export function getElectronAPI(): Window['electronAPI'] | null {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return null
  }
  return window.electronAPI
}

