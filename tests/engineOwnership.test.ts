/**
 * `engineOwnership.ts` 的归属判定（#445）
 *
 * 这一档要钉死的是「**什么情况下绝对不许动端口上的进程**」。#128/#129 当年为了修「应用被强杀后
 * 引擎作为孤儿永远占着 8000」，把回收判式写成了「可执行文件名对得上我们自己的二进制就收」，
 * 于是顺手多出一条没被想到的路径：另一份正在运行的 Vv Transcribe 的引擎**同名**，
 * 后起的那一份在 app ready（`electron/main/index.ts` 无条件 `startASRService()`）那一刻
 * 会把前一份正在用的引擎连根 SIGKILL，对面的转写/配音当场截断且毫无解释。
 *
 * 这里用假的进程表（`node:child_process` 的 execFile 被替身接走），因为真机上「另一份实例正拿着
 * 引擎」这种状态没法在 CI 里稳定造出来。测的是判式本身，四类结论都要落住：
 *
 * 1. 残尸（树顶挂在 launchd 上）→ 可以收，且**引导进程也要收**（漏了它就把那份临时解包目录留在磁盘上）。
 * 2. 有主（树顶挂在一份还活着的别的进程上）→ 不收，且交出的 pids 必须是空——调用方就是拿这个列表去杀的。
 * 3. 父号已经是个死号（Windows 的 `ParentProcessId` 不随父进程退出而改写）→ 仍算孤儿，
 *    守住的是 #129 那条自愈在 Windows 上不能因为新判式而退化。
 * 4. 判不了（监听者自己问不出父号 / 层数走完没到顶）→ 不收，宁可让用户重启一次应用。
 *
 * 另加两条纪律：`parentOf` 的 pid 要先钉成整数再拼命令（拼进 PowerShell `-Command` 的那一路是命令注入面）；
 * ASR 与配音两侧必须共用这一个判式、且杀进程一定排在闸门之后（各写一份迟早会漂，漂了就总有一边还在互杀）。
 *
 * ⚠️ 只测 darwin/linux 那一路的 `ps`。Windows 的 `powershell Get-CimInstance` 与 `tasklist` 两条分支
 * 在这台 macOS 上跑不到，得靠 #410 的 Windows 环境手测，别当成已验。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeProc {
  ppid: number
  /** true = 可执行文件名对得上我们自己的二进制（真机上由调用方的 `isOurEngine` 问 `ps -o comm=`） */
  engine: boolean
}

/** 假进程表：pid → 记录。缺号即代表「这个进程不存在」，与真机 `ps` 非零退出对齐 */
const table = vi.hoisted(() => ({ current: new Map<number, FakeProc>() }))
const calls = vi.hoisted(() => ({ execFile: [] as string[][] }))

/**
 * `parentOf` 问 `ps -o ppid= -p N`，`processAlive` 问 `ps -p N -o pid=`（两种参数顺序不同，
 * 所以靠 `-p` 后面那个数取 pid，再用 `-o` 的值分辨问的是哪一列）。
 */
vi.mock('node:child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string) => void
  ) => {
    calls.execFile.push([cmd, ...args])
    const pid = Number(args[args.indexOf('-p') + 1])
    const proc = table.current.get(pid)
    if (cmd !== 'ps' || !proc) return cb(new Error('no such process'), '')
    if (args.includes('ppid=')) return cb(null, `  ${proc.ppid}\n`)
    if (args.includes('pid=')) return cb(null, `${pid}\n`)
    return cb(new Error('unhandled ps query'), '')
  },
}))

const { classifyEngineTrees, parentOf } = await import('../electron/main/services/engineOwnership')

/** 监听者：PyInstaller 形状里真正 LISTEN 端口的那个 Python 子进程 */
const LISTENER = 400
/** 引导进程：我们的直接子进程，握着那份 _MEI 临时解包目录 */
const BOOTLOADER = 300

function putEngine(pid: number, ppid: number) {
  table.current.set(pid, { ppid, engine: true })
}
function putOther(pid: number, ppid: number) {
  table.current.set(pid, { ppid, engine: false })
}

/** 与上层调用方同一条判式：只看二进制名 */
const isEngine = async (pid: number) => table.current.get(pid)?.engine === true

beforeEach(() => {
  table.current.clear()
  calls.execFile.length = 0
})

describe('classifyEngineTrees：只有确认是残尸才交得出进程号', () => {
  it('残尸：监听者 → 引导进程 → launchd，两层都要收进列表', async () => {
    putEngine(LISTENER, BOOTLOADER)
    putEngine(BOOTLOADER, 1)
    const out = await classifyEngineTrees([LISTENER], isEngine)
    expect(out.verdict).toBe('clear-to-reap')
    // 只杀监听者会把引导进程留下，那份临时解包目录就没人删了
    expect([...out.pids].sort((a, b) => a - b)).toEqual([BOOTLOADER, LISTENER])
    // 顺带钉住替身真在链路上（这两问就是判式读进程表的全部动作）
    expect(calls.execFile).toEqual([
      ['ps', '-o', 'ppid=', '-p', '400'],
      ['ps', '-o', 'ppid=', '-p', '300'],
    ])
  })

  it('双开：树顶挂在另一份活着的实例上 → 不收，一个进程号都不交出', async () => {
    putEngine(LISTENER, BOOTLOADER)
    // 这一棵整树都是我们的二进制（另一份实例起的），差别只在于它上面还挂着一份活着的 Electron
    putEngine(BOOTLOADER, 200)
    putOther(200, 1)
    const out = await classifyEngineTrees([LISTENER], isEngine)
    expect(out.verdict).toBe('held-by-live-instance')
    // 调用方拿 pids 去 SIGKILL，这里必须是空
    expect(out.pids).toEqual([])
    // 走到「爹还活着」这一问才收手，前面已经把整棵树都看过一遍了
    expect(calls.execFile).toEqual([
      ['ps', '-o', 'ppid=', '-p', '400'],
      ['ps', '-o', 'ppid=', '-p', '300'],
      ['ps', '-p', '200', '-o', 'pid='],
    ])
  })

  it('只有一个监听者、它自己就是孤儿 → 收', async () => {
    putEngine(LISTENER, 1)
    expect(await classifyEngineTrees([LISTENER], isEngine)).toEqual({
      verdict: 'clear-to-reap',
      pids: [LISTENER],
    })
  })

  it('父号就是我们自己（应用内「重启引擎」没退净）→ 收', async () => {
    putEngine(LISTENER, process.pid)
    const out = await classifyEngineTrees([LISTENER], isEngine)
    expect(out.verdict).toBe('clear-to-reap')
    expect(out.pids).toEqual([LISTENER])
  })

  it('父号已死（Windows 上父进程退了但号还留着）→ 仍算孤儿', async () => {
    putEngine(LISTENER, BOOTLOADER)
    // 300 的爹是 999，而 999 不在表里 = 那个号已经作废；这正是 Windows 上强杀残尸的形状
    putEngine(BOOTLOADER, 999)
    const out = await classifyEngineTrees([LISTENER], isEngine)
    // 这一条退化就等于把 #129 的自愈在 Windows 上静默关掉
    expect(out.verdict).toBe('clear-to-reap')
    expect([...out.pids].sort((a, b) => a - b)).toEqual([BOOTLOADER, LISTENER])
  })

  it('两个监听者，只要有一棵有主 → 整批都不碰', async () => {
    putEngine(LISTENER, 1) // 这棵确实是残尸，本来能收
    putEngine(LISTENER + 10, BOOTLOADER + 10)
    putEngine(BOOTLOADER + 10, 200)
    putOther(200, 1)
    const out = await classifyEngineTrees([LISTENER, LISTENER + 10], isEngine)
    // 一刀切歪的代价是打断别人正在跑的活儿，所以保守的一方赢
    expect(out.verdict).toBe('held-by-live-instance')
    expect(out.pids).toEqual([])
  })

  it('监听者问不出父号 → 判不了，不收', async () => {
    // 表里没有 400：`ps` 非零退出，capture 一律给空串
    const out = await classifyEngineTrees([LISTENER], isEngine)
    expect(out.verdict).toBe('undeterminable')
    expect(out.pids).toEqual([])
  })

  it('深得不正常的树（层数走完还没到顶）→ 判不了，不去猜', async () => {
    for (let pid = 500; pid < 520; pid++) putEngine(pid, pid + 1)
    putEngine(520, 1)
    const out = await classifyEngineTrees([500], isEngine)
    expect(out.verdict).toBe('undeterminable')
    expect(out.pids).toEqual([])
  })

  it('判定过程中不碰任何杀进程的动作', async () => {
    // 归属判定只读进程表；SIGKILL 是调用方的事，混进来就没法「判完再收手」
    putEngine(LISTENER, BOOTLOADER)
    putEngine(BOOTLOADER, 1)
    const kill = vi.spyOn(process, 'kill')
    await classifyEngineTrees([LISTENER], isEngine)
    expect(kill).not.toHaveBeenCalled()
    kill.mockRestore()
  })
})

describe('parentOf：拼命令之前先把 pid 钉成整数', () => {
  it.each([0, -1, 1.5, Number.NaN, '8000', '1 || rm -rf /', undefined, null])(
    '非整数/非正数（%p）不落到命令行上',
    async (raw) => {
      expect(await parentOf(raw as number)).toBeNull()
      expect(calls.execFile).toEqual([])
    }
  )

  it('合法 pid 才走 ps 取父号', async () => {
    putEngine(BOOTLOADER, 1)
    expect(await parentOf(BOOTLOADER)).toBe(1)
    expect(calls.execFile).toEqual([['ps', '-o', 'ppid=', '-p', '300']])
  })
})

describe('两侧回收链路：共用判式，且杀进程排在闸门之后', () => {
  const targets = [
    '../electron/main/services/asrServiceManager.ts',
    '../electron/main/services/localTtsEngine.ts',
  ]

  it('ASR 与配音都 import 并调用 classifyEngineTrees，不再自己读 ppid', async () => {
    const { readFileSync } = await import('node:fs')
    for (const rel of targets) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf-8')
      expect(src).toContain("from './engineOwnership'")
      expect(src).toContain('classifyEngineTrees(targets, isOurEngine)')
      // 自己写一份 ppid 判式正是这条缺陷的源头：两边必须都走同一个门
      expect(src).not.toContain("'ppid='")
      // 两种「不收」要分开报：判不出归属不能对用户说成「另一份在用」
      expect(src).toContain('held-by-other-instance')
      expect(src).toContain('unknown-owner')
    }
  })

  it('reapForeignEngine 里，SIGKILL 只出现在 verdict 闸门返回之后', async () => {
    const { readFileSync } = await import('node:fs')
    for (const rel of targets) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf-8')
      const start = src.indexOf('async function reapForeignEngine(')
      expect(start).toBeGreaterThan(-1)
      // 顶层函数的收尾大括号是唯一顶格的
      const body = src.slice(start, src.indexOf('\n}', start))
      const gate = body.indexOf("trees.verdict !== 'clear-to-reap'")
      const kill = body.indexOf('process.kill(')
      expect(gate).toBeGreaterThan(-1)
      expect(kill).toBeGreaterThan(gate)
      // 闸门那一段必须自己 return 掉，不能只是包个 if
      expect(body.slice(gate, kill)).toContain('return outcome')
    }
  })
})
