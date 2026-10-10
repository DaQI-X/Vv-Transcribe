/**
 * Electron 主进程入口
 * 负责创建应用窗口、注册 IPC 处理器、设置应用图标和名称
 * 应用启动时自动拉起 Python ASR 服务，退出时优雅关闭
 */
import { app, BrowserWindow, nativeImage } from 'electron'
import { join } from 'node:path'
import { registerAllHandlers } from './ipc'
import { startASRService, stopASRService } from './services/asrServiceManager'

const MAIN_DIR = import.meta.dirname

const ICON_PATH = join(MAIN_DIR, '../../src/assets/mac/logo_1024.png')
const APP_NAME = 'Vv Transcribe'

let mainWindow: BrowserWindow | null = null
let isQuitting = false

/** 创建主窗口，配置 preload 和安全策略 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: APP_NAME,
    icon: nativeImage.createFromPath(ICON_PATH),
    // autoHideMenuBar: true,
    webPreferences: {
      preload: join(MAIN_DIR, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(MAIN_DIR, '../../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  const dockIcon = nativeImage.createFromPath(ICON_PATH)
  app.dock?.setIcon(dockIcon)
  app.setName(APP_NAME)

  registerAllHandlers()
  createWindow()

  // 异步启动 Python ASR 服务（不阻塞窗口显示）
  startASRService().then((ok) => {
    if (ok && mainWindow && !mainWindow.isDestroyed()) {
      console.log('[Main] Python ASR service is ready')
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', async (e) => {
  if (isQuitting) return
  isQuitting = true
  e.preventDefault()
  await stopASRService()
  app.exit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
