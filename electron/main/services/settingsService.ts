/**
 * 设置持久化服务
 * 管理应用的 ASR 和 AI 配置项，以 JSON 文件形式持久化到 userData 目录
 * 支持内存缓存，避免重复读取磁盘
 */
import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

interface AppSettings {
  asrProvider: string
  asrApiKey: string
  asrApiBase: string
  asrModel: string
  aiProvider: string
  aiApiKey: string
  aiApiBase: string
  aiModel: string
}

const DEFAULT_SETTINGS: AppSettings = {
  asrProvider: 'local',
  asrApiKey: '',
  asrApiBase: '',
  asrModel: '',
  aiProvider: 'openai',
  aiApiKey: '',
  aiApiBase: '',
  aiModel: '',
}

let cachedSettings: AppSettings | null = null

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export async function loadSettings(): Promise<AppSettings> {
  if (cachedSettings) return { ...cachedSettings }

  try {
    const raw = await readFile(getSettingsPath(), 'utf-8')
    cachedSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    cachedSettings = { ...DEFAULT_SETTINGS }
  }

  return { ...cachedSettings }
}

export async function saveSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings()
  const merged = { ...current, ...settings }

  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(getSettingsPath(), JSON.stringify(merged, null, 2))

  cachedSettings = merged
  return { ...merged }
}

export async function getASRConfig(): Promise<Record<string, unknown>> {
  const settings = await loadSettings()
  return {
    provider: settings.asrProvider,
    apiKey: settings.asrApiKey,
    apiBase: settings.asrApiBase,
    model: settings.asrModel,
  }
}
