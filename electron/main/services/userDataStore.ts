/**
 * userData 落盘规范层
 *
 * 只负责三件事：路径、原子写、读盘失败的分类。
 * 为什么要收成一层（而不是每个模块自己写一遍）：#277 修的那个「解析失败当成用户没填」
 * 并不是 settings 独有的错——同一层上当时有两份各自私有的 tmp+rename 写盘（settings.json
 * 与组件的 installed.json），其中只有一份想了「读失败之后还能不能写」这件事。1.0.9 要往
 * 这一层加多配置与历史记录，每多一份文件就再抄一遍，那个坑就在新文件上重长一次。
 *
 * 这里刻意不 import logger：logger 自己要用下面的 logsDir()，而它的单例在模块被 import
 * 的那一刻就 new 出来了，反向依赖会撞成一个初始化环。所以「要留痕但不致命」的分支
 * （比如备份没成）通过 onBackupFailure 交回调用方——措辞归调用方，机制归这里。
 */
import { app } from 'electron'
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 整个主进程只有这一处向 Electron 要 userData 根目录 */
export function userDataRoot(): string {
  return app.getPath('userData')
}

/**
 * 根目录下的一层路径。叶子文件名仍由拥有它的模块决定（引擎可执行名带不带 .exe、
 * 模型目录用上游仓库名，这些是它们的领域知识，不该上浮到这一层）。
 */
export function userDataPath(...segments: string[]): string {
  return join(userDataRoot(), ...segments)
}

/** 日志目录：logger 写它，「打开日志文件夹」用它，两处必须是同一个地方 */
export function logsDir(): string {
  return userDataPath('logs')
}

/**
 * 按需组件的根目录（引擎二进制、模型、installed.json 都在这层下面）。
 * #230 的下载器把东西写在这里，约定与 yt-dlp 那份的 `userData/bin` 同源：应用可写、
 * 升级安装包不会动它，只是按组件 id 再分一层，好按版本摆放与整体回收。
 */
export function componentsDir(): string {
  return userDataPath('components')
}

/** 词库更新落地的目录（安装包自带的只读副本在 resources，不在这里） */
export function dictionaryDir(): string {
  return userDataPath('dictionary')
}

/**
 * 配置文件与它的历史副本都平铺在根目录，不分子目录。
 * 这不是随手选的：界面文案教用户去「打开数据目录」找 settings.json.corrupt-*，
 * 清扫也是按这个前缀在同一层过滤——挪进子目录会同时改掉这两处的正确性。
 */
export function settingsFile(): string {
  return userDataPath('settings.json')
}

/** 解不开的原件改名留档时用的文件名前缀；清扫按它筛，界面上的提示也引用它 */
export const CORRUPT_SETTINGS_PREFIX = 'settings.json.corrupt-'

export function corruptSettingsName(stamp: string): string {
  return `${CORRUPT_SETTINGS_PREFIX}${stamp}`
}

/** errno 的 code 是给用户看的那句里唯一有信息量的部分（EACCES / EISDIR / EROFS 处置各不同） */
export function errnoDetail(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code
  const message = err instanceof Error ? err.message : String(err)
  return code ? `${code}: ${message}` : message
}

/** 文件名里用的时间戳，零填充到秒，字典序＝时间序，清扫时按名字排序即可 */
export function fileStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
}

/**
 * 读一个 JSON 文件的四种结局。分成四种而不是「try/catch 给默认值」，
 * 是因为这四种的下一步动作本来就不一样：
 * - missing：文件本来就不存在。首次运行就是这样，这不是故障，报给界面只会吓到人。
 * - corrupt：内容拿到了但解不开（半截写入、手改坏、解得开却不是对象）。原件还在原位，
 *   谁读它都会再坏一次，所以调用方应当把它改名留档再从默认值继续。
 * - unreadable：连内容都没拿到（权限、只读介质、它是个目录）。这时候内存里的默认值
 *   纯属猜测，写下去就是盖掉用户的东西——调用方应当拦住写盘。
 */
export type ReadJsonResult<T extends object> =
  | { status: 'ok'; value: T }
  | { status: 'missing' }
  | { status: 'corrupt'; detail: string }
  | { status: 'unreadable'; detail: string }

export async function readJsonFile<T extends object = Record<string, unknown>>(
  file: string
): Promise<ReadJsonResult<T>> {
  let text: string
  try {
    text = await readFile(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'unreadable', detail: errnoDetail(err) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { status: 'corrupt', detail: err instanceof Error ? err.message : String(err) }
  }
  // 空文件走上面的 SyntaxError；'null'、'42'、'[1,2]'、'"asr"' 解得开但不会是配置，
  // 主动归到 corrupt，免得被当成一份合法配置读进去再原样写回去。
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'corrupt', detail: '文件内容不是一个 JSON 对象' }
  }
  return { status: 'ok', value: parsed as T }
}

export interface AtomicWriteOptions {
  /** 替换前把上一份复制成 `<file>.bak`。首次写入没有上一份，那不算故障 */
  backup?: boolean
  /**
   * 备份没成的留痕口子（原子写本身仍然是主菜，所以这不抛错）。
   * 不传就等于选择「不要这一条痕迹」，所以调用方要么传要么写明为什么不需要。
   */
  onBackupFailure?: (detail: string) => void
}

/**
 * 唯一的写盘出口：先写 `<file>.tmp` 再 rename。
 * 裸 writeFile 在崩溃或断电时会留下半截文件，而那半截正是下次启动读不出来的原因——
 * 原子写保的是「不会坏」，可选的 .bak 保的是「坏了还能退」。
 * 中途失败一定把 .tmp 清掉：留着下次就是「磁盘上有个没人认领的临时文件」。
 */
export async function atomicWriteJson(
  file: string,
  value: unknown,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const tmp = `${file}.tmp`
  await mkdir(dirname(file), { recursive: true })
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2))
    if (options.backup) {
      try {
        await copyFile(file, `${file}.bak`)
      } catch (err) {
        // 首次保存压根没有上一份，ENOENT 不是故障，别给它留一行 WARN 让人以为出了事
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          options.onBackupFailure?.(errnoDetail(err))
        }
      }
    }
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * 同前缀的历史副本只留最新 keep 份（坏盘的话每次启动都会留一份，不能把数据目录变成垃圾场）。
 * 清扫失败从不影响主流程：多留几份老文件只是难看，把刚保住的原件搭进去才是事故。
 */
export async function pruneOlderCopies(prefix: string, keep: number): Promise<void> {
  const dir = userDataRoot()
  try {
    const names = (await readdir(dir)).filter((name) => name.startsWith(prefix)).sort()
    for (const old of names.slice(0, Math.max(0, names.length - keep))) {
      await rm(join(dir, old), { force: true })
    }
  } catch {
    /* 保住的档已经够了，多余的老档交给下次 */
  }
}
