/**
 * 中文词典服务
 * 集成 pwxcoo/chinese-xinhua 开源词库，提供词语和成语的释义查询
 * 
 * 数据加载优先级：用户更新目录（userData/dictionary/）> 内置资源目录（resources/dictionary/）
 * 更新机制：通过 GitHub API 获取最新 commit hash，对比本地版本，从 raw.githubusercontent.com 下载数据
 * 缓存策略：启动时一次性加载到内存（Map），查询时 O(1) 命中
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { dictionaryDir } from './userDataStore'
import { logger } from './logger'

const TAG = 'Dictionary'

interface DictionaryData {
  words: Map<string, string>
  idioms: Map<string, string>
}

interface VersionInfo {
  version: string
  commitHash: string
  updatedAt: string
}

let dictionaryCache: DictionaryData | null = null
// 在飞的那一次读盘：`dictionaryCache` 要等两份 JSON 都解完才赋值，只按它判空等于没判
let initTask: Promise<void> | null = null
let currentVersion: string = '0.0.0'

const SOURCE_REPO = 'pwxcoo/chinese-xinhua'
const SOURCE_BRANCH = 'master'
const RAW_BASE = `https://raw.githubusercontent.com/${SOURCE_REPO}/${SOURCE_BRANCH}/data`
const GITHUB_API = `https://api.github.com/repos/${SOURCE_REPO}`

/**
 * 词库两份数据的指纹，按 2026-11-21 实测钉死（那两份的 SHA2-256 与随包 resources/dictionary 下的
 * 同名文件逐字节相等，所以这条闸门不会把「刚装上就点更新」的正常路径判成篡改）。
 *
 * 钉在这里而不是清单里，是因为上游那个仓库的 data/ 最后一次提交是 2018-12-16，八年没动过；
 * 「跟着上游走」这条需求今天不值钱，而「下载来的东西原样落盘」值钱。真遇到上游更新时的做法是：
 * 人工核一遍新内容（词库这东西没有自动化能判对错），再把这两个指纹连同数据一起改，随版走。
 */
const DICTIONARY_CHECKSUMS: Record<string, { bytes: number; sha256: string }> = {
  'ci.json': {
    bytes: 26_129_191,
    sha256: '739e086d61dc9b95cd1df92095720e6391f952a41c476d3281ef95ebed869a09',
  },
  'idiom.json': {
    bytes: 10_319_857,
    sha256: '1d4b4f454ce1c416d6a1ab2369d6e66c0ff99e04390172eef70790499e21ce19',
  },
}

/**
 * 校验一份下载到的词库数据，返回 null 表示通过，否则返回要给用户看的原因。
 * 抽成纯函数：这一步是整个词库更新里唯一「错了不报错、静默把坏数据当新的用」的地方，
 * 拿真字节喂它比在链路上加日志可靠。
 */
export function verifyDictionaryBytes(
  filename: string,
  received: Buffer
): string | null {
  const pinned = DICTIONARY_CHECKSUMS[filename]
  if (!pinned) return `词库里没有 ${filename} 这份数据`
  if (received.length !== pinned.bytes) {
    // 这里不能图省事用 formatBytes：截断 1000 字节会被两边都收成同一个「10.3MB」，
    // 给用户读出来就是「只收到 10.3MB，与钉死的 10.3MB 不符」——一句听不出问题的话
    return `${filename} 收到 ${received.length.toLocaleString('en-US')} 字节，与钉死的 ${pinned.bytes.toLocaleString('en-US')} 字节不符`
  }
  const digest = createHash('sha256').update(received).digest('hex')
  if (digest !== pinned.sha256) {
    return `${filename} 的指纹和钉死的那份对不上（${digest.slice(0, 12)}… ≠ ${pinned.sha256.slice(0, 12)}…）`
  }
  return null
}

function getBuiltinDictionaryPath(): string {
  if (process.env.VITE_DEV_SERVER_URL) {
    return join(import.meta.dirname, '../../electron/resources/dictionary')
  }
  return join(process.resourcesPath, 'resources/dictionary')
}

function getUpdateDictionaryPath(): string {
  return dictionaryDir()
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function loadVersionInfo(dictPath: string): Promise<VersionInfo | null> {
  try {
    const versionPath = join(dictPath, 'version.json')
    if (!(await fileExists(versionPath))) return null
    const raw = await readFile(versionPath, 'utf-8')
    return JSON.parse(raw) as VersionInfo
  } catch {
    return null
  }
}

function parseDictionaryEntries(raw: string): Map<string, string> {
  const map = new Map<string, string>()
  const data = JSON.parse(raw) as Array<{ ci?: string; word?: string; explanation: string }>

  for (const entry of data) {
    const term = entry.ci || entry.word
    if (term && entry.explanation) {
      map.set(term, entry.explanation)
    }
  }
  return map
}

async function loadDictionaryFile(filePath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    return parseDictionaryEntries(await readFile(filePath, 'utf-8'))
  } catch (error) {
    // 路径原样交出去：脱敏那一步把它收成文件名（#123 那种「调用点自己记得写 basename」在这里不再需要）
    logger.error(TAG, 'Failed to load dictionary file', { file: filePath, error })
    return map
  }
}

async function ensureUpdateDir(): Promise<void> {
  const updatePath = getUpdateDictionaryPath()
  await mkdir(updatePath, { recursive: true })
}

async function initializeFromBuiltin(): Promise<void> {
  const builtinPath = getBuiltinDictionaryPath()
  const versionInfo = await loadVersionInfo(builtinPath)

  const [words, idioms] = await Promise.all([
    loadDictionaryFile(join(builtinPath, 'ci.json')),
    loadDictionaryFile(join(builtinPath, 'idiom.json')),
  ])

  dictionaryCache = { words, idioms }
  currentVersion = versionInfo?.version || '1.0.0'
  logger.info(TAG, 'Loaded builtin dictionary', { version: currentVersion, words: words.size, idioms: idioms.size })
}

async function initializeFromUpdate(): Promise<boolean> {
  const updatePath = getUpdateDictionaryPath()
  const versionInfo = await loadVersionInfo(updatePath)

  if (!versionInfo) return false

  const files = ['ci.json', 'idiom.json'] as const
  const buffers = new Map<string, Buffer>()
  try {
    for (const filename of files) {
      buffers.set(filename, await readFile(join(updatePath, filename)))
    }
  } catch {
    // 少一份、读不动都算「这份更新不存在」，退回内置那份
    return false
  }

  // 同一把闸门打在读取侧，理由在落盘侧之外还有一条：旧版代码是「下载一份写一份、写完不验」，
  // 所以盘上完全可能留着「ci.json 断了、idiom.json 是好的」这种混合态。以前只按两份都空才判失败，
  // 于是它带着零条词语被当成一次成功的更新加载进来，而 version.json 里的 commit 和远端一致，
  // checkForUpdate 永远回「已是最新」——坏状态自己不会好。现在验不过就整份退回内置，
  // 退回之后版本号又和远端不一样了，下一次检查更新会重下一遍，这才是自愈。
  for (const filename of files) {
    const mismatch = verifyDictionaryBytes(filename, buffers.get(filename)!)
    if (mismatch) {
      logger.warn(TAG, 'Updated dictionary rejected by checksum, falling back to builtin', { version: versionInfo.version, mismatch })
      return false
    }
  }

  const words = parseDictionaryEntries(buffers.get('ci.json')!.toString('utf-8'))
  const idioms = parseDictionaryEntries(buffers.get('idiom.json')!.toString('utf-8'))

  dictionaryCache = { words, idioms }
  currentVersion = versionInfo.version
  // 版本号本身就是 commit 短哈希（见下面写入 version.json 那一段），不必再重复一遍 commit
  logger.info(TAG, 'Loaded updated dictionary', { version: currentVersion, words: words.size, idioms: idioms.size })
  return true
}

/**
 * 让盘上有词库这件事只跑一次。启动时有两个调用点同时打这儿：`main/index.ts` 那串服务初始化，
 * 和 `ipc/dictionaryHandlers.ts` 注册通道时自己那一次。本机 app.log 上的现场是每次启动两行
 * `Loaded builtin dictionary`、隔 85–96 毫秒——26 万条 ci 加 3 万条成语被读进内存两遍，
 * 先起来那份还没赋值成 cache，后一家就看不到它。失败后允许重试，所以 promise 只跟在飞期间存着。
 */
export function initDictionary(): Promise<void> {
  if (dictionaryCache) return Promise.resolve()
  if (initTask) return initTask

  initTask = (async () => {
    const hasUpdate = await initializeFromUpdate()
    if (!hasUpdate) {
      await initializeFromBuiltin()
    }
  })().finally(() => {
    initTask = null
  })
  return initTask
}

export async function lookupWord(word: string): Promise<{ found: boolean; explanation?: string }> {
  if (!dictionaryCache) {
    await initDictionary()
  }

  if (!dictionaryCache) {
    return { found: false }
  }

  const explanation = dictionaryCache.words.get(word) || dictionaryCache.idioms.get(word)
  return explanation ? { found: true, explanation } : { found: false }
}

export async function lookupMultipleWords(words: string[]): Promise<Record<string, string>> {
  if (!dictionaryCache) {
    await initDictionary()
  }

  const results: Record<string, string> = {}
  if (!dictionaryCache) return results

  for (const word of words) {
    const explanation = dictionaryCache.words.get(word) || dictionaryCache.idioms.get(word)
    if (explanation) {
      results[word] = explanation
    }
  }

  return results
}

async function getLatestCommitHash(): Promise<string | null> {
  try {
    const response = await fetch(`${GITHUB_API}/commits?path=data/ci.json&per_page=1`, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
    })

    if (!response.ok) return null

    const commits = await response.json() as Array<{ sha: string }>
    return commits[0]?.sha || null
  } catch {
    return null
  }
}

export async function checkForUpdate(): Promise<{ hasUpdate: boolean; latestCommit?: string; currentVersion: string; error: string | null }> {
  const latestCommit = await getLatestCommitHash()
  if (!latestCommit) {
    // 取不到远端 commit 不等于「已是最新」，必须把失败如实回传给界面
    return { hasUpdate: false, currentVersion, error: '无法连接词库源（GitHub），请检查网络后重试' }
  }

  const builtinPath = getBuiltinDictionaryPath()
  const builtinVersion = await loadVersionInfo(builtinPath)
  const updatePath = getUpdateDictionaryPath()
  const updateVersion = await loadVersionInfo(updatePath)

  const currentCommit = updateVersion?.commitHash || builtinVersion?.commitHash || ''

  if (currentCommit === latestCommit) {
    return { hasUpdate: false, currentVersion, error: null }
  }

  return {
    hasUpdate: true,
    latestCommit: latestCommit.slice(0, 7),
    currentVersion,
    error: null,
  }
}

export async function downloadUpdate(): Promise<{ success: boolean; error?: string }> {
  try {
    const latestCommit = await getLatestCommitHash()
    if (!latestCommit) {
      return { success: false, error: '无法获取最新版本信息' }
    }

    await ensureUpdateDir()
    const updatePath = getUpdateDictionaryPath()

    const filesToDownload = ['ci.json', 'idiom.json']

    // 先全部取回、全部验过，再一份都不落盘：中途失败时上一版数据还完整留着，
    // 不会出现「ci.json 是新的、idiom.json 还是旧的」那种混合态
    const pending: Array<{ filename: string; content: Buffer }> = []
    for (const filename of filesToDownload) {
      const url = `${RAW_BASE}/${filename}`
      const fileResponse = await fetch(url)

      if (!fileResponse.ok) {
        return { success: false, error: `下载 ${filename} 失败 (${fileResponse.status})` }
      }

      // 按字节验，不走 text()：重新编码过一次 UTF-8 之后再比长度与指纹，量的就不是拿到的那份东西了
      const content = Buffer.from(await fileResponse.arrayBuffer())
      const mismatch = verifyDictionaryBytes(filename, content)
      if (mismatch) {
        logger.error(TAG, 'Dictionary update rejected by checksum', { filename, mismatch })
        return { success: false, error: mismatch }
      }
      pending.push({ filename, content })
    }

    for (const { filename, content } of pending) {
      await writeFile(join(updatePath, filename), content)
    }

    const versionInfo: VersionInfo = {
      // 用源仓库 commit 短哈希作为版本号：自增的固定值（曾经的 2.0.0）在第二次更新后就和实际数据脱节了
      version: latestCommit.slice(0, 7),
      commitHash: latestCommit,
      updatedAt: new Date().toISOString(),
    }
    await writeFile(join(updatePath, 'version.json'), JSON.stringify(versionInfo, null, 2), 'utf-8')

    dictionaryCache = null
    await initDictionary()

    logger.info(TAG, 'Dictionary updated', { commit: latestCommit.slice(0, 7) })
    return { success: true }
  } catch (error) {
    logger.error(TAG, 'Failed to download dictionary update', { error })
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export function getCurrentVersion(): string {
  return currentVersion
}
