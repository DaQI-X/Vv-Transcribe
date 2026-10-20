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
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    cachedSettings = { ...DEFAULT_SETTINGS, ...parsed }
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

/**
 * AI 纠错配置。apiBase 留空时回落到 OpenAI 端点，
 * 否则请求会拼成 `/v1/chat/completions` 这种非法相对地址，报错信息对用户毫无意义。
 */
export async function getAIConfig(): Promise<{ apiKey: string; apiBase: string; model: string }> {
  const settings = await loadSettings()
  return {
    apiKey: settings.aiApiKey,
    apiBase: settings.aiApiBase || 'https://api.openai.com',
    model: settings.aiModel || 'gpt-4o-mini',
  }
}
