/**
 * 全局测试替身：主进程模块一律 `import ... from 'electron'`，而 vitest 跑在纯 Node 里，
 * 那个包名在 Node 下解析到的是二进制路径字符串，命名导入直接报错。
 * 这里逐个显式给出替身（不用 Proxy 兜万能）：漏了哪个成员就让它响亮地失败，
 * 而不是悄悄返回 undefined 把一个真缺陷测成通过。
 */
import { tmpdir } from 'node:os'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, vi } from 'vitest'

/**
 * hoisted 回调跑在 ESM import 之前，里面碰不到 join/tmpdir（实测报
 * "Cannot access '__vi_import_1__' before initialization"）。
 * 所以这里只留一个能给默认值的临时路径，真值在下面正常语句里覆盖。
 */
const electronState = vi.hoisted(() => ({
  /** 测试期间当作用户数据目录；每个用例可以改它来换一份干净的文件 */
  userData: '/tmp/vv-test-userdata',
  appVersion: '1.0.8-test',
}))

electronState.userData = join(tmpdir(), 'vv-test-userdata')

vi.mock('electron', () => {
  /**
   * 窗口替身要能被测试驱动，所以三个动作各留一份记录：
   * webContents.on 存下监听器（测试手动打事件）、reload 计数（有没有真重载）、send 收消息
   * （主进程往界面推的那句话到没到）。isDestroyed 默认 false：崩溃兜底正是「窗口还在」时才走 send。
   */
  class FakeBrowserWindow {
    static getAllWindows() {
      return []
    }
    destroyed = false
    notices: unknown[][] = []
    reloads = 0
    listeners = new Map<string, (...args: unknown[]) => void>()
    isDestroyed() {
      return this.destroyed
    }
    webContents = {
      openDevTools: () => {},
      send: (...args: unknown[]) => {
        this.notices.push(args)
      },
      on: (event: string, cb: (...args: unknown[]) => void) => {
        this.listeners.set(event, cb)
      },
      reload: () => {
        this.reloads++
      },
    }
  }

  return {
    app: {
      getPath: (name: string) =>
        name === 'userData' ? electronState.userData : join(electronState.userData, name),
      getName: () => 'Vv Transcribe (test)',
      getVersion: () => electronState.appVersion,
      getAppPath: () => process.cwd(),
      isReady: () => true,
      on: () => {},
      whenReady: () => Promise.resolve(),
      quit: () => {},
      exit: () => {},
      dock: undefined,
    },
    // 可逆的假加密：够测「密文形状」和「解不开」两条分支，不碰系统密钥库
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => Buffer.from(`fake:${plain}`, 'utf-8'),
      decryptString: (buf: Buffer) => {
        const text = buf.toString('utf-8')
        if (!text.startsWith('fake:')) throw new Error('decrypt failed')
        return text.slice('fake:'.length)
      },
    },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
    ipcRenderer: { invoke: async () => undefined, on: () => {}, removeListener: () => {} },
    BrowserWindow: FakeBrowserWindow,
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
      showMessageBox: async () => ({ response: 0 }),
      /**
       * 崩溃兜底走的是同步版（渲染进程已经不在了，不能再等一个 Promise 把它自己卡住）。
       * 默认回「按下第 0 个按钮」；用例用 vi.spyOn(dialog,'showMessageBoxSync') 换成别的按钮，
       * 顺带就是一份调用记录——不必为了测试在这里存第二份状态。
       */
      showMessageBoxSync: () => 0,
      showErrorBox: () => {},
    },
    shell: { openPath: async () => '', openExternal: async () => {}, showItemInFolder: () => {} },
    net: {
      fetch: async () => {
        throw new Error('net.fetch is not available in unit tests')
      },
    },
    nativeImage: { createFromPath: () => ({}) },
    contextBridge: { exposeInMainWorld: () => {} },
    powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
    webUtils: { getPathForFile: () => '' },
  }
})

afterAll(() => {
  void rm(electronState.userData, { recursive: true, force: true })
})
