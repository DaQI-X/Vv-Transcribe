/**
 * Electron 主进程入口
 * 负责创建应用窗口、注册 IPC 处理器、设置应用图标和名称
 * 应用启动时自动拉起 Python ASR 服务，退出时优雅关闭
 */
import { app, BrowserWindow, nativeImage, ipcMain, powerSaveBlocker } from 'electron'
import { join } from 'node:path'
import { registerAllHandlers } from './ipc'
import { startASRService, stopASRService, getASRServiceStatus } from './services/asrServiceManager'
import { stopLocalTtsEngine } from './services/localTtsEngine'
import { initDictionary } from './services/dictionaryService'
import { logger } from './services/logger'
import { releaseAllMediaSessions, sweepStaleMediaTempDirs } from './services/urlDownloader'
import { installCrashWatch, watchWindowGone } from './services/crashWatch'

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

// 崩溃兜底要在其余初始化之前装好：app.whenReady() 里那几条链路（拉起 ASR、读词典）
// 恰恰是最可能出一句没接住的异步失败的，而那时窗口已经建完、用户已经在等结果了
installCrashWatch(() => mainWindow)

/** 服务初始化状态 */
let serviceReady = false
let serviceError: string | null = null
/** 两项前置服务各自完成的时间差很远（ASR 要等子进程就绪，词典要读大文件），分开上报才能给开屏页写阶段文案 */
let asrTaskDone = false
let dictionaryTaskDone = false

/**
 * 引擎状态一律现读 asrServiceManager，不在这里缓存布尔值：
 * 应用内「重启本地引擎」跑的是同一个 startASRService，缓存的那份会一直停在开屏那次的结果。
 */
function asrFailureReason(): string | null {
  if (!asrTaskDone) return '本地转写引擎还在启动中，请等开屏结束后再试'
  const status = getASRServiceStatus()
  return status.ready
    ? null
    : (status.error || '本地转写引擎未能启动，可在「设置 → 转写配置」点「重启本地引擎」')
}

/** 查询服务就绪状态 */
ipcMain.handle('app:getServiceReady', () => ({
  ready: serviceReady,
  error: serviceError,
  asrDone: asrTaskDone && getASRServiceStatus().ready,
  asrError: asrFailureReason(),
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
    // 结果页是「播放器 480px 固定列 + 编辑列」两栏，编辑列表头一行的自然宽度约 608px，
    // 窗口 1100 时编辑列 556、内容区 508，按钮组换到第二行且不挤压
    minWidth: 1100,
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

  // 早于第一次 load 挂上，否则首屏就加载不出来时这条链路没人看
  watchWindowGone(mainWindow)

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

  // 会话目录只活在内存里：上次进程被强杀/崩溃，那些 transcribe-* 目录（媒体 + 浏览器 cookies）没人删。
  // 后台扫一遍清掉一天前的，不阻塞开屏；新会话的目录 mtime 是当下，不会被自己扫掉。
  sweepStaleMediaTempDirs()
    .then((n) => {
      if (n > 0) logger.info('App', 'Swept stale media temp dirs', { removed: n })
    })
    .catch((e) => logger.warn('App', 'Media temp sweep failed', e?.message))

  // 异步初始化前置服务（词典 + ASR），完成后标记就绪
  logger.info('App', 'Initializing services...')
  const asrTask = startASRService()
    .catch((e) => {
      logger.warn('App', 'ASR service failed', e?.message)
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
      logger.info('App', 'Services initialization completed', { ready: serviceReady, asrError: asrFailureReason() })
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
  // 链接转写的那份临时媒体是播放器一路在用的，只能等到这里才没人用；被强杀时走不到这步，
  // 由下次启动的 sweepStaleMediaTempDirs 兜底
  await releaseAllMediaSessions().catch(() => {})
  await stopASRService()
  logger.info('App', 'ASR service stopped')
  // 本地配音引擎是懒启动的：没配音过就从没存在过，这一步是空操作；配过的话它占着 370–878MB，
  // 必须连进程组一起收掉，否则下次启动只能靠端口回收兜住
  await stopLocalTtsEngine()
  logger.info('App', 'Local TTS engine stopped')
  app.exit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
