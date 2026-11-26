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

/**
 * 每个 worker 一份目录：本仓库按文件开 worker（35 个文件 = 35 个进程），以前它们都往同一个
 * userData 里写日志，而每个 worker 收尾都要递归删它——删的那个人正好撞上别人往里补一层
 * logs/，就得到一句 `ENOTEMPTY: directory not empty, rmdir .../vv-test-userdata/logs`。
 * 下面那句 rm 是无人接的 Promise，于是它以 unhandled rejection 的形式把整条 `pnpm test` 判红，
 * 而 CI 的 test job 跑的就是这一条。它是抖动不是定场：这一轮撞见一次，连跑三次又不复现，
 * 但一次就够把发版闸门挡住。
 */
electronState.userData = join(tmpdir(), `vv-test-userdata-${process.pid}`)

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

afterAll(async () => {
  /**
   * 要 await：不 await 时 worker 直接退了，删的动作根本跑不完（实测 tmp 里每次留下一二十个
   * 目录）。而删不掉本身不该算测试失败——logger 是异步 append，收尾那一写可能正把 logs/ 补回来，
   * 让递归删撞见 ENOTEMPTY；那句 rethrow 会变成 unhandled rejection 把整条 `pnpm test` 判红，
   * CI 的 test job 跑的正是这一条。留一个 tmp 目录是代价，判红不是。
   */
  await rm(electronState.userData, { recursive: true, force: true }).catch(() => {})
})
