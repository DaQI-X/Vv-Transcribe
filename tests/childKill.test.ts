/**
 * SIGTERM 叫不动的进程，这一层得把它升到 SIGKILL（#428）。
 *
 * 判据用真子进程跑（唯一的例外写在最后那条 ESRCH 用例里，理由也写在那儿）。
 * 这条链路存在的理由恰好是「`proc.kill()` 返回 true，进程却还在」——
 * 拿桩对象断言「kill 被调了两次」只能证明代码调了两次，证不了那个 PID 最后真的没了；
 * 而留下那一个才是用户在活动监视器里看得见、还占着素材文件的东西。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { KILL_GRACE_MS, terminateWithEscalation } from '../electron/main/services/childKill'

/** Windows 上没有 SIGTERM/SIGKILL 这套语义，这条链路在 Win 上是 Node 的 TerminateProcess，不必假测 */
const posixOnly = process.platform === 'win32' ? describe.skip : describe

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function spawnResponsive() {
  return spawn('/bin/sh', ['-c', 'exec sleep 30'], { stdio: 'ignore' })
}

/**
 * 起一个「收到 SIGTERM 也不退」的真进程，并等它把 trap 装好。
 *
 * 不等这一步会测出一条假通过：trap 是 shell 起来、执行到那一句之后才生效的，而本模块第一枪
 * 就在几毫秒内打出去——那时它还是个听得懂 TERM 的普通进程，SIGTERM 就叫停了，升级那一段
 * 根本没被走到，判据却仍然是绿的。
 *
 * `exec` 那一句是让 sh 换成 sleep 本身：不然 KILL 掉的是壳，底下的 sleep 变成孤儿继续跑。
 * trap 的「忽略」态按 POSIX 会穿过 exec 保留下来，所以这一条真能挡住 SIGTERM。
 */
function startStubborn(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', 'trap "" TERM; echo ready; exec sleep 30'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    const timer = setTimeout(() => reject(new Error('赖着不走的子进程没能在 5 秒内就位')), 5_000)
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      if (!out.includes('ready')) return
      clearTimeout(timer)
      // trap 已经装上了：此后打得出去的 TERM 都只会落空，能弄死它的只剩 KILL
      resolve(child)
    })
  })
}

/** 等 exit 事件；「5 秒内没退」要变成失败，而不是让用例挂在那 */
function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('子进程在 5 秒内没有退出')), 5_000)
    timer.unref()
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

/** 把 kill 记下来，用来证明「升级只在该升级的时候发生」；返回的仍是同一个进程对象 */
function recordKills(child: ChildProcess): string[] {
  const signals: string[] = []
  const rawKill = child.kill.bind(child)
  const wrapped = (signal?: NodeJS.Signals | number) => {
    signals.push(typeof signal === 'string' ? signal : 'default')
    return rawKill(signal)
  }
  Object.defineProperty(child, 'kill', { value: wrapped, configurable: true })
  return signals
}

posixOnly('terminateWithEscalation', () => {
  const children: ChildProcess[] = []

  afterEach(() => {
    // 断言失败时也要收干净，别给测试跑剩下十几个 sleep 30
    for (const child of children) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退了 */
      }
      // 只等 exit 不等 close：那一根 stdout 要显式关掉，否则用例之后还留着活口
      child.stdout?.destroy()
    }
    children.length = 0
  })

  it('听得懂 SIGTERM 的那种：一趟就叫停了，不会补第二枪', async () => {
    const child = spawnResponsive()
    children.push(child)
    const signals = recordKills(child)

    terminateWithEscalation(child, 300, 'test-responsive')
    const { signal } = await waitForExit(child)

    expect(signal).toBe('SIGTERM')
    // 等过宽限期再看第二眼：那一枪是排了队的，但进程已经退了，它不该真打出去
    await sleep(400)
    expect(signals).toEqual(['SIGTERM'])
  })

  it('赖着 SIGTERM 不走的：到点被 SIGKILL 掉，而且确实等了宽限期', async () => {
    const child = await startStubborn()
    children.push(child)
    const signals = recordKills(child)

    const startedAt = Date.now()
    terminateWithEscalation(child, 300, 'test-stubborn')
    const { signal } = await waitForExit(child)

    // 这一档 TERM 被 trap 掉了，能让它消失的只有 KILL——这正是要保的那一条
    expect(signal).toBe('SIGKILL')
    // 没到宽限期就动手等于跳过「优雅退出」那一步，而 ffmpeg 收尾半截 WAV 靠的就是那一趟 TERM
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('已经退过的进程：只发那一次 TERM，不再补刀', async () => {
    const child = spawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' })
    children.push(child)
    const { code } = await waitForExit(child)
    const signals = recordKills(child)

    terminateWithEscalation(child, 40, 'test-exited')
    // 等过宽限期再断言：这条判的是「那一枪到点没有打出去」，早看它当然还没有
    await sleep(200)

    expect(code).toBe(0)
    expect(signals).toEqual(['SIGTERM'])
  })

  it('kill 自己抛错（进程刚被别处收掉）不许把调用方带崩', async () => {
    // 这一条是全套里唯一用假对象的：真进程的 kill(...) 打不动只返回 false、压根不会抛，
    // 而这里要判的是「抛出来的东西会不会顺着调用栈回到超时那一段，把兜底变成新的故障」
    const proc = {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill: () => {
        throw new Error('ESRCH: no such process')
      },
    } as unknown as ChildProcess

    expect(() => terminateWithEscalation(proc, 30, 'test-esrch')).not.toThrow()
    // 补刀那一枪是在 timer 里打的，那里的抛错没人接就等于 uncaughtException：等过宽限期再看一次
    await sleep(120)
  })

  it('宽限期有默认值，调用方不必每处自己写一个数', () => {
    expect(KILL_GRACE_MS).toBeGreaterThan(0)
    const child = spawnResponsive()
    children.push(child)
    const signals = recordKills(child)
    expect(() => terminateWithEscalation(child)).not.toThrow()
    expect(signals).toEqual(['SIGTERM'])
  })
})
