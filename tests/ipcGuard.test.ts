/**
 * #280 的判据测试：IPC 收口这一层本身
 *
 * 这一层存在的理由只有一条——「不跨 IPC 抛错」以前只是注释。所以测的是三件事：
 * ① 任何抛出（同步的、reject 的、连失败值都造不出来的）最后都必须落成一个**值**，绝不留下 reject；
 * ② 那个值必须是这条通道自己声明的形状，不是通用形状；
 * ③ 落进 app.log 的载荷只有通道名和原因，机制自己不往里面加入参（入参是用户的整份文稿和文件路径）。
 * 外加一条结构判据：electron/ 下 `ipcMain.handle(` 只许出现在 guard.ts 里。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { failErrorOnly, failOkError, failSuccessError, ipcHandle } from '../electron/main/ipc/guard'

const loggerErrors = vi.hoisted(() => vi.fn())

vi.mock('../electron/main/services/logger', () => ({
  logger: {
    error: loggerErrors,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    serviceError: vi.fn(),
  },
}))

/** 每次注册都收进这里，测试按通道名取那条真正的 wrapper */
type Wrapper = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
let registered: Map<string, Wrapper>

beforeEach(() => {
  registered = new Map()
  vi.spyOn(ipcMain, 'handle').mockImplementation(((channel: string, fn: Wrapper) => {
    registered.set(channel, fn)
    // ipcMain.handle 的返回类型在 Electron  typings 里是 void，这里照它回一个 undefined
  }) as never)
  loggerErrors.mockClear()
})

const event = {} as IpcMainInvokeEvent

function call(channel: string, ...args: unknown[]) {
  const wrapper = registered.get(channel)
  if (!wrapper) throw new Error(`通道 ${channel} 没注册，测试前提就不成立`)
  return wrapper(event, ...args)
}

describe('ipcHandle：抛出必须变成值', () => {
  it('成功时原样回 handler 的结果，且不落日志', async () => {
    ipcHandle('demo:ok', async () => ({ ok: true, error: null }), failOkError)
    await expect(call('demo:ok')).resolves.toEqual({ ok: true, error: null })
    expect(loggerErrors).not.toHaveBeenCalled()
  })

  it('handler reject 时用这条通道自己声明的失败形状，而不是通用形状', async () => {
    ipcHandle(
      'demo:async',
      async () => {
        throw new Error('模型没下载')
      },
      () => ({ success: false, reason: 'gone', error: '模型没下载' })
    )
    await expect(call('demo:async')).resolves.toEqual({
      success: false,
      reason: 'gone',
      error: '模型没下载',
    })
  })

  it('同步抛（参数一进来就炸）一样收得住', async () => {
    ipcHandle(
      'demo:sync',
      () => {
        // 这一条专门测「await 写在 try 里面」：少了那层 await，这个 throw 直接穿过注册函数变回 reject
        throw new Error('读参数就炸了')
      },
      failOkError
    )
    await expect(call('demo:sync')).resolves.toEqual({ ok: false, error: '读参数就炸了' })
  })

  it('失败值拿到原因和原始入参（proofread:explain 那类要按 differences 的条数回等长清单）', async () => {
    const seen: unknown[] = []
    ipcHandle(
      'demo:args',
      async () => {
        throw new Error('解释失败')
      },
      (message, _event, ...args) => {
        seen.push(message, ...args)
        return { results: [], error: message }
      }
    )
    await expect(call('demo:args', [{ a: 1 }, { a: 2 }])).resolves.toEqual({
      results: [],
      error: '解释失败',
    })
    expect(seen).toEqual(['解释失败', [{ a: 1 }, { a: 2 }]])
  })

  it('异步的失败值会被 await，跨 IPC 不许留下一个 Promise', async () => {
    ipcHandle(
      'demo:asyncFail',
      async () => {
        throw new Error('磁盘读不出')
      },
      async () => ({ value: await Promise.resolve('读过了'), error: '磁盘读不出' })
    )
    expect(await call('demo:asyncFail')).toEqual({ value: '读过了', error: '磁盘读不出' })
  })

  it('连失败值都造不出来时回兜底形状，而且不许把自己变回 reject', async () => {
    ipcHandle(
      'demo:failThrows',
      async () => {
        throw new Error('原始故障')
      },
      () => {
        throw new Error('构造失败值这一步自己也炸了')
      }
    )
    await expect(call('demo:failThrows')).resolves.toEqual({ error: '原始故障' })
    // 两句都要有：一句说通道没跑成，一句说它的失败形状也没造出来——只留后者就查不到源头
    const messages = loggerErrors.mock.calls.map((c) => String(c[1]))
    expect(messages).toContain('demo:failThrows did not complete')
    expect(messages).toContain('demo:failThrows could not build its failure value')
  })

  it('非 Error 的抛出物转字符串；空 message 的 Error 退回 name；对象退回那句通用文案', async () => {
    ipcHandle(
      'demo:throwString',
      async () => {
        throw '子进程自己退了'
      },
      failErrorOnly
    )
    await expect(call('demo:throwString')).resolves.toEqual({ error: '子进程自己退了' })

    ipcHandle(
      'demo:emptyMessage',
      async () => {
        throw new RangeError('')
      },
      failErrorOnly
    )
    await expect(call('demo:emptyMessage')).resolves.toEqual({ error: 'RangeError' })

    ipcHandle(
      'demo:bareObject',
      async () => {
        throw { code: 'E_UNKNOWN' }
      },
      failErrorOnly
    )
    await expect(call('demo:bareObject')).resolves.toEqual({ error: '操作失败' })
  })
})

describe('ipcHandle 的日志载荷', () => {
  it('只有 channel 和 message 两个键，机制不把入参塞进去', async () => {
    ipcHandle(
      'demo:privacy',
      async (_event, _text: string) => {
        throw new Error('写入失败')
      },
      failOkError
    )
    await call('demo:privacy', '这是用户整份文稿，里面有嘉宾姓名')
    expect(loggerErrors).toHaveBeenCalledTimes(1)
    const [tag, message, data] = loggerErrors.mock.calls[0]
    expect(tag).toBe('IPC')
    expect(message).toBe('demo:privacy did not complete')
    expect(Object.keys(data as object).sort()).toEqual(['channel', 'message'])
    expect(JSON.stringify(data)).not.toContain('嘉宾姓名')
  })
})

describe('共享的失败预设', () => {
  it('三种既有形状各有一份，字段名不许改', () => {
    expect(failOkError('坏了', event)).toEqual({ ok: false, error: '坏了' })
    expect(failSuccessError('坏了', event)).toEqual({ success: false, error: '坏了' })
    expect(failErrorOnly('坏了', event)).toEqual({ error: '坏了' })
  })
})

describe('判据：注册只能走 ipcHandle', () => {
  async function collectTs(dir: string): Promise<string[]> {
    const out: string[] = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...(await collectTs(path)))
      else if (entry.name.endsWith('.ts')) out.push(path)
    }
    return out
  }

  it('ipcMain.handle 只存在于 guard.ts 这一处', async () => {
    const files = await collectTs(join(process.cwd(), 'electron'))
    const holders: string[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf-8')
      if (source.includes('ipcMain.handle(')) holders.push(file.replace(`${process.cwd()}/`, ''))
    }
    expect(holders).toEqual(['electron/main/ipc/guard.ts'])
  })
})
