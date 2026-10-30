/**
 * 日志轮转（#281 的另一半）。
 *
 * 落盘这一层有两条闸门：脱敏在 `logRedact` 那边测，这一份测的是**尺寸**——
 * 以前的规矩是「只有一个 app.log，永远往上 append」。本机那份打包应用的日志从 10 月 11 日
 * 起一路写到 3,113,607 字节（约 3MB）还是一个文件，再写下去用户「打开日志文件夹」发回来的
 * 那份迟早连邮件附件上限都过不去，等于现场交付不了。
 * 所以这几条用例问的都是同一类问题：**该挪的时候挪了没、挪的时候这一行丢了没**：
 * 1. 顶到上限就把 app.log 整份挪成 app.1.log，新份开头补一句「轮转过」，
 *    否则读日志的人只看到时间戳突然跳一段，不知道是应用重启还是日志被清。
 * 2. 旧档一路往后推，但只留 3 份——第 4 份起最老的丢掉，磁盘占用有上界。
 * 3. 计数从盘上已有的大小起步：应用重启不能把那 4.9MB 当成 0 再写一轮。
 * 4. 挪不动（目录只读、旧档被占）时这一行还得落盘：轮转失败只是超个上限，
 *    把崩溃前的最后一行一起赔掉才是真损失。
 * 5. 崩溃兜底的 `errorSync` 与常规 `write` 走同样的两条闸门——它才是最需要日志的那条路。
 */
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
  chmodSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEEP_ROTATIONS, MAX_LOG_BYTES } from '../electron/main/services/logger'

type LoggerModule = typeof import('../electron/main/services/logger')

let dir = ''
let logDir = ''
let service: LoggerModule

/**
 * logger 的单例在模块被 import 的那一刻 new 出来，目录当场算死，
 * 所以换目录必须排在 import 之前；每条用例都要一份全新的计数，
 * 否则上一条写掉的字节会决定这一条轮不轮转。
 */
async function loadInto(freshDir: string): Promise<void> {
  vi.resetModules()
  vi.spyOn(app, 'getPath').mockImplementation(
    ((name: string) => (name === 'userData' ? freshDir : join(freshDir, name))) as typeof app.getPath
  )
  service = await import('../electron/main/services/logger')
}

/**
 * 造一份「已经写到某个字节数」的日志：truncate 出来的是稀疏文件，内容只有一行标记，
 * 但 stat 看到的体积就是真体积——测 5MB 上限不必真写 5MB。
 * 最后一笔要把末位补成一个换行：不补的话后面 append 的那条 JSON 会粘在补位的 `\0` 尾巴上，
 * `lines()` 一过滤就把真日志行当成补位丢掉了。
 */
function seed(name: string, bytes: number, marker = ''): void {
  const fd = openSync(join(logDir, name), 'w')
  if (marker) writeSync(fd, marker)
  ftruncateSync(fd, bytes)
  writeSync(fd, '\n', bytes - 1)
  closeSync(fd)
}

/** appendFile 走的是 fs/promises，等一个 tick 才落盘 */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30))
}

/**
 * 稀疏种子文件里补位用的 `\0` 不是日志行，`OLD` 那种标记行也不是——只收真正的 JSON 行，
 * 否则「第几行是什么」全看补了多少个零，断言就成了猜。
 */
function lines(name = 'app.log'): string[] {
  return readFileSync(join(logDir, name), 'utf-8')
    .split('\n')
    .filter((line) => line.startsWith('{'))
}

function parseAll(name = 'app.log'): Array<Record<string, unknown>> {
  return lines(name).map((line) => JSON.parse(line) as Record<string, unknown>)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vv-rotate-'))
  logDir = join(dir, 'logs')
  mkdirSync(logDir, { recursive: true })
  await loadInto(dir)
})

afterEach(async () => {
  // 只读目录留到删的时候只会得到一句 EACCES
  try {
    chmodSync(logDir, 0o755)
  } catch {
    // 目录可能已经不在了
  }
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('到上限就把 app.log 挪走', () => {
  it('顶到上限的那一条先把旧档挪成 app.1.log，新份开头补一句轮转说明', async () => {
    seed('app.log', MAX_LOG_BYTES - 8, 'OLD\n')
    await service.logger.info('Test', '顶到上限之后的第一条')
    await settled()

    expect(existsSync(join(logDir, 'app.1.log'))).toBe(true)
    expect(readFileSync(join(logDir, 'app.1.log'), 'utf-8')).toContain('OLD')

    const entries = parseAll()
    expect(entries).toHaveLength(2)
    expect(String(entries[0].message)).toContain('日志轮转')
    expect(entries[0].module).toBe('Logger')
    expect(entries[1].message).toBe('顶到上限之后的第一条')
    // 说明行自己也得是一行能 parse 的 JSON，不然工具链在中间就断了
    expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('还没到上限就别轮转：一份 app.log、一行、没有说明', async () => {
    seed('app.log', 1024, 'OLD\n')
    await service.logger.info('Test', '离上限还远')
    await settled()

    expect(existsSync(join(logDir, 'app.1.log'))).toBe(false)
    expect(lines()).toHaveLength(1)
    expect(lines()[0]).not.toContain('日志轮转')
  })

  it('计数从盘上已有的体积起步：重启应用不能把 4.9MB 当成 0 再写一轮', async () => {
    seed('app.log', MAX_LOG_BYTES - 8, 'OLD\n')
    // 上面那次 import 之后还没写过，这一次写就是「重启后的第一条」
    await service.logger.warn('Test', '重启后的第一条')
    await settled()
    expect(existsSync(join(logDir, 'app.1.log'))).toBe(true)
  })

  it('旧档一路往后推，但只留 3 份，最老的那一档被丢掉', async () => {
    seed('app.log', MAX_LOG_BYTES - 8, 'CUR\n')
    seed('app.1.log', 16, 'P1\n')
    seed('app.2.log', 16, 'P2\n')
    seed('app.3.log', 16, 'P3\n')

    await service.logger.info('Test', '又写满一次')
    await settled()

    expect(readFileSync(join(logDir, 'app.1.log'), 'utf-8')).toContain('CUR')
    expect(readFileSync(join(logDir, 'app.2.log'), 'utf-8')).toContain('P1')
    expect(readFileSync(join(logDir, 'app.3.log'), 'utf-8')).toContain('P2')
    // P3 是被挤出去的那一份；第四档压根不许存在，否则上限就成了「留几份」的玩笑
    expect(existsSync(join(logDir, 'app.4.log'))).toBe(false)
    expect(readFileSync(join(logDir, 'app.3.log'), 'utf-8')).not.toContain('P3')
  })

  it('轮转后新 app.log 的体积重新起算，不会连着再挪一次', async () => {
    seed('app.log', MAX_LOG_BYTES - 8, 'OLD\n')
    await service.logger.info('Test', '第一条')
    await service.logger.info('Test', '第二条')
    await service.logger.info('Test', '第三条')
    await settled()

    expect(parseAll()).toHaveLength(4)
    expect(existsSync(join(logDir, 'app.2.log'))).toBe(false)
  })
})

describe('挪不动的时候，这一行不能一起赔进去', () => {
  it('日志目录只读（rename 会失败）时仍然落盘', async () => {
    seed('app.log', MAX_LOG_BYTES - 8, 'OLD\n')
    seed('app.1.log', 16, 'P1\n')
    chmodSync(logDir, 0o555)

    service.logger.errorSync('Test', '目录只读时的一条错误')

    // errorSync 是同步的，不需要等 tick——这正是崩溃路径用它的原因
    expect(readFileSync(join(logDir, 'app.1.log'), 'utf-8')).toContain('P1')
    expect(lines().some((line) => line.includes('目录只读时的一条错误'))).toBe(true)
    // 没挪成就不许写那句「旧的移到 app.1.log」：旧档明明还在原地，读了会当成功挪走
    expect(lines().some((line) => line.includes('日志轮转'))).toBe(false)
  })

  it('目录只读时常规 write 也不抛，调用点拿得到 Promise 的正常完成', async () => {
    seed('app.log', MAX_LOG_BYTES - 8, 'OLD\n')
    chmodSync(logDir, 0o555)
    await expect(service.logger.info('Test', '只读目录里的一条')).resolves.toBeUndefined()
    await settled()
    expect(lines().some((line) => line.includes('只读目录里的一条'))).toBe(true)
  })
})

describe('崩溃路径与常规路径共用同一套闸门', () => {
  it('errorSync 也轮转，并且当场就能在磁盘上看到（不等事件循环）', () => {
    seed('app.log', MAX_LOG_BYTES - 8, 'OLD\n')
    service.logger.errorSync('Crash', '渲染进程没了')
    expect(existsSync(join(logDir, 'app.1.log'))).toBe(true)
    const last = parseAll().at(-1) as Record<string, unknown>
    expect(last.message).toBe('渲染进程没了')
    expect(last.level).toBe('ERROR')
  })

  it('errorSync 也脱敏：绝对路径进不了盘', () => {
    seed('app.log', 16, 'OLD\n')
    service.logger.errorSync('Crash', '读取 /Users/daqi/Movies/采访第3期.mp3 失败', {
      filePath: '/Users/daqi/Movies/采访第3期.mp3',
    })
    const raw = lines().at(-1) as string
    expect(raw).not.toContain('/Users/daqi')
    expect(raw).toContain('采访第3期.mp3')
  })

  it('控制台与文件说的是同一句话：脱敏只跑一遍，不会截图和日志对不上', async () => {
    const seen: unknown[][] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      seen.push(args)
    })
    seed('app.log', 16, 'OLD\n')
    await service.logger.info('Test', '打开 /Users/daqi/Movies/a.mp4 失败', { apiKey: 'SECRETVALUE123' })
    await settled()

    const spoken = seen.find((args) => args[0] === '[INFO][Test]')
    expect(spoken, '控制台那句没找到').toBeTruthy()
    const disk = parseAll().at(-1) as { message: string; data: Record<string, unknown> }
    expect(spoken?.[1]).toBe(disk.message)
    expect(JSON.stringify(spoken?.[2])).toBe(JSON.stringify(disk.data))
    expect(spy).toHaveBeenCalled()
  })
})

describe('留几份是有上界的', () => {
  it('常量确实是 5MB 与 3 份——README 与网站文案都按这两个数字写', () => {
    expect(MAX_LOG_BYTES).toBe(5 * 1024 * 1024)
    expect(KEEP_ROTATIONS).toBe(3)
  })

  it('连写六轮之后 logs/ 里最多只有 app.log 加 3 份旧档', async () => {
    for (let round = 0; round < 6; round++) {
      // 每轮重灌一次模块＝当作应用重启：内存计数重新开始，才会去 stat 盘上那份 5MB。
      // 不重灌的话第一轮之后计数就还是小的，再怎么写都不轮转。
      await loadInto(dir)
      seed('app.log', MAX_LOG_BYTES - 8, `ROUND-${round}\n`)
      await service.logger.info('Test', `第 ${round} 轮`)
      await settled()
    }
    const names = ['app.log', 'app.1.log', 'app.2.log', 'app.3.log', 'app.4.log']
    const present = names.filter((name) => existsSync(join(logDir, name)))
    expect(present).toEqual(['app.log', 'app.1.log', 'app.2.log', 'app.3.log'])
    expect(present.length).toBe(KEEP_ROTATIONS + 1)
  })
})
