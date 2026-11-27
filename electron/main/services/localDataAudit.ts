/**
 * 本机数据与缓存的清单和出口（#416）
 *
 * 为什么需要这一层：界面上原先只有一格「配音片段缓存」能清东西（#362），其余落点
 * （日志、词库更新副本、按需组件、引擎旧路的 HF 缓存、历史、设置）只能靠「打开数据目录」
 * 让用户自己在访达/资源管理器里挑。卸载残留那次实测（#415）说明这条路对普通用户等于没有：
 * 几百 MB 的权重与 461MB 的共享 blob 就留在 home 目录里，而且没人知道自己留了。
 *
 * 三条口径钉在这里，界面不许自己发明：
 * 1. **数出来的体积要和别处念的同一个数**。按需组件那一项直接取 `listComponents()` 的每行
 *    `bytes`（与「按需组件」面板顶部那句「合计占用」同源），不在这里再走一遍目录——
 *    #438 之所以要收口，就是因为同屏出现过「147.9MB」和「138MB」两个数指同一份权重。
 * 2. **默认只勾可丢弃的派生物**。组件/历史/设置三项默认不勾：删组件要重新下 147.9MB/486.2MB，
 *    删历史与设置找不回来。用户必须自己把它们勾上，弹窗才会动它们。
 * 3. **动文件之前先看有没有人正在用**。配音在跑、引擎还活着的时候不许删它们指着的东西；
 *    这一条不新写判式，走 `removeComponent()` 与 `clearClipCache()` 已有的那道闸门，
 *    拒绝的原话逐条回给用户（同一个理由在组件面板里已经说过一遍了）。
 *
 * `hub/` 那一层的共享 blob（本机实测 461MB 住在 `hub/blobs/42/`，仓库目录里只有软链）是
 * 清干净的关键，也是最容易越界的地方：只按 `.refs` 里点名「这一枚只被我们那两档引过」来回收，
 * 认不出来的（没有 .refs、读不出来、还引着别的仓库）一律留下，宁可少删不删错。
 */
import { readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CORRUPT_HISTORY_PREFIX,
  CORRUPT_SETTINGS_PREFIX,
  dictionaryDir,
  errnoDetail,
  logsDir,
  recordsDir,
  settingsFile,
  userDataPath,
  userDataRoot,
} from './userDataStore'
import { asrEngineRepoDirs, hubCacheDir } from './asrModelUsage'
import { clearClipCache, clipCacheStats } from './ttsClipCache'
import { activeMediaTempDirs, MEDIA_TEMP_PREFIX } from './urlDownloader'
import { listComponents, removeComponent } from './componentService'
import { hasActiveTTSSynthesis } from './ttsService'
import { isLocalEngineRunning as isLocalAsrEngineRunning } from './asrServiceManager'
import { logger } from './logger'
// 体积只有这一把尺：note 那句和同屏组件行的「占用 486.2MB」并排出现，自己拼 /1e6 就是第二个出处
// （#438 收口过）。主进程 import 渲染层这枚函数有先例：componentService、ytDlpUpdate 都走相对路径
import { formatBytes } from '../../../src/utils/formatBytes'

const TAG = 'localData'

/** 弹窗里分成三段显示，顺序也按这个：先能安全清的，再要重新下的，最后是删了找不回来的 */
export type LocalDataGroup = 'cache' | 'component' | 'personal'

export interface LocalDataItem {
  id: string
  group: LocalDataGroup
  label: string
  /** 一句「这是什么、删了会怎样」，界面直接印，不再另写一份文案 */
  detail: string
  /** 打开弹窗时默认勾不勾：只有纯派生物默认勾 */
  defaultOn: boolean
  bytes: number
  /** 段数/文件数；这一项整个读不出来时为 null */
  files: number | null
  /** 这一项体积读不出来时给的原因；非空时那个 0 不许被读成「没占地方」 */
  error: string | null
}

export interface LocalDataAudit {
  items: LocalDataItem[]
  /** 默认勾上的那几项合计 */
  cacheBytes: number
  totalBytes: number
  error: string | null
}

export interface LocalDataClearResult {
  ok: boolean
  freed: number
  /** 成功清掉的 id */
  cleared: string[]
  /** 没能清掉的，带原话；界面逐条念 */
  failed: { id: string; error: string }[]
  /** 不算故障、但用户应当知道的那一句（例如「共享 blob 里还有别家模型的权重，没动」） */
  note: string | null
  error: string | null
}

interface ItemSpec {
  id: string
  group: LocalDataGroup
  label: string
  detail: string
  defaultOn: boolean
  size: () => Promise<{ bytes: number; files: number; error: string | null }>
  clear: () => Promise<{ freed: number; error: string | null; note?: string | null }>
}

/** 目录/文件求和。软链按 stat 到的真身算，悬空软链与读不到的条目跳过但记一句 error */
async function walk(target: string): Promise<{ bytes: number; files: number; error: string | null }> {
  let info
  try {
    info = await stat(target)
  } catch (err) {
    // 不存在是正常答案（新用户从没配过音），不是故障
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: 0, files: 0, error: null }
    return { bytes: 0, files: 0, error: errnoDetail(err) }
  }
  if (!info.isDirectory()) return { bytes: info.size, files: 1, error: null }
  let entries
  try {
    entries = await readdir(target, { withFileTypes: true })
  } catch (err) {
    return { bytes: 0, files: 0, error: errnoDetail(err) }
  }
  let bytes = 0
  let files = 0
  let error: string | null = null
  for (const entry of entries) {
    const sub = await walk(join(target, entry.name))
    bytes += sub.bytes
    files += sub.files
    if (sub.error && !error) error = sub.error
  }
  return { bytes, files, error }
}

/** 根目录那一层按前缀捡出来的散档（settings.json.corrupt-* 这类） */
async function looseFiles(prefix: string, dir = userDataRoot()): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.startsWith(prefix)).map((name) => join(dir, name))
  } catch {
    return []
  }
}

async function sumFiles(paths: string[]): Promise<{ bytes: number; files: number; error: string | null }> {
  let bytes = 0
  let files = 0
  let error: string | null = null
  for (const path of paths) {
    const sub = await walk(path)
    bytes += sub.bytes
    files += sub.files
    if (sub.error && !error) error = sub.error
  }
  return { bytes, files, error }
}

async function removeTree(target: string): Promise<{ freed: number; error: string | null }> {
  const { bytes, error } = await walk(target)
  if (error) return { freed: 0, error }
  try {
    await rm(target, { recursive: true, force: true })
    return { freed: bytes, error: null }
  } catch (err) {
    return { freed: 0, error: `${errnoDetail(err)}（${target}）` }
  }
}

/**
 * 把 `hub/` 共享存储里只属于我们那两档的权重回收掉。
 *
 * `blobPath` 是删仓库目录**之前**收集的真身路径（删完就再也解析不到了）。
 * 判式只用 huggingface_hub 自己写的那份 `.refs`：每一行是一个引用者（`<仓库目录>/blobs/<sha>`），
 * 行行都指向我们正删的那两档才动手。没有 .refs、读不出来、或还指着别家仓库的一律留下——
 * 少回收几十 MB 是难看，删掉别人正在用的是事故。
 */
async function reclaimSharedBlobs(blobPaths: string[], repoNames: string[]): Promise<{ freed: number; keptBytes: number }> {
  const hub = hubCacheDir()
  let freed = 0
  let keptBytes = 0
  for (const blob of blobPaths) {
    // 仓库目录自己那层 blobs 已经随整目录删掉了，这里只管住在 hub 那一层的
    if (!blob.startsWith(join(hub, 'blobs'))) continue
    let size = 0
    try {
      size = (await stat(blob)).size
    } catch {
      continue
    }
    let refs: string[]
    try {
      refs = (await readFile(`${blob}.refs`, 'utf-8')).split('\n').map((line) => line.trim()).filter(Boolean)
    } catch {
      keptBytes += size
      continue
    }
    if (refs.length === 0 || !refs.every((line) => repoNames.some((repo) => line.startsWith(`${repo}/`)))) {
      keptBytes += size
      continue
    }
    try {
      await rm(blob, { force: true })
      await rm(`${blob}.refs`, { force: true })
      await rm(`${blob}.lock`, { force: true })
      freed += size
    } catch {
      keptBytes += size
    }
  }
  return { freed, keptBytes }
}

/** 列一层目录的名字；不存在回空数组（那是「没下过」，不是读失败） */
async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/**
 * 删引擎旧路那棵 HF 缓存树，并回收只被它引用的共享 blob。
 * 删掉的字节不进上层 `freed`（那一笔由组件行的差值统算，见 clearComponents），只落日志；
 * 要带回界面的是「还有多少因为被别家模型引着所以没动」。
 */
async function clearEngineCache(): Promise<{ note: string | null }> {
  const repos = asrEngineRepoDirs()
  const repoNames = repos.map((dir) => basename(dir))
  // 真身要在删仓库目录之前解析：软链一没，就再也不知道 461MB 那枚住在 `hub/blobs/42/` 的哪一层。
  // 只走快照那一层就够——`realpath` 会把「快照 → 仓库 blobs → hub blobs」两跳一次到底，
  // 仓库自己 blobs/ 里的真身则随整目录一起删掉。
  const blobs = new Set<string>()
  for (const repo of repos) {
    const snapshots = join(repo, 'snapshots')
    for (const rev of await listNames(snapshots)) {
      const dir = join(snapshots, rev)
      for (const name of await listNames(dir)) {
        try {
          const real = await realpath(join(dir, name))
          if ((await stat(real)).isFile()) blobs.add(real)
        } catch {
          /* 悬空软链：目标本来就没落盘，不占地方 */
        }
      }
    }
  }
  let freed = 0
  for (const repo of repos) {
    freed += (await removeTree(repo)).freed
    await rm(join(hubCacheDir(), '.locks', basename(repo)), { recursive: true, force: true }).catch(() => {})
  }
  const reclaimed = await reclaimSharedBlobs([...blobs], repoNames)
  freed += reclaimed.freed
  logger.info(TAG, 'engine weight cache cleared', { freed, keptBytes: reclaimed.keptBytes })
  return {
    note:
      reclaimed.keptBytes > 0
        ? `共享缓存里还有 ${formatBytes(reclaimed.keptBytes)} 被别的模型引着，那部分没动`
        : null,
  }
}

/** /tmp 下我们自己的那批临时目录：正在被会话占着的跳过 */
async function mediaTempDirs(): Promise<string[]> {
  const inUse = new Set(activeMediaTempDirs())
  try {
    const root = tmpdir()
    const names = await readdir(root)
    return names.filter((n) => n.startsWith(MEDIA_TEMP_PREFIX)).map((n) => join(root, n)).filter((p) => !inUse.has(p))
  } catch {
    return []
  }
}

async function sizeMedia(): Promise<{ bytes: number; files: number; error: string | null }> {
  let bytes = 0
  let files = 0
  let error: string | null = null
  for (const dir of await mediaTempDirs()) {
    const sub = await walk(dir)
    bytes += sub.bytes
    files += sub.files
    if (sub.error && !error) error = sub.error
  }
  return { bytes, files, error }
}

async function clearMedia(): Promise<{ freed: number; error: string | null }> {
  let freed = 0
  let error: string | null = null
  for (const dir of await mediaTempDirs()) {
    const out = await removeTree(dir)
    freed += out.freed
    if (out.error && !error) error = out.error
  }
  return { freed, error }
}

async function sizeDir(target: string): Promise<{ bytes: number; files: number; error: string | null }> {
  return walk(target)
}

/**
 * 清一层目录，但把这层壳留着——整层删掉会把「删完会自己长回来」这句界面文案演成谎话。
 *
 * 运行日志那一档是触发点：logger 的 mkdir 卡在 `initialized` 那道闸门后面（logger.ts:54 只在
 * 第一次写时跑），目录没了它不会重建，之后每一行 `appendFile` 都撞 ENOENT、只进 console
 * （logger.ts:158 那个 catch）。真机上点一次「清空日志」，这一轮剩下的排查记录就全丢了，
 * 而那正是导出诊断包要拿的东西。留壳删内容后 app.log 由 appendFile 自己长回来；
 * 轮转计数会偏大，但 ensureRoom 挪不动时按「没轮转」继续写，不会写爆也不会吞行。
 * 词库、yt-dlp 副本、历史记录那几档同理：留个空目录不占地方，不必赌各自写盘路径有没有 mkdir。
 */
async function clearDir(target: string): Promise<{ freed: number; error: string | null }> {
  const stats = await walk(target)
  if (stats.error) return { freed: 0, error: stats.error }
  let names: string[]
  try {
    names = await readdir(target)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // 这一层本来就没有（新用户从没跑过）是正常答案；站着的若是文件，就没有壳可留，整份删
    if (code === 'ENOENT') return { freed: 0, error: null }
    if (code === 'ENOTDIR') return removeTree(target)
    return { freed: 0, error: `${errnoDetail(err)}（${target}）` }
  }
  return clearFiles(names.map((name) => join(target, name)))
}

/** 散档一起删：任何一个读不出来都要说，不能悄悄漏 */
async function clearFiles(paths: string[]): Promise<{ freed: number; error: string | null }> {
  let freed = 0
  let error: string | null = null
  for (const path of paths) {
    const out = await removeTree(path)
    freed += out.freed
    if (out.error && !error) error = out.error
  }
  return { freed, error }
}

/**
 * 「按需组件」这一项占多少：面板每行的 `bytes` 之和，加那份记账文件。
 * 直接取行值不另走一遍目录——#438 收口就是因为同屏出现过两个数指同一份权重。
 */
async function componentsFootprint(): Promise<{ bytes: number; files: number; error: string | null }> {
  const installed = (await listComponents()).filter((row) => row.installed)
  const record = await walk(userDataPath('components', 'installed.json'))
  return {
    bytes: installed.reduce((sum, row) => sum + row.bytes, 0) + record.bytes,
    files: installed.length,
    error: record.error,
  }
}

/**
 * 按需组件那五行，走的都是组件面板同一套删除出口（闸门、落点、残留清扫都在那边）。
 *
 * `freed` 取「清完再量一遍」的差值，不拿各行 `bytes` 相加：一行转写权重的 `bytes` 是两棵树
 * 去重后的并集（#439 的探针），自家副本由 `removeComponent()` 收、引擎旧缓存由
 * `clearEngineCache()` 收，两笔各自再加一遍必然把并集算两次。差值还有个好处——被别家模型
 * 引着所以没删掉的共享 blob，会因为还留在盘上而自然不进 `freed`。
 */
async function clearComponents(): Promise<{ freed: number; error: string | null; note?: string | null }> {
  const before = (await componentsFootprint()).bytes
  const errors: string[] = []
  const notes: string[] = []
  for (const row of await listComponents()) {
    if (!row.installed) continue
    const out = await removeComponent(row.id)
    // 那一行的货只在引擎旧缓存里时 removeComponent 明说它删不到；这不算失败，
    // 下面 clearEngineCache 正是去删那一棵的
    if (!out.ok && !out.outsideOnly && out.error) errors.push(`${row.title}：${out.error}`)
  }
  const record = await removeTree(userDataPath('components', 'installed.json'))
  if (record.error) errors.push(record.error)
  if (isLocalAsrEngineRunning()) {
    notes.push('本地转写引擎还在跑，引擎自己拉到 HuggingFace 缓存里的那份权重这次没动（停引擎后再清一次）')
  } else {
    const engine = await clearEngineCache()
    if (engine.note) notes.push(engine.note)
  }
  return {
    freed: before - (await componentsFootprint()).bytes,
    error: errors.length ? errors.join('；') : null,
    note: notes.length ? notes.join('；') : null,
  }
}

export const SPECS: ItemSpec[] = [
  {
    id: 'clips',
    group: 'cache',
    label: '配音片段缓存',
    // 这几句原先写在设置页那格「配音片段缓存」的提示里。那一格并进这个清单了，口径必须跟着搬过来，
    // 否则「改几个字重出一版只重配改过的段」这个机制就没人知道了。
    detail:
      '同一句话、同一套配音参数配过一次就留下，改几个字重出一版时只重配改过的那几段。' +
      '换配音方案、模型、音色或倍速都会让旧片段作废，只有换 API Key 不作废（它不改听感）。' +
      '清掉不影响已经配好的音轨和历史记录，只是下一批要重新调接口',
    defaultOn: true,
    size: async () => {
      const stats = await clipCacheStats()
      return { bytes: stats.bytes, files: stats.clips, error: null }
    },
    clear: async () => {
      if (hasActiveTTSSynthesis()) return { freed: 0, error: '正在配音，先等这一批跑完再清片段缓存' }
      return { freed: await clearClipCache(), error: null }
    },
  },
  {
    id: 'media',
    group: 'cache',
    label: '临时媒体',
    detail: '转写与下载过程中拆出来的音视频，落在系统临时目录；正在播放或正在下载的那些会跳过',
    defaultOn: true,
    size: sizeMedia,
    clear: clearMedia,
  },
  {
    id: 'logs',
    group: 'cache',
    label: '运行日志',
    detail: '出问题时排查用的记录，删掉之后应用会重新写；要发给开发者请先导出诊断包',
    defaultOn: true,
    size: () => sizeDir(logsDir()),
    clear: () => clearDir(logsDir()),
  },
  {
    id: 'dictionary',
    group: 'cache',
    label: '词库更新副本',
    detail: '应用内更新下来的那版词库；删了会用安装包内置的那份，下次更新重新下载',
    defaultOn: true,
    size: () => sizeDir(dictionaryDir()),
    clear: () => clearDir(dictionaryDir()),
  },
  {
    id: 'components',
    group: 'component',
    label: '按需组件（配音引擎与模型、转写权重）',
    detail: '就是上面「按需组件」那一栏装的东西，删了下次用要重新下载；正在被引擎占用时那一项会拒绝',
    defaultOn: false,
    size: componentsFootprint,
    clear: clearComponents,
  },
  {
    id: 'ytdlp',
    group: 'component',
    label: '链接解析组件的更新副本',
    detail: '应用内更新过的 yt-dlp；删了会退回安装包内置的那一版，链接转写照样能用',
    defaultOn: false,
    size: () => sizeDir(userDataPath('bin')),
    clear: () => clearDir(userDataPath('bin')),
  },
  {
    id: 'records',
    group: 'personal',
    label: '历史记录与留住的稿子',
    detail: '删了就找不回来：转写/配音/下载的账本，以及你勾了「留住」的那些正文与音轨',
    defaultOn: false,
    size: async () => {
      const dir = await walk(recordsDir())
      const copies = await sumFiles(await looseFiles(CORRUPT_HISTORY_PREFIX, recordsDir()))
      return { bytes: dir.bytes + copies.bytes, files: dir.files, error: dir.error ?? copies.error }
    },
    clear: async () => {
      const dir = await clearDir(recordsDir())
      const copies = await clearFiles(await looseFiles(CORRUPT_HISTORY_PREFIX, recordsDir()))
      return { freed: dir.freed + copies.freed, error: dir.error ?? copies.error }
    },
  },
  {
    id: 'settings',
    group: 'personal',
    label: '设置与 API Key',
    detail:
      '删了就找不回来：转写/校对/配音的方案、界面偏好，以及加密落盘的 API Key（要重新填）。' +
      '当前会话内存里那份还在，下次保存设置会重新写出一份新的',
    defaultOn: false,
    size: async () => {
      const paths = [settingsFile(), `${settingsFile()}.bak`, ...(await looseFiles(CORRUPT_SETTINGS_PREFIX))]
      return sumFiles(paths)
    },
    clear: async () =>
      clearFiles([settingsFile(), `${settingsFile()}.bak`, ...(await looseFiles(CORRUPT_SETTINGS_PREFIX))]),
  },
]

/** 逐项体积。整颗读不出来时不返回半份清单，而是把 error 带回去让界面说「读不出来」 */
export async function auditLocalData(): Promise<LocalDataAudit> {
  const items: LocalDataItem[] = []
  let error: string | null = null
  for (const spec of SPECS) {
    try {
      const size = await spec.size()
      items.push({
        id: spec.id,
        group: spec.group,
        label: spec.label,
        detail: spec.detail,
        defaultOn: spec.defaultOn,
        bytes: size.bytes,
        files: size.error ? null : size.files,
        error: size.error,
      })
    } catch (err) {
      // 单项炸了只让那一项失去数字，别的项照样看得见；但界面必须知道这一栏是不全的
      error = `${spec.label}：${err instanceof Error ? err.message : String(err)}`
      items.push({
        id: spec.id,
        group: spec.group,
        label: spec.label,
        detail: spec.detail,
        defaultOn: spec.defaultOn,
        bytes: 0,
        files: null,
        error: error,
      })
    }
  }
  const cacheBytes = items.filter((i) => i.defaultOn).reduce((sum, i) => sum + i.bytes, 0)
  const totalBytes = items.reduce((sum, i) => sum + i.bytes, 0)
  return { items, cacheBytes, totalBytes, error }
}

/**
 * 按勾选项删除。未知 id 直接拒绝（白名单就是上面那份 SPECS，界面传什么都删不到别的路径）。
 * 一项失败不会中断其余项，成功/失败各自带原话回，界面逐条念——用户勾了六项，
 * 不该因为其中一项被引擎占着就前五项白删。
 */
export async function clearLocalData(ids: string[]): Promise<LocalDataClearResult> {
  const picked = SPECS.filter((spec) => ids.includes(spec.id))
  const unknown = ids.filter((id) => !SPECS.some((spec) => spec.id === id))
  if (unknown.length) {
    return { ok: false, freed: 0, cleared: [], failed: [], note: null, error: `不认识的清理项：${unknown.join('、')}` }
  }
  if (picked.length === 0) {
    return { ok: false, freed: 0, cleared: [], failed: [], note: null, error: '没有勾选任何要清理的项目' }
  }
  let freed = 0
  const cleared: string[] = []
  const failed: { id: string; error: string }[] = []
  const notes: string[] = []
  for (const spec of picked) {
    try {
      const out = await spec.clear()
      if (out.note) notes.push(out.note)
      if (out.error) failed.push({ id: spec.id, error: out.error })
      else cleared.push(spec.id)
      freed += out.freed
    } catch (err) {
      failed.push({ id: spec.id, error: errnoDetail(err) })
    }
  }
  logger.userAction('Local data cleared', { ids: cleared, freed, failed: failed.map((f) => f.id) })
  return {
    ok: failed.length === 0,
    freed,
    cleared,
    failed,
    note: notes.length ? notes.join('；') : null,
    error: null,
  }
}
