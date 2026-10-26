/**
 * 设置持久化服务
 * 管理应用的 ASR 和 AI 配置项，以 JSON 文件形式持久化到 userData 目录
 * 支持内存缓存，避免重复读取磁盘
 *
 * API Key 单独说：磁盘上那份 settings.json 里的两把 Key 走系统的 safeStorage（macOS Keychain /
 * Windows DPAPI）加密后写入，值形如 `v1:<base64>`。没有前缀的按历史明文处理——首次读到且本机
 * 能加密就就地换掉。safeStorage 不可用时退回明文并让界面说清楚（见 getSettingsView 的
 * keyEncryptionAvailable）。明文不进渲染进程：给界面的一律是脱敏视图，只有主进程拿得到解密结果。
 */
import { app, safeStorage } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface AppSettings {
  asrProvider: string
  asrApiKey: string
  asrApiBase: string
  asrModel: string
  /**
   * 本地引擎的 Whisper 档位（base / small）。
   * 与 asrModel 分开存：asrModel 只喂云端转写接口，本地档位名会被 Python 侧直接拼成
   * HuggingFace repo 名，两者混用会让用户填的云端模型名变成下载目标。
   */
  asrLocalModel: string
  /** Whisper 语言码（zh/en/ja/…），同时决定校对走中文规则还是通用 prompt */
  asrLanguage: string
  aiProvider: string
  aiApiKey: string
  aiApiBase: string
  aiModel: string
  /**
   * 配音（TTS）用的模型与音色，与 aiModel 分开存：`/v1/audio/speech` 要的是配音模型 id
   * （OpenAI 形如 tts-1），拿 chat 模型去调必然 400；两者共用上面那套 apiBase 与 Key。
   * 只有配了音的服务商能用，界面不能承诺通用。
   */
  aiTtsModel: string
  aiTtsVoice: string
}

/** 两把密钥的字段名；脱敏视图与保存语义都按这两个键走 */
type SecretField = 'asrApiKey' | 'aiApiKey'
const SECRET_FIELDS: SecretField[] = ['asrApiKey', 'aiApiKey']

/**
 * 密文在 JSON 里的写法。加前缀是为了「能不能解密」和「是不是新版格式」能分开判断：
 * 没前缀＝历史明文或本机加密不可用时的退回，有前缀解不开＝换过机器（密钥跟机器/用户绑定）。
 */
const ENC_PREFIX = 'v1:'

/** 每把密钥在界面上的状态：不返回明文，但要把「有没有、能不能用、是不是明文」说清楚 */
export type SecretStatus = 'none' | 'encrypted' | 'plaintext' | 'unreadable'

/** 渲染层看到的设置：非密钥字段原样 + 每把密钥的状态 + 本机能不能加密 */
export type SettingsView = Omit<AppSettings, SecretField> & {
  asrKeyStatus: SecretStatus
  aiKeyStatus: SecretStatus
  keyEncryptionAvailable: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
  asrProvider: 'local',
  asrApiKey: '',
  asrApiBase: '',
  asrModel: '',
  asrLocalModel: 'base',
  asrLanguage: 'zh',
  aiProvider: 'openai',
  aiApiKey: '',
  aiApiBase: '',
  aiModel: '',
  aiTtsModel: '',
  aiTtsVoice: '',
}

/**
 * 一份缓存三样用途：raw 是磁盘上该原样写回的样子（密文不动它），
 * plain 是解密后的（只给主进程里的转写/校对用），status 是给界面的。
 * 每次解密都要过一遍系统密钥库，所以按进程缓存，不在每次取配置时重解。
 */
interface SettingsCache {
  raw: AppSettings
  plain: AppSettings
  status: Record<SecretField, SecretStatus>
  /** 磁盘上有没有需要就地加密的历史明文 */
  migrated: boolean
}

let cache: SettingsCache | null = null

/**
 * 本机密钥库可用性。isEncryptionAvailable() 在 Linux 没有密钥环时可能直接抛，
 * 不包一层就会把整份设置读失败。
 */
function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function seal(plain: string): string {
  if (!plain) return ''
  if (!encryptionAvailable()) return plain
  try {
    return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
  } catch {
    // 加密抛错时存明文，好过把用户填的 Key 丢掉；界面会按 keyEncryptionAvailable 说明仍是明文
    return plain
  }
}

function unseal(stored: string): { value: string; status: SecretStatus } {
  if (!stored) return { value: '', status: 'none' }
  if (!stored.startsWith(ENC_PREFIX)) return { value: stored, status: 'plaintext' }
  try {
    return {
      value: safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')),
      status: 'encrypted',
    }
  } catch {
    return { value: '', status: 'unreadable' }
  }
}

/** 密文解不开时不能把「解不开」当成「没配」，否则用户会去重填一个本来就对的 Key */
function buildCache(raw: AppSettings): SettingsCache {
  const plain = { ...raw }
  const status = {} as Record<SecretField, SecretStatus>
  let migrated = false
  for (const field of SECRET_FIELDS) {
    const { value, status: st } = unseal(raw[field])
    plain[field] = value
    status[field] = st
    if (st === 'plaintext') migrated = true
  }
  return { raw, plain, status, migrated }
}

/**
 * 档位只有界面给出的这两档，值同时也是 Python 侧白名单里的 key。
 * 必须收口：档位名会被 faster-whisper 直接拼成 HuggingFace repo 名去下载，
 * 也用来决定要不要给引擎下发 HF_HUB_OFFLINE，手改过的 settings.json 不能把这两个用途带偏。
 */
const LOCAL_MODEL_TIERS = ['base', 'small'] as const
export type LocalModelTier = (typeof LOCAL_MODEL_TIERS)[number]

export function normalizeLocalModel(raw: unknown): LocalModelTier {
  return LOCAL_MODEL_TIERS.includes(raw as LocalModelTier) ? (raw as LocalModelTier) : 'base'
}

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

async function writeRaw(raw: AppSettings): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(getSettingsPath(), JSON.stringify(raw, null, 2))
  cache = buildCache(raw)
}

/** 读到历史明文且本机现在能加密 → 立刻就地加密回写；写成功才认「已迁移」 */
async function migratePlainKeys(raw: AppSettings): Promise<void> {
  if (!encryptionAvailable()) return
  const sealed = { ...raw }
  for (const field of SECRET_FIELDS) {
    if (sealed[field] && !sealed[field].startsWith(ENC_PREFIX)) sealed[field] = seal(sealed[field])
  }
  await writeRaw(sealed)
}

async function readCache(): Promise<SettingsCache> {
  if (cache) return cache
  let raw: AppSettings
  try {
    const text = await readFile(getSettingsPath(), 'utf-8')
    const parsed = JSON.parse(text) as Partial<AppSettings>
    raw = { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    raw = { ...DEFAULT_SETTINGS }
  }
  cache = buildCache(raw)
  if (cache.migrated) {
    try {
      await migratePlainKeys(raw)
    } catch {
      // 迁移写盘失败不影响这次能不能用：保持明文继续干活，下次启动再试
    }
  }
  return cache
}

/** 主进程内部用的配置：密钥已解密。渲染层一律走 getSettingsView */
export async function loadSettings(): Promise<AppSettings> {
  const current = await readCache()
  return { ...current.plain }
}

/** 给界面的脱敏视图：两把 Key 只剩状态，值一个字符都不出主进程 */
export async function getSettingsView(): Promise<SettingsView> {
  const current = await readCache()
  const { asrApiKey: _asr, aiApiKey: _ai, ...rest } = current.raw
  return {
    ...rest,
    asrKeyStatus: current.status.asrApiKey,
    aiKeyStatus: current.status.aiApiKey,
    keyEncryptionAvailable: encryptionAvailable(),
  }
}

/**
 * 保存。密钥字段的语义和普通字段不同，界面上的输入框是「留空＝不改」：
 * - 缺席 / 空串：保留磁盘上已有的那把（改个接口地址不用重贴 Key）
 * - null：显式清除（界面「清除已保存的 Key」按钮）
 * - 非空字符串：替换，并按本机能不能加密决定存密文还是明文
 */
export async function saveSettings(
  patch: Partial<AppSettings> & Partial<Record<SecretField, string | null>>
): Promise<SettingsView> {
  const current = await readCache()
  const merged: AppSettings = { ...current.raw }
  const incoming = patch as Partial<AppSettings>
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
    if (SECRET_FIELDS.includes(key as SecretField)) continue
    // 只认这里列得出的配置项，且只收字符串：界面上多带的字段（脱敏视图的状态位）
    // 和任何手改出来的怪值都不该被写回磁盘
    const value = incoming[key]
    if (typeof value === 'string') merged[key] = value
  }
  for (const field of SECRET_FIELDS) {
    const incomingSecret = patch[field]
    if (incomingSecret === undefined || incomingSecret === '') continue
    if (incomingSecret === null) {
      merged[field] = ''
      continue
    }
    merged[field] = seal(incomingSecret.trim())
  }
  await writeRaw(merged)
  return getSettingsView()
}

/**
 * 接口地址归一化。
 * 各家文档常直接给 `https://api.openai.com/v1` 这种带后缀的形式，而请求统一拼成
 * `${apiBase}/v1/...`，所以这里容忍末尾斜杠和多余的 /v1。
 * 转写、校对、以及设置里的「测试连接」必须共用这一个实现，否则测试用归一化后的地址、
 * 干活用原始地址，就会出现「测试说可用、一转写就 404」这种最难查的分歧。
 */
export function normalizeApiBase(raw: string): string {
  return (raw || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

export async function getASRConfig(): Promise<Record<string, unknown>> {
  const settings = await loadSettings()
  return {
    provider: settings.asrProvider,
    apiKey: settings.asrApiKey,
    apiBase: normalizeApiBase(settings.asrApiBase),
    model: settings.asrModel,
    localModel: normalizeLocalModel(settings.asrLocalModel),
  }
}

/** AI 校对配置；留空时回落到 OpenAI 端点，否则拼出来的是非法相对地址，报错对用户毫无意义 */
export async function getAIConfig(): Promise<{ apiKey: string; apiBase: string; model: string }> {
  const settings = await loadSettings()
  return {
    apiKey: settings.aiApiKey,
    apiBase: normalizeApiBase(settings.aiApiBase) || 'https://api.openai.com',
    model: settings.aiModel || 'gpt-4o-mini',
  }
}

/**
 * 配音（TTS）配置。接口地址与 Key 与校对共用，模型和音色不共用：
 * `/v1/audio/speech` 收的是配音模型 id，拿 chat 模型去调必然 400，所以这里只读 aiTtsModel/aiTtsVoice。
 * 两个新字段留空时**不做回落**——填 tts-1 还是 CosyVoice 由服务商决定，静默替用户猜一个
 * 只会把「配置没填」变成一条看不出所以然的 404/400，宁可让调用方报「还没填」。
 */
export async function getTTSConfig(): Promise<{
  apiKey: string
  apiBase: string
  model: string
  voice: string
}> {
  const settings = await loadSettings()
  return {
    apiKey: settings.aiApiKey,
    apiBase: normalizeApiBase(settings.aiApiBase) || 'https://api.openai.com',
    model: settings.aiTtsModel,
    voice: settings.aiTtsVoice,
  }
}
