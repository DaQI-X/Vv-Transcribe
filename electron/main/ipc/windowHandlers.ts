/**
 * 窗口控制 IPC 处理器
 * 提供窗口最大化/还原、最小化、关闭等功能
 *
 * 三条都回一个布尔：true＝这一下确实落到了某个窗口上。收进 guard 之后失败也还是 false，
 * 与「没有聚焦窗口」是同一句话——界面本来就不区分这两种（它只在没有窗口时才拿到 false），
 * 而这几步本身炸不了（读的是 Electron 自己的窗口表）。
 */
import { BrowserWindow } from 'electron'
import { ipcHandle } from './guard'

export function registerWindowHandlers() {
  ipcHandle(
    'window:toggleMaximize',
    () => {
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
    },
    () => false
  )

  ipcHandle(
    'window:minimize',
    () => {
      const win = BrowserWindow.getFocusedWindow()
      if (win) {
        win.minimize()
        return true
      }
      return false
    },
    () => false
  )

  ipcHandle(
    'window:close',
    () => {
      const win = BrowserWindow.getFocusedWindow()
      if (win) {
        win.close()
        return true
      }
      return false
    },
    () => false
  )
}
