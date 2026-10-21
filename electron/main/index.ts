/**
 * Electron 主进程入口
 * 负责创建应用窗口、注册 IPC 处理器、设置应用图标和名称
 * 应用启动时自动拉起 Python ASR 服务，退出时优雅关闭
 */
import { app, BrowserWindow, nativeImage, ipcMain, powerSaveBlocker } from 'electron'
import { join } from 'node:path'
import { registerAllHandlers } from './ipc'
import { startASRService, stopASRService } from './services/asrServiceManager'
import { initDictionary } from './services/dictionaryService'
import { logger } from './services/logger'

// 忽略 EPIPE 错误（stdout 管道断开，常见于开发服务器重启）
process.on('SIGPIPE', () => {})
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return
  throw err
})
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return
  throw err
})

// 防止系统息屏（音频转写应用需要长时间运行）
let powerSaveBlockerId: number | null = null
const preventSleep = () => {
  if (powerSaveBlockerId === null) {
    try {
      powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep')
      logger.info('App', 'Display sleep prevention enabled', { id: powerSaveBlockerId })
    } catch (err) {
      logger.warn('App', 'Failed to enable sleep prevention', err)
    }
  }
}

const MAIN_DIR = import.meta.dirname

const ICON_PATH = join(MAIN_DIR, '../../src/assets/mac/logo_1024.png')
const APP_NAME = 'Vv Transcribe'

let mainWindow: BrowserWindow | null = null
let isQuitting = false
/** 本进程是否已建过窗口。macOS 关窗不退出应用，从 Dock 重开窗口不是冷启动，不该重放开屏动画 */
let hasLaunchedWindow = false

/** 服务初始化状态 */
let serviceReady = false
let serviceError: string | null = null
/** 两项前置服务各自完成的时间差很远（ASR 要等子进程就绪，词典要读大文件），分开上报才能给开屏页写阶段文案 */
let asrTaskDone = false
let dictionaryTaskDone = false

/** 查询服务就绪状态 */
ipcMain.handle('app:getServiceReady', () => ({
  ready: serviceReady,
  error: serviceError,
  asrDone: asrTaskDone,
  dictionaryDone: dictionaryTaskDone,
}))

/** 接收前端日志并写入日志文件 */
ipcMain.handle('app:log', (_event, entry: any) => {
  if (entry) {
    const { level = 'INFO', module = 'Renderer', message, data } = entry
    if (level === 'ERROR') {
      logger.error(module, message, data)
    } else if (level === 'WARN') {
      logger.warn(module, message, data)
    } else if (level === 'DEBUG') {
      logger.debug(module, message, data)
    } else {
      logger.info(module, message, data)
    }
  }
})

/** 创建主窗口，配置 preload 和安全策略 */
function createWindow() {
  // 冷启动只能由主进程判定：渲染层的 beforeunload 在「关窗但没退出应用」时也会触发
  const coldStart = !hasLaunchedWindow
  hasLaunchedWindow = true
  logger.info('App', 'Window launch', { coldStart })

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: '',
    titleBarStyle: 'hiddenInset',
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
    const devUrl = new URL(process.env.VITE_DEV_SERVER_URL)
    devUrl.searchParams.set('cold', coldStart ? '1' : '0')
    mainWindow.loadURL(devUrl.toString())
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(MAIN_DIR, '../../dist/index.html'), {
      query: { cold: coldStart ? '1' : '0' },
    })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  logger.info('App', 'Application starting...')
  const dockIcon = nativeImage.createFromPath(ICON_PATH)
  app.dock?.setIcon(dockIcon)
  app.setName(APP_NAME)
  
  // 启用防息屏
  preventSleep()

  registerAllHandlers()
  createWindow()
  logger.info('App', 'Main window created')

  // 异步初始化前置服务（词典 + ASR），完成后标记就绪
  logger.info('App', 'Initializing services...')
  const asrTask = startASRService()
    .catch((e) => {
      logger.error('App', 'ASR service failed', e?.message)
      return null
    })
    .finally(() => {
      asrTaskDone = true
    })
  const dictionaryTask = initDictionary().finally(() => {
    dictionaryTaskDone = true
  })
  Promise.all([asrTask, dictionaryTask])
    .then(() => {
      serviceReady = true
      logger.info('App', 'Services initialization completed', { ready: serviceReady })
    })
    .catch((e) => {
      serviceError = e?.message || '服务初始化失败，请重启应用'
      logger.error('App', 'Service initialization failed', serviceError)
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
  logger.info('App', 'Application quitting...')
  e.preventDefault()
  await stopASRService()
  logger.info('App', 'ASR service stopped')
  app.exit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
