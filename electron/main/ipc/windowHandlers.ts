/**
 * 窗口控制 IPC 处理器
 * 提供窗口最大化/还原、最小化、关闭等功能
 */
import { ipcMain, BrowserWindow } from 'electron'

export function registerWindowHandlers() {
  ipcMain.handle('window:toggleMaximize', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize()
      } else {
        win.maximize()
      }
      return true
    }
    return false
  })

  ipcMain.handle('window:minimize', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (win) {
      win.minimize()
      return true
    }
    return false
  })

  ipcMain.handle('window:close', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (win) {
      win.close()
      return true
    }
    return false
  })
}
