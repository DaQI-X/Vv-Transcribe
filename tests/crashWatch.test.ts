/**
 * 崩溃兜底（crashWatch）的契约。
 *
 * 这一层修的是「出事的时候没人说话」，所以每条用例测的都是**话说没说、有没有替用户做主**：
 * 1. 每种 Electron 原因码都要落在一句人话上（猜错方向会让人照着错的做：oom 该重开、
 *    memory-eviction 不是用户的问题、integrity-failure 得重装包）。
 * 2. 「不该打扰」的那几种必须真的静默：clean-exit、killed、开发模式热重载的 ERR_ABORTED。
 * 3. 按钮写着「重新加载」，用户点「知道了」就不许重载——丢的是他这份还没导出的结果。
 * 4. 界面没了自己会说话之前，先有一条日志：那是用户唯一能交付给开发者的现场。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type CrashWatch = typeof import('../electron/main/services/crashWatch')

/** 假窗口的可观察部分（tests/setup.ts 里的 FakeBrowserWindow 实例） */
interface Probe {
  notices: unknown[][]
  reloads: number
  listeners: Map<string, (...args: unknown[]) => void>
}

let dir = ''
let service: CrashWatch

const probe = (win: BrowserWindow) => win as unknown as Probe

/** 把某个 webContents 事件的处理器取出来，手动打一次 */
function fire(win: BrowserWindow, event: string, ...args: unknown[]): void {
  const handler = probe(win).listeners.get(event)
  if (!handler) throw new Error(`没有注册 ${event} 监听，兜底代码根本没挂上`)
  handler(...args)
}

/** 每次取的都是同一个 spy（vitest 对同一属性会复用），所以用例里可以直接改返回值 */
const dialogSpy = () => vi.spyOn(dialog, 'showMessageBoxSync')

/** 日志是异步 append 的，等一个 tick 再读，否则测到的是「还没写下去」 */
async function waitForLogFile(): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 30))
  return readFile(join(dir, 'logs', 'app.log'), 'utf-8')
}

/**
 * 每个用例一份全新模块：重载次数是模块级数组，不重灌就会带着上一个用例的计数，
 * 那条「60 秒内崩满两次就不再给重载按钮」永远测不准。
 * logger 的目录在模块构造时算好，所以换目录必须在 import 之前做完。
 */
async function loadInto(freshDir: string): Promise<void> {
  vi.resetModules()
  vi.spyOn(app, 'getPath').mockImplementation(
    ((name: string) => (name === 'userData' ? freshDir : join(freshDir, name))) as typeof app.getPath
  )
  service = await import('../electron/main/services/crashWatch')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vv-crash-'))
  await loadInto(dir)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('界面进程消失：每种原因都要落在一句人话上', () => {
  const CASES: Array<{ reason: string; contains: string }> = [
    { reason: 'crashed', contains: '崩溃' },
    { reason: 'killed', contains: '被系统结束' },
    { reason: 'oom', contains: '内存用完' },
    { reason: 'memory-eviction', contains: '系统在回收内存' },
    { reason: 'abnormal-exit', contains: '异常退出' },
    { reason: 'launch-failed', contains: '没能起来' },
    { reason: 'integrity-failure', contains: '完整性校验' },
  ]

  it.each(CASES)('$reason → 一句话 + 需要重载', ({ reason, contains }) => {
    const outcome = service.describeRendererGone({ reason })
    expect(outcome.message).toContain(contains)
    expect(outcome.needsReload).toBe(true)
  })

  it('好好退出的（clean-exit）不是故障，一个字都不该说', () => {
    const outcome = service.describeRendererGone({ reason: 'clean-exit' })
    expect(outcome.message).toBeNull()
    expect(outcome.needsReload).toBe(false)
  })

  it('没列到的原因走兜底话术并把原因带出来，而不是当成没事', () => {
    const outcome = service.describeRendererGone({ reason: 'some-new-reason', exitCode: 7 })
    expect(outcome.message).toContain('some-new-reason')
    expect(outcome.message).toContain('退出码 7')
    expect(outcome.needsReload).toBe(true)
  })
})

describe('后台子进程消失：只说该说的', () => {
  it('正常结束与系统回收都不打扰用户', () => {
    expect(service.describeChildGone({ type: 'GPU', reason: 'killed' }).message).toBeNull()
    expect(service.describeChildGone({ type: 'GPU', reason: 'clean-exit' }).message).toBeNull()
  })

  it('崩了的话要点名是哪个组件、为什么', () => {
    const outcome = service.describeChildGone({ type: 'GPU', reason: 'crashed' })
    expect(outcome.message).toContain('GPU')
    expect(outcome.message).toContain('crashed')
    // 子进程没了界面还在，所以不该催重载
    expect(outcome.needsReload).toBe(false)
  })
})

describe('主框架加载失败：开发模式的热重载不算故障', () => {
  it('ERR_ABORTED(-3) 静默', () => {
    expect(service.describeLoadFailure(-3, 'ERR_ABORTED').message).toBeNull()
  })

  it('真的加载不出来要说清错误码', () => {
    const outcome = service.describeLoadFailure(-6, 'ERR_FILE_NOT_FOUND')
    expect(outcome.message).toContain('-6')
    expect(outcome.message).toContain('ERR_FILE_NOT_FOUND')
  })
})

describe('重载由人点头，不替用户按回车', () => {
  it('给了「重新加载」按钮，用户点第二个（知道了）就不许重载', () => {
    const win = new BrowserWindow({})
    const spy = dialogSpy().mockReturnValue(1)
    service.watchWindowGone(win)

    fire(win, 'render-process-gone', {}, { reason: 'crashed', exitCode: 0 })

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].buttons).toEqual(['重新加载', '知道了'])
    expect(probe(win).reloads).toBe(0)
  })

  it('用户点第一个才真的重载', () => {
    const win = new BrowserWindow({})
    dialogSpy().mockReturnValue(0)
    service.watchWindowGone(win)

    fire(win, 'render-process-gone', {}, { reason: 'crashed' })

    expect(probe(win).reloads).toBe(1)
  })

  it('用户连着拒绝两次不该把后面的机会用掉，第三次仍可重载', () => {
    const win = new BrowserWindow({})
    const spy = dialogSpy()
    service.watchWindowGone(win)

    spy.mockReturnValue(1)
    fire(win, 'render-process-gone', {}, { reason: 'crashed' })
    fire(win, 'render-process-gone', {}, { reason: 'crashed' })
    expect(probe(win).reloads).toBe(0)

    spy.mockReturnValue(0)
    fire(win, 'render-process-gone', {}, { reason: 'crashed' })
    expect(probe(win).reloads).toBe(1)
  })

  it('一分钟内崩满两次之后就不再给重载按钮，只让人去重启应用', () => {
    const win = new BrowserWindow({})
    const spy = dialogSpy().mockReturnValue(0)
    service.watchWindowGone(win)

    fire(win, 'render-process-gone', {}, { reason: 'crashed' })
    fire(win, 'render-process-gone', {}, { reason: 'crashed' })
    expect(probe(win).reloads).toBe(2)

    fire(win, 'render-process-gone', {}, { reason: 'crashed' })
    expect(probe(win).reloads).toBe(2)
    expect(spy.mock.calls[2][0].buttons).toEqual(['知道了'])
    expect(spy.mock.calls[2][0].detail).toContain('退出应用后重新打开')
  })

  it('clean-exit 不打扰：对话框一次都不弹', () => {
    const win = new BrowserWindow({})
    const spy = dialogSpy()
    service.watchWindowGone(win)

    fire(win, 'render-process-gone', {}, { reason: 'clean-exit' })

    expect(spy).not.toHaveBeenCalled()
    expect(probe(win).reloads).toBe(0)
  })

  it('先落日志再说界面：崩一次就有一条 ERROR 在现场', async () => {
    const win = new BrowserWindow({})
    dialogSpy().mockReturnValue(1)
    service.watchWindowGone(win)

    fire(win, 'render-process-gone', {}, { reason: 'oom' })
    const logged = await waitForLogFile()

    expect(logged).toContain('Render process gone')
    expect(logged).toContain('oom')
  })

  it('对话框还挂着的那一刻，现场就已经在文件里了', () => {
    // 这条测的是规矩 1 的真正含义：showMessageBoxSync 会把主进程堵在对话框上，
    // 异步 append 排不进事件循环（实测过：日志要等用户点掉才落盘，用户那会儿强杀就什么都没了）。
    // 所以断言点放在对话框「正在被显示」的那个同步时刻。
    const win = new BrowserWindow({})
    let whileDialogUp = ''
    dialogSpy().mockImplementation(() => {
      whileDialogUp = readFileSync(join(dir, 'logs', 'app.log'), 'utf-8')
      return 1
    })
    service.watchWindowGone(win)

    fire(win, 'render-process-gone', {}, { reason: 'crashed' })

    expect(whileDialogUp).toContain('Render process gone')
  })
})

describe('加载失败的打扰范围', () => {
  it('子框架加载失败不吭声，主框架的才说', () => {
    const win = new BrowserWindow({})
    const spy = dialogSpy()
    service.watchWindowGone(win)

    fire(win, 'did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://x/y', false)
    expect(spy).not.toHaveBeenCalled()

    fire(win, 'did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://x/y', true)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].detail).toContain('ERR_NAME_NOT_RESOLVED')
  })

  it('开发模式热重载那次 ERR_ABORTED 不会弹任何东西', () => {
    const win = new BrowserWindow({})
    const spy = dialogSpy()
    service.watchWindowGone(win)

    fire(win, 'did-fail-load', {}, -3, 'ERR_ABORTED', 'http://localhost:5173/', true)

    expect(spy).not.toHaveBeenCalled()
  })
})

describe('主进程级兜底：谁还活着用谁的通道', () => {
  /** 重灌模块后重新装一遍兜底，并把 app.on / process.on 的处理器抓在手里 */
  async function installWithProbe(win: BrowserWindow | null) {
    await loadInto(dir)
    const appHandlers = new Map<string, (...args: unknown[]) => void>()
    vi.spyOn(app, 'on').mockImplementation(((event: string, cb: (...args: unknown[]) => void) => {
      appHandlers.set(event, cb)
      return true
    }) as unknown as typeof app.on)
    const processHandlers = new Map<string, (...args: unknown[]) => void>()
    vi.spyOn(process, 'on').mockImplementation(((event: string, cb: (...args: unknown[]) => void) => {
      processHandlers.set(event, cb)
      return process
    }) as unknown as typeof process.on)

    service.installCrashWatch(() => win)
    return { appHandlers, processHandlers }
  }

  it('渲染进程还活着 → 子进程崩了走 toast 通道，不去弹对话框', async () => {
    const win = new BrowserWindow({})
    const { appHandlers } = await installWithProbe(win)
    const spy = dialogSpy()

    appHandlers.get('child-process-gone')?.({}, { type: 'GPU', reason: 'crashed' })

    const sent = probe(win).notices
    expect(sent).toHaveLength(1)
    expect(sent[0][0]).toBe(service.ERROR_NOTICE_CHANNEL)
    expect(sent[0][1]).toContain('GPU')
    expect(spy).not.toHaveBeenCalled()
  })

  it('子进程好好退出不推消息', async () => {
    const win = new BrowserWindow({})
    const { appHandlers } = await installWithProbe(win)

    appHandlers.get('child-process-gone')?.({}, { type: 'GPU', reason: 'clean-exit' })

    expect(probe(win).notices).toHaveLength(0)
  })

  it('一处异步失败没接住：记下日志并推一句话，但不结束进程、也不弹对话框', async () => {
    const win = new BrowserWindow({})
    const { processHandlers } = await installWithProbe(win)
    const spy = dialogSpy()

    processHandlers.get('unhandledRejection')?.(new Error('某一步的 fetch 挂了'))

    expect(probe(win).notices).toHaveLength(1)
    expect(String(probe(win).notices[0][1])).toContain('一步没跑完')
    expect(spy).not.toHaveBeenCalled()
    expect(await waitForLogFile()).toContain('Unhandled rejection')
  })

  it('窗口已经没了就不能假装说过：只剩系统对话框这条路', async () => {
    const { processHandlers } = await installWithProbe(null)

    expect(() => processHandlers.get('unhandledRejection')?.(new Error('没人听的错误'))).not.toThrow()
  })

  it('主进程同步抛异常：说清楚原因，用户点「退出应用」才走 app.quit（那才会收尾）', async () => {
    const win = new BrowserWindow({})
    const { processHandlers } = await installWithProbe(win)
    const quit = vi.spyOn(app, 'quit').mockImplementation(() => {})
    dialogSpy().mockReturnValue(1)

    processHandlers.get('uncaughtException')?.(new Error('主进程里炸了'))

    const spy = dialogSpy()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].detail).toContain('主进程里炸了')
    expect(spy.mock.calls[0][0].buttons).toEqual(['知道了', '退出应用'])
    expect(quit).toHaveBeenCalledTimes(1)
    expect(await waitForLogFile()).toContain('Uncaught exception in main process')
  })

  it('主进程异常弹框的那一刻日志已在盘上：这条最容易被用户直接强杀', async () => {
    const win = new BrowserWindow({})
    const { processHandlers } = await installWithProbe(win)
    let whileDialogUp = ''
    dialogSpy().mockImplementation(() => {
      whileDialogUp = readFileSync(join(dir, 'logs', 'app.log'), 'utf-8')
      return 0
    })

    processHandlers.get('uncaughtException')?.(new Error('主进程里炸了'))

    expect(whileDialogUp).toContain('Uncaught exception in main process')
    expect(whileDialogUp).toContain('主进程里炸了')
  })

  it('用户只点了「知道了」，那就继续跑，不偷偷退出', async () => {
    const win = new BrowserWindow({})
    const { processHandlers } = await installWithProbe(win)
    const quit = vi.spyOn(app, 'quit').mockImplementation(() => {})
    dialogSpy().mockReturnValue(0)

    processHandlers.get('uncaughtException')?.(new Error('主进程里炸了'))

    expect(quit).not.toHaveBeenCalled()
  })

  it('对话框本身炸了不能再抛一次：兜底代码不该成为新的崩溃源', async () => {
    const win = new BrowserWindow({})
    const { processHandlers } = await installWithProbe(win)
    dialogSpy().mockImplementation(() => {
      throw new Error('dialog 用不了')
    })

    expect(() => processHandlers.get('uncaughtException')?.(new Error('x'))).not.toThrow()
    expect(await waitForLogFile()).toContain('Error dialog could not be shown')
  })
})
