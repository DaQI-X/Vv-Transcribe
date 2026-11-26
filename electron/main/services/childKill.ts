/**
 * 一次性子进程的 kill 升级：发完 SIGTERM 必须还有一手 SIGKILL。
 *
 * 单独成文件的理由：调用方普遍是「超时 → kill → 等 exit 事件」，而卡在不可中断 I/O 里
 * （网络盘、被挂的文件系统）或自己接了 SIGTERM 的进程永远不会发那个事件——
 * 那条 Promise 就落地不了，本来用来兜底的超时反而成了新的挂死点。
 * 常驻引擎（asrServiceManager / localTtsEngine）另有 ensureTreeGone 按进程组收，
 * 这里管的是 ffmpeg / ffprobe / yt-dlp 这一批「跑完就该没」的孩子。
 */
import type { ChildProcess } from 'node:child_process'
import { logger } from './logger'

/**
 * SIGTERM 之后留这么久再补刀。5 秒够 ffmpeg 把手里写了一半的 WAV 收尾（它是收到信号就退，
 * 不需要跑完任务），也短到不会让人对着一个已经决定放弃的操作再等一轮。
 */
export const KILL_GRACE_MS = 5_000

/**
 * label 只为了日志能指出是哪一家（同一时刻可能同时有 ffprobe 与 yt-dlp 在收）。
 * 没有返回值：调用方原来怎么处理 exit/close 一律不改，这里只保证那个事件会来。
 */
export function terminateWithEscalation(proc: ChildProcess, graceMs = KILL_GRACE_MS, label = ''): void {
  try {
    proc.kill('SIGTERM')
  } catch (err) {
    logger.warn('ChildKill', 'SIGTERM failed', {
      label,
      pid: proc.pid,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const timer = setTimeout(() => {
    // 这两个字段任一非空就说明进程已经退了（Node 在 exit 事件里填），不用再补刀
    if (proc.exitCode !== null || proc.signalCode !== null) return
    logger.warn('ChildKill', 'process ignored SIGTERM, escalating to SIGKILL', { label, pid: proc.pid })
    try {
      proc.kill('SIGKILL')
    } catch (err) {
      logger.warn('ChildKill', 'SIGKILL failed', {
        label,
        pid: proc.pid,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, graceMs)
  // unref：这一枪是「别让子进程拖住我们」的兜底，反过来把它算成主进程还有活要干的理由就说反了
  timer.unref()
}
