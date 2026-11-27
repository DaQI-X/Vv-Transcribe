/**
 * 端口上那棵引擎进程树归谁（#445）
 *
 * 背景：`asrServiceManager`（8000）与 `localTtsEngine`（8010）都靠「可执行文件名对得上我们自己的
 * 二进制」认定端口上躺着的是**上一代残尸**，然后 SIGKILL 整棵树。这个判式是为了修「应用被强杀后
 * 引擎作为孤儿永远占着端口」（#128/#129），可它漏了一件事：**另一个正在运行的实例**的引擎同名。
 * 于是双开（正式版 + 开发版、或升级时新旧两份叠着跑）时，后起的那一份会在自己 app ready 那一刻
 * （`electron/main/index.ts` 无条件 `startASRService()`）把前一份正在用的引擎连根杀掉，
 * 对面那一轮的转写/配音当场截断，而且用户看不到任何解释。#274 那次排查看到的「第二个 ASR 进程
 * 抢 8000 失败」是同一个撞口的另一面。
 *
 * 真正的残尸和「有主」的引擎在进程表上是可以分开的：残尸的整棵树亲爹已经没了，最顶上那一层
 * 会被系统收走（macOS 是 launchd，ppid==1）；有主的那棵，树顶挂在一份还活着的 Electron 上。
 * 所以这里只回答一个问题——**这棵树能不能收**——判不了就当不能收：回收是尽力而为，
 * 误杀的代价（打断别人正在跑的活儿）比少杀一次（用户重启应用还在）大得多。
 */
import { execFile } from 'node:child_process'

/** 往上走几层就停：正常只有「监听者 → PyInstaller 引导进程」两层，多走是给异常留的余量 */
const MAX_HOPS = 8

export type TreeVerdict =
  /** 树顶挂在一份还活着的别的进程上（＝另一份实例在用），不能收 */
  | 'held-by-live-instance'
  /** 树里有进程的父进程查不出来，或层数走完还没到顶——判不了，不能收 */
  | 'undeterminable'
  /** 树顶的亲爹是系统（ppid==1）、就是我们自己、或者已经是个死号：残尸，可以收 */
  | 'clear-to-reap'

export interface ClassifiedTrees {
  verdict: TreeVerdict;
  /** verdict 为可收时，这些树的完整进程号（含 PyInstaller 引导进程，得一并收） */
  pids: number[];
}

/** 跑一条本机命令取 stdout；命令缺失、超时、报错一律空串——归属判定是尽力而为，不能拖垮启动 */
function capture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout))
  })
}

/**
 * 这个进程的父进程号；查不到返回 null。
 *
 * Windows 那一路不能用 `wmic`：Win11 24H2 起默认不再安装，命令缺失会一路退到 null，
 * 于是每一棵树都判成「判不了」，残尸再也收不掉。`Get-CimInstance` 慢一点（要起一个 PowerShell），
 * 但这条只在端口上真有人应答时才跑，一次启动最多几趟。
 */
export async function parentOf(pid: number): Promise<number | null> {
  // pid 要拼进 PowerShell 的 -Command，先把它钉死成一个整数再拼
  if (!Number.isInteger(pid) || pid < 1) return null
  if (process.platform === 'win32') {
    const out = await capture('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
    ])
    const ppid = Number(out.trim())
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null
  }
  const out = await capture('ps', ['-o', 'ppid=', '-p', String(pid)])
  const ppid = Number(out.trim())
  return Number.isInteger(ppid) && ppid > 0 ? ppid : null
}

/**
 * 这个进程号现在还在不在。
 *
 * Windows 上非要有这一问不可：父进程退出后 `ParentProcessId` 仍留着那个已经作废的号（不像
 * macOS/Linux 会把它改挂在 launchd/init 下），只看 ppid 会把每一次「应用被强杀后的残尸」
 * 都误判成「另一个实例正在用」，#129 那条自愈就白修了。
 */
async function processAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid < 1) return false
  if (process.platform === 'win32') {
    const out = await capture('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
    return out.includes(`"${pid}"`)
  }
  const out = await capture('ps', ['-p', String(pid), '-o', 'pid='])
  return out.trim().split(/\s+/).includes(String(pid))
}

/**
 * 把端口上的引擎进程树判一次归属。
 *
 * 从每个监听者往上走，只要父进程也是我们的二进制就继续走（PyInstaller 的引导进程握着那份临时
 * 解包目录，只杀监听者会留下它）。走到顶之后看树顶的爹：ppid==1 是被系统收走的孤儿，
 * ppid==本进程是自己这轮没退净，爹那个号已经死了同样算孤儿——三种都可以收；
 * 挂在别的活进程上就是**另一份实例在用**，不收。
 * 多个监听者时取最保守的判定：只要有一棵有主，整批都不碰，免得一刀切歪。
 */
export async function classifyEngineTrees(
  listeners: number[],
  isOurEngine: (pid: number) => Promise<boolean>,
): Promise<ClassifiedTrees> {
  const pids: number[] = []

  for (const listener of listeners) {
    pids.push(listener)
    let cursor = listener
    let reachedTop = false
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const ppid = await parentOf(cursor)
      if (ppid === null) {
        // 树走到一半查不动了：进程可能刚退，也可能命令没跑成。判不了就不收整批
        return { verdict: 'undeterminable', pids: [] }
      }
      if (ppid === 1 || ppid === process.pid) {
        reachedTop = true // 系统收走的孤儿 / 自己这轮的引擎
        break
      }
      if (await isOurEngine(ppid)) {
        pids.push(ppid)
        cursor = ppid
        continue
      }
      if (!(await processAlive(ppid))) {
        reachedTop = true // 爹已经退了，只剩那个号（Windows 常见）
        break
      }
      return { verdict: 'held-by-live-instance', pids: [] }
    }
    // 层数走完还没到顶：这棵树深得不正常，判不了
    if (!reachedTop) return { verdict: 'undeterminable', pids: [] }
  }

  return { verdict: 'clear-to-reap', pids: [...new Set(pids)] }
}
