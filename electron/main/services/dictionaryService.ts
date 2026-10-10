/**
 * 中文词典服务
 * 集成 pwxcoo/chinese-xinhua 开源词库，提供词语和成语的释义查询
 * 
 * 数据加载优先级：用户更新目录（userData/dictionary/）> 内置资源目录（resources/dictionary/）
 * 更新机制：通过 GitHub API 获取最新 commit hash，对比本地版本，从 raw.githubusercontent.com 下载数据
 * 缓存策略：启动时一次性加载到内存（Map），查询时 O(1) 命中
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

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
let currentVersion: string = '0.0.0'

const SOURCE_REPO = 'pwxcoo/chinese-xinhua'
const SOURCE_BRANCH = 'master'
const RAW_BASE = `https://raw.githubusercontent.com/${SOURCE_REPO}/${SOURCE_BRANCH}/data`
const GITHUB_API = `https://api.github.com/repos/${SOURCE_REPO}`

function getBuiltinDictionaryPath(): string {
  if (process.env.VITE_DEV_SERVER_URL) {
    return join(import.meta.dirname, '../../electron/resources/dictionary')
  }
  return join(process.resourcesPath, 'resources/dictionary')
}

function getUpdateDictionaryPath(): string {
  return join(app.getPath('userData'), 'dictionary')
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

async function loadDictionaryFile(filePath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const raw = await readFile(filePath, 'utf-8')
    const data = JSON.parse(raw) as Array<{ ci?: string; word?: string; explanation: string }>

    for (const entry of data) {
      const term = entry.ci || entry.word
      if (term && entry.explanation) {
        map.set(term, entry.explanation)
      }
    }
  } catch (error) {
    console.error(`Failed to load dictionary file ${filePath}:`, error)
  }
  return map
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
  console.log(`[Dictionary] Loaded builtin v${currentVersion}: ${words.size} words, ${idioms.size} idioms`)
}

async function initializeFromUpdate(): Promise<boolean> {
  const updatePath = getUpdateDictionaryPath()
  const versionInfo = await loadVersionInfo(updatePath)

  if (!versionInfo) return false

  const ciPath = join(updatePath, 'ci.json')
  const idiomPath = join(updatePath, 'idiom.json')

  if (!(await fileExists(ciPath)) || !(await fileExists(idiomPath))) return false

  const [words, idioms] = await Promise.all([
    loadDictionaryFile(ciPath),
    loadDictionaryFile(idiomPath),
  ])

  if (words.size === 0 && idioms.size === 0) return false

  dictionaryCache = { words, idioms }
  currentVersion = versionInfo.version
  console.log(`[Dictionary] Loaded updated v${currentVersion} (commit: ${versionInfo.commitHash.slice(0, 7)}): ${words.size} words, ${idioms.size} idioms`)
  return true
}

export async function initDictionary(): Promise<void> {
  if (dictionaryCache) return

  const hasUpdate = await initializeFromUpdate()
  if (!hasUpdate) {
    await initializeFromBuiltin()
  }
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

export async function checkForUpdate(): Promise<{ hasUpdate: boolean; latestCommit?: string; currentVersion: string }> {
  try {
    const latestCommit = await getLatestCommitHash()
    if (!latestCommit) {
      return { hasUpdate: false, currentVersion }
    }

    const builtinPath = getBuiltinDictionaryPath()
    const builtinVersion = await loadVersionInfo(builtinPath)
    const updatePath = getUpdateDictionaryPath()
    const updateVersion = await loadVersionInfo(updatePath)

    const currentCommit = updateVersion?.commitHash || builtinVersion?.commitHash || ''

    if (currentCommit === latestCommit) {
      return { hasUpdate: false, currentVersion }
    }

    return {
      hasUpdate: true,
      latestCommit: latestCommit.slice(0, 7),
      currentVersion,
    }
  } catch (error) {
    console.error('[Dictionary] Failed to check for update:', error)
    return { hasUpdate: false, currentVersion }
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

    for (const filename of filesToDownload) {
      const url = `${RAW_BASE}/${filename}`
      const fileResponse = await fetch(url)

      if (!fileResponse.ok) {
        return { success: false, error: `下载 ${filename} 失败 (${fileResponse.status})` }
      }

      const content = await fileResponse.text()
      await writeFile(join(updatePath, filename), content, 'utf-8')
    }

    const versionInfo: VersionInfo = {
      version: '2.0.0',
      commitHash: latestCommit,
      updatedAt: new Date().toISOString(),
    }
    await writeFile(join(updatePath, 'version.json'), JSON.stringify(versionInfo, null, 2), 'utf-8')

    dictionaryCache = null
    await initDictionary()

    console.log(`[Dictionary] Updated to commit ${latestCommit.slice(0, 7)}`)
    return { success: true }
  } catch (error) {
    console.error('[Dictionary] Failed to download update:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export function getCurrentVersion(): string {
  return currentVersion
}
