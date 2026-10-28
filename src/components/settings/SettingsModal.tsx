/**
 * 设置弹窗组件
 * 提供五个 Tab：
 * - 转写配置（asr）：转写模式（本地/云端）、API Base、API Key、模型
 * - 校对配置（ai）：AI 服务商、API Base、API Key、模型、本地词典版本与更新
 * - 配音配置（tts）：先选「云端接口 / 本地配音」这一档，再按档展开要填的字段——
 *   云端档是接口地址、API Key（两者留空＝沿用校对那套）、配音模型、配音音色；
 *   本地档只有本地模型与本地音色两个下拉，地址/Key/模型那一组不显示（这一档根本不看它们）
 * - 主题（theme）、关于与更新（about：版本、按需组件下载）
 * 设置通过 IPC 持久化到 userData/settings.json
 *
 * 保存只在点「保存设置」时发生，且保存后不关窗，方便紧接着点「测试连接」；
 * 有未保存修改时关闭会先二次确认，切 Tab 不再重新拉取磁盘值，避免静默丢掉刚填的内容。
 *
 * 三把 API Key 与其他字段不同：主进程只回状态不回值，所以输入框不回显、留空＝不修改、
 * 清除要走「清除已保存的 Key」按钮（点保存才生效）。
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  X,
  Eye,
  EyeOff,
  Sun,
  Moon,
  FolderOpen,
  Plug,
  RotateCcw,
  CircleCheck,
  CircleX,
  TriangleAlert,
  Trash2,
  Mail,
  Copy,
} from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { useThemeStore } from '@/stores/useThemeStore'
import { useSettingsModalStore } from '@/stores/useSettingsModalStore'
import { ASR_LANGUAGE_OPTIONS } from '@/utils/asrLanguage'
import {
  LOCAL_TTS_DEFAULT_ENGINE,
  LOCAL_TTS_ENGINE_OPTIONS,
  hasInAppDownload,
  localTtsEngineLabel,
  missingModelHint,
  voiceSidOptions,
} from '@/utils/localTtsEngines'
import { ComponentsSection } from '@/components/settings/ComponentsSection'
import type { KeyStatus } from '@/utils/readiness'

interface SettingsValues {
  asrProvider: string
  /** 只在输入框里编辑、从磁盘回填永远是空：主进程给的是状态不是值（见 keyStates） */
  asrApiKey: string
  asrApiBase: string
  asrModel: string
  asrLocalModel: string
  asrLanguage: string
  aiProvider: string
  aiApiKey: string
  aiApiBase: string
  aiModel: string
  /**
   * 配音（TTS）一整套。接口地址与 Key 留空＝沿用上面校对那套（主进程按同一口径回落），
   * 模型与音色不能和校对模型混用：音频接口吃的是配音模型 id。
   * ttsEngine 决定这一套字段里哪几样真的被用到：本地档不看地址、Key、模型，
   * 音色也换成 ttsLocalVoice 那个编号——所以界面上这两组是分着摆的，不摊成一排六个框。
   */
  ttsEngine: string
  ttsApiBase: string
  ttsApiKey: string
  ttsModel: string
  ttsVoice: string
  /** 本地档的引擎 id（白名单在主进程 localTtsEngine；空＝主进程按默认档处理） */
  ttsLocalEngine: string
  /** 本地档的音色编号，存成字符串（'0'…）；上限由引擎加载后报，界面上不写死 */
  ttsLocalVoice: string
}

/** 与主进程 connectionTestService 的 TestOutcome 对应 */
interface TestOutcome {
  level: 'pass' | 'warn' | 'fail'
  title: string
  message: string
}

const DEFAULT_VALUES: SettingsValues = {
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
  ttsEngine: 'cloud',
  ttsApiBase: '',
  ttsApiKey: '',
  ttsModel: '',
  ttsVoice: '',
  ttsLocalEngine: '',
  ttsLocalVoice: '',
}

/**
 * 本地引擎的 Whisper 档位。数字与错字样本都是本机实测（10 核 M 系、105.59 秒中文素材，每档预热 1 次后计时 3 次）：
 * base 权重 138MB、单次 9.1–16.5 秒（折合转一分钟约 5–9 秒）；small 461MB、26.6–30.3 秒（约 15–17 秒），
 * 按中位数 small 是 base 的 2.83 倍。文本上 base 把「英雄觉醒在即」听成「英雄绝性在急」
 * （20 秒切片那次是「英雄决性在急」），small 两处都听对——改意思的同音错字就是把档位交给用户的理由。
 */
const LOCAL_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'base', label: '快速（base 档）' },
  { value: 'small', label: '精准（small 档）' },
]

/** 只是给关于页显示和「复制」用；真正拼 mailto 的是主进程 app:contactDeveloper，改地址要同步改那边 */
const CONTACT_EMAIL = 'hi@vvscribe.com'

/**
 * 校对服务商用到的端点与默认模型；主进程会在 apiBase 拼 /v1/chat/completions。
 * 这里**不再带配音取值**：配音现在有自己的一整套配置（可以指到另一家网关），
 * 换校对服务商时顺手改写配音模型/音色属于跨 Tab 的隐式动作，用户不会预期，
 * 也很难解释「我只改了服务商，配音怎么又不能用了」。配音两项见下面的输入框与占位。
 */
const AI_PROVIDER_PRESETS: Record<string, { apiBase: string; model: string }> = {
  openai: { apiBase: 'https://api.openai.com', model: 'gpt-4o-mini' },
  deepseek: { apiBase: 'https://api.deepseek.com', model: 'deepseek-chat' },
  qwen: { apiBase: 'https://dashscope.aliyuncs.com/compatible-mode', model: 'qwen-plus' },
}

const TAB_TITLES: Record<string, string> = {
  asr: '转写配置',
  ai: '校对配置',
  tts: '配音配置',
  theme: '主题',
  about: '关于与更新',
}

interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  downloadUrl: string
}

/** 链接解析组件（yt-dlp）的本机状态；version 为 null 是「那个二进制跑不起来或读不出版本」，不是「没装」 */
interface YtDlpLocal {
  version: string | null
  source: 'updated' | 'bundled' | 'system' | 'path'
  bytes: number | null
}

interface YtDlpCheckResult {
  ok: boolean
  error: string | null
  local?: YtDlpLocal
  remote?: { version: string; bytes: number }
  hasUpdate?: boolean
}

const YTDLP_SOURCE_LABEL: Record<YtDlpLocal['source'], string> = {
  updated: '应用内更新过',
  bundled: '安装包内置',
  system: '本机安装的 yt-dlp',
  path: '系统 PATH 上的 yt-dlp',
}

/** 字节数只显示实测值，不四舍五入成「约 40MB」这种谁都对不上的说法；不到 1MB 的别说成 0.0MB */
function formatBytes(bytes: number): string {
  return bytes >= 1e6
    ? `${(bytes / 1e6).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1e3))}KB`
}

interface SettingsModalProps {
  tab: string | null
  onClose: () => void
}

function PasswordInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
}) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="settings-form-password-wrapper">
      <input
        className="settings-form-input"
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      <button
        type="button"
        className="settings-form-password-toggle"
        onClick={() => setVisible(!visible)}
        tabIndex={-1}
      >
        {visible ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  )
}

/** 主进程只给状态不给值，所以界面能说清的只有「有没有、能不能用、是不是明文」这三件事 */
const KEY_STATUS_HINT: Record<Exclude<KeyStatus, 'none'>, string> = {
  encrypted: '已加密保存在本机 · 留空表示不修改',
  plaintext: '已保存在本机，但这条是明文 · 留空表示不修改',
  unreadable: '这台机器读不出已保存的那把 Key（可能换过电脑，或系统密钥库被清过），重新填写并保存即可',
}

/** 认不准的状态一律按「没有」处理，别让界面上凭空多出一种可能值 */
function toKeyStatus(value: unknown): KeyStatus {
  return value === 'encrypted' || value === 'plaintext' || value === 'unreadable' ? value : 'none'
}

/**
 * API Key 输入框。三态：有字＝保存时替换、点「清除」＝保存时清空、两者都没＝不发送，磁盘上那把不动。
 * 清除只置标记，落到磁盘仍然要等「保存设置」——和其他字段一个口径。
 */
function ApiKeyField({
  value,
  status,
  encryptable,
  cleared,
  disabled,
  emptyHint,
  onChange,
  onClear,
}: {
  value: string
  status: KeyStatus
  encryptable: boolean
  cleared: boolean
  disabled?: boolean
  /** 还没保存过 Key 时的说法，两个 Tab 各自不同 */
  emptyHint: string
  onChange: (v: string) => void
  onClear: () => void
}) {
  const typed = value.trim() !== ''
  return (
    <>
      <PasswordInput
        value={value}
        onChange={onChange}
        placeholder={status === 'none' ? 'sk-...' : '已保存 · 留空不修改'}
        disabled={disabled}
      />
      <span className="settings-form-hint">
        {cleared
          ? '将在点「保存设置」后清除已保存的 Key'
          : typed
            ? '点「保存设置」后替换已保存的 Key'
            : status === 'none'
              ? emptyHint
              : KEY_STATUS_HINT[status]}
      </span>
      {status !== 'none' && !cleared && (
        <button
          type="button"
          onClick={onClear}
          disabled={disabled}
          className="settings-modal__dict-update-btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 6 }}
        >
          <Trash2 size={12} />
          清除已保存的 Key
        </button>
      )}
      {!encryptable && (
        <span className="settings-form-hint" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <TriangleAlert size={12} style={{ color: '#d97706' }} />
          这台机器用不了系统密钥库，这把 Key 只能以明文存在配置文件里
        </span>
      )}
    </>
  )
}

const RESULT_ICON = { pass: CircleCheck, warn: TriangleAlert, fail: CircleX } as const

function TestResultView({ result }: { result: TestOutcome }) {
  const Icon = RESULT_ICON[result.level]
  const boxRef = useRef<HTMLDivElement>(null)

  // 「配置自检」在弹窗最底部，结论卡片渲染时往往在滚动区之外，看不到等于白测
  useEffect(() => {
    boxRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [])

  return (
    <div ref={boxRef} className={`settings-test-result settings-test-result--${result.level}`}>
      <Icon size={14} className="settings-test-result__icon" />
      <div>
        <div className="settings-test-result__title">{result.title}</div>
        <div className="settings-test-result__message">{result.message}</div>
      </div>
    </div>
  )
}

function ThemeSettings({ theme, onChange }: { theme: string; onChange: (theme: string) => void }) {
  return (
    <>
      <div className="settings-form-group">
        <label className="settings-form-label">主题模式</label>
        <div className="theme-selector">
          <button
            className={`theme-option ${theme === 'light' ? 'theme-option--active' : ''}`}
            onClick={() => onChange('light')}
          >
            <Sun size={20} />
            <span>亮色</span>
          </button>
          <button
            className={`theme-option ${theme === 'dark' ? 'theme-option--active' : ''}`}
            onClick={() => onChange('dark')}
          >
            <Moon size={20} />
            <span>暗色</span>
          </button>
        </div>
        <span className="settings-form-hint">选择应用的主题</span>
      </div>
    </>
  )
}

export function SettingsModal({ tab, onClose }: SettingsModalProps) {
  const [values, setValues] = useState<SettingsValues>(DEFAULT_VALUES)
  /** 最近一次「磁盘上的值」快照，用来判断有没有未保存的修改 */
  const [snapshot, setSnapshot] = useState(() => JSON.stringify(DEFAULT_VALUES))
  const [hydrated, setHydrated] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dictVersion, setDictVersion] = useState('')
  const [dictUpdating, setDictUpdating] = useState(false)
  const [themeValue, setThemeValue] = useState<string>('light')
  const [appVersion, setAppVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [testingKind, setTestingKind] = useState<'asr' | 'ai' | 'tts' | null>(null)
  const [testResults, setTestResults] = useState<{
    asr?: TestOutcome
    ai?: TestOutcome
    tts?: TestOutcome
  }>({})
  /** 三把 Key 的磁盘状态（值从不过 IPC）+ 这台机器能不能加密 */
  const [keyStates, setKeyStates] = useState<{
    asr: KeyStatus
    ai: KeyStatus
    tts: KeyStatus
    encryptable: boolean
  }>({ asr: 'none', ai: 'none', tts: 'none', encryptable: true })
  const [pendingKeyClear, setPendingKeyClear] = useState<{
    asr: boolean
    ai: boolean
    tts: boolean
  }>({ asr: false, ai: false, tts: false })
  const [restarting, setRestarting] = useState(false)
  const [ytDlpLocal, setYtDlpLocal] = useState<YtDlpLocal | null>(null)
  const [ytDlpRemote, setYtDlpRemote] = useState<YtDlpCheckResult['remote'] | null>(null)
  const [ytDlpHasUpdate, setYtDlpHasUpdate] = useState(false)
  const [ytDlpChecking, setYtDlpChecking] = useState(false)
  const [ytDlpApplying, setYtDlpApplying] = useState(false)
  const [ytDlpProgress, setYtDlpProgress] = useState<{ received: number; total: number } | null>(
    null
  )
  const api = getElectronAPI()
  const { theme, setTheme } = useThemeStore()

  // 主题只在点保存后才落到 store，所以「改了没存」拿 store 当前值和表单值比；Key 的「待清除」也算未保存
  const isDirty =
    tab === 'theme'
      ? themeValue !== theme
      : JSON.stringify(values) !== snapshot ||
        pendingKeyClear.asr ||
        pendingKeyClear.ai ||
        pendingKeyClear.tts

  /**
   * 这次保存会不会重启本地引擎。档位变了必重启，而重启要等 PyInstaller 起进程 + /health 应答
   * （本机实测从点保存到出提示约 9 秒），按钮不说清这 9 秒在干什么，看着就像界面卡死。
   */
  const restartsEngine = (() => {
    try {
      return JSON.parse(snapshot).asrLocalModel !== values.asrLocalModel
    } catch {
      return false
    }
  })()

  /** 改过哪一组就作废那一组的测试结论：留着上一次填法测出来的绿色会误导 */
  const invalidateTest = (kind: 'asr' | 'ai' | 'tts') => {
    setTestResults((prev) => (prev[kind] === undefined ? prev : { ...prev, [kind]: undefined }))
  }

  /** 字段前缀决定它属于哪一组的自检；配音单独一组，别再算成校对 */
  const kindOfField = (field: string): 'asr' | 'ai' | 'tts' =>
    field.startsWith('asr') ? 'asr' : field.startsWith('tts') ? 'tts' : 'ai'

  const updateField = (field: keyof SettingsValues, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }))
    invalidateTest(kindOfField(field))
  }

  /** 在输入框里打字＝要替换，之前点的「清除」作废 */
  const updateKeyField = (
    kind: 'asr' | 'ai' | 'tts',
    field: 'asrApiKey' | 'aiApiKey' | 'ttsApiKey',
    value: string
  ) => {
    if (value) setPendingKeyClear((prev) => (prev[kind] ? { ...prev, [kind]: false } : prev))
    updateField(field, value)
  }

  const clearKeyField = (
    kind: 'asr' | 'ai' | 'tts',
    field: 'asrApiKey' | 'aiApiKey' | 'ttsApiKey'
  ) => {
    setPendingKeyClear((prev) => ({ ...prev, [kind]: true }))
    updateField(field, '')
  }

  /** 切换服务商时顺带填入端点与默认模型；自定义接口保留用户已填内容，两者都要点保存才生效 */
  const handleAiProviderChange = (provider: string) => {
    const preset = AI_PROVIDER_PRESETS[provider]
    setValues((prev) => ({
      ...prev,
      aiProvider: provider,
      ...(preset ? { aiApiBase: preset.apiBase, aiModel: preset.model } : {}),
    }))
    invalidateTest('ai')
  }

  const loadDictVersion = useCallback(async () => {
    if (!api) return
    try {
      const version = await api.getDictionaryVersion()
      setDictVersion(version)
    } catch {
      /* ignore */
    }
  }, [api])

  // 表单值只在窗口打开后拉一次磁盘值；切 Tab 再拉会把用户刚填没存的内容静默冲掉
  useEffect(() => {
    if (!tab) {
      setHydrated(false)
      setConfirmDiscard(false)
      setTestResults({})
      setPendingKeyClear({ asr: false, ai: false, tts: false })
      return
    }
    if (hydrated || !api) return
    ;(async () => {
      let loaded: SettingsValues = DEFAULT_VALUES
      try {
        const saved = await api.getSettings()
        if (saved && Object.keys(saved).length > 0) {
          // 密钥字段在返回值里只有状态，三个 Key 输入框永远从空开始（留空＝不修改）
          loaded = {
            ...DEFAULT_VALUES,
            ...saved,
            asrApiKey: '',
            aiApiKey: '',
            ttsApiKey: '',
          } as SettingsValues
          setKeyStates({
            asr: toKeyStatus(saved.asrKeyStatus),
            ai: toKeyStatus(saved.aiKeyStatus),
            tts: toKeyStatus(saved.ttsKeyStatus),
            encryptable: saved.keyEncryptionAvailable !== false,
          })
        }
      } catch {
        loaded = DEFAULT_VALUES
      }
      setValues(loaded)
      setSnapshot(JSON.stringify(loaded))
      setHydrated(true)
    })()
  }, [tab, api, hydrated])

  useEffect(() => {
    if (!tab || !api) return
    if (tab === 'ai') loadDictVersion()
    if (tab === 'theme') setThemeValue(useThemeStore.getState().theme)
    if (tab === 'about') {
      setUpdateInfo(null)
      setYtDlpRemote(null)
      setYtDlpHasUpdate(false)
      ;(async () => {
        try {
          setAppVersion(await api.getAppVersion())
        } catch {
          /* ignore */
        }
      })()
      // 这一栏要 spawn 一次组件进程（内置那份第一次跑要解包，本机实测一两秒），
      // 所以只在打开关于页时读一次，不进轮询、不在别的 Tab 触发
      setYtDlpLocal(null)
      ;(async () => {
        try {
          setYtDlpLocal(await api.getYtDlpLocal())
        } catch {
          /* ignore */
        }
      })()
    }
  }, [tab, api, loadDictVersion])

  /** 保存后保持窗口打开：用户下一步往往就是点「测试连接」，关窗等于逼他重开 */
  const handleSave = async () => {
    if (!api) return
    setSaving(true)
    try {
      const payload: Record<string, unknown> = { ...values }
      for (const kind of ['asr', 'ai', 'tts'] as const) {
        const field = kind === 'asr' ? 'asrApiKey' : kind === 'ai' ? 'aiApiKey' : 'ttsApiKey'
        const typed = values[field].trim()
        // 三态：有字＝替换、点了清除＝null、都没有＝整个键不发送，磁盘上那把保持原样
        if (typed) payload[field] = typed
        else if (pendingKeyClear[kind]) payload[field] = null
        else delete payload[field]
      }
      const result = await api.saveSettings(payload)
      // 提交过的 Key 从输入框里清掉：值已经进了配置，留在那儿会让人以为还没保存
      const nextValues: SettingsValues = {
        ...values,
        asrApiKey: '',
        aiApiKey: '',
        ttsApiKey: '',
      }
      setValues(nextValues)
      setSnapshot(JSON.stringify(nextValues))
      setPendingKeyClear({ asr: false, ai: false, tts: false })
      if (result?.settings)
        setKeyStates({
          asr: toKeyStatus(result.settings.asrKeyStatus),
          ai: toKeyStatus(result.settings.aiKeyStatus),
          tts: toKeyStatus(result.settings.ttsKeyStatus),
          encryptable: result.settings.keyEncryptionAvailable !== false,
        })
      if (tab === 'theme') setTheme(themeValue as 'light' | 'dark')
      // 换档位要重启引擎（离线标志只能在启动时定），没重启成功就等于新档位还没吃到，必须说
      if (result?.error) {
        toast.error(result.error, 9000)
      } else if (result?.tierRestart === 'done') {
        toast.success('设置已保存，本地引擎已按新档位重启')
      } else {
        toast.success('设置已保存')
      }
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const requestClose = () => {
    if (isDirty) {
      setConfirmDiscard(true)
      return
    }
    onClose()
  }

  // 连点守卫只能放 ref：state 在同一次渲染里读不到刚 set 的值，快速点三下会放行三次
  const testingRef = useRef(false)
  const restartingRef = useRef(false)

  /** 表单里选的配音引擎档位（还没点保存也算）——本地档和云端档要问的不是同一套字段 */
  const ttsLocal = values.ttsEngine === 'local'
  /** 界面当前问的那一档：用户在下拉里换了但没保存，也要按新档去查状态、给建议 */
  const selectedTtsEngine = values.ttsLocalEngine || LOCAL_TTS_DEFAULT_ENGINE
  /**
   * 本地档的状态快照（问一次不拉起引擎）：下拉里每一行都得标得出「这一档的模型还没下载」，
   * 所以两档一起问，而不是只问当前选中的那档。null＝还没读到，界面上不许把它当「都不缺」渲染。
   * speakers 只认当前选中那一档报的数——VITS 5 个、Kokoro 103 个，拿别的档的数列编号等于骗人。
   */
  const [localVoiceState, setLocalVoiceState] = useState<{
    speakers: number
    binaryPresent: boolean
    modelPresent: Record<string, boolean>
  } | null>(null)
  /** 测试连接跑完引擎就活了，speakers 当场报得出来；不留神这里会一直停在「只列得出 0 个」 */
  const [voiceStateTick, setVoiceStateTick] = useState(0)

  useEffect(() => {
    if (tab !== 'tts' || !api || !ttsLocal) return
    let cancelled = false
    const ids = LOCAL_TTS_ENGINE_OPTIONS.map((option) => option.value)
    void Promise.all(ids.map((id) => api.getLocalVoiceStatus(id).catch(() => null))).then(
      (statuses) => {
        if (cancelled) return
        const modelPresent: Record<string, boolean> = {}
        statuses.forEach((status) => {
          if (status) modelPresent[status.requestedEngine] = status.modelPresent
        })
        // 按主进程回的 requestedEngine 认领那一份：设置里存着白名单外的旧 id 时它会换回默认档，
        // 这边跟着换，否则下拉标的是默认档、提示讲的是用户选的那一档，两句话对不上。
        const current =
          statuses.find((status) => status?.requestedEngine === selectedTtsEngine) ??
          statuses.find((status) => status?.requestedEngine === LOCAL_TTS_DEFAULT_ENGINE) ??
          null
        if (!current) {
          setLocalVoiceState(null)
          return
        }
        setLocalVoiceState({
          speakers: current.speakers,
          binaryPresent: current.binaryPresent,
          modelPresent,
        })
      }
    )
    return () => {
      cancelled = true
    }
  }, [tab, api, ttsLocal, selectedTtsEngine, voiceStateTick])

  const handleTestConnection = async (kind: 'asr' | 'ai' | 'tts') => {
    if (!api || testingRef.current) return
    testingRef.current = true
    setTestingKind(kind)
    try {
      const payload =
        kind === 'asr'
          ? {
              provider: values.asrProvider,
              apiBase: values.asrApiBase,
              apiKey: values.asrApiKey,
              model: values.asrModel,
            }
          : kind === 'tts'
            ? {
                // 档位与本地引擎取表单当前值：主进程那边「测的就是你刚选的那个组合」，
                // 读已保存设置会测到另一档上去（表单没保存时尤其明显）
                engine: values.ttsEngine,
                localEngine: values.ttsLocalEngine,
                apiBase: values.ttsApiBase,
                apiKey: values.ttsApiKey,
                model: values.ttsModel,
                // 两档的「音色」不是一个东西：云端是服务商的音色名，本地是编号
                voice: ttsLocal ? values.ttsLocalVoice : values.ttsVoice,
              }
            : { apiBase: values.aiApiBase, apiKey: values.aiApiKey, model: values.aiModel }
      const result = await api.testConnection(kind, payload)
      setTestResults((prev) => ({ ...prev, [kind]: result }))
      if (kind === 'tts') setVoiceStateTick((prev) => prev + 1)
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [kind]: {
          level: 'fail',
          title: '测试没能跑完',
          message: '应用内部出错，请关闭设置窗口后重试',
        } as TestOutcome,
      }))
    } finally {
      testingRef.current = false
      setTestingKind(null)
    }
  }

  /**
   * 引擎起不来不必退出应用：首启下载模型失败、被外部杀掉这类情况，重启一次就能恢复。
   * 最长可能等 60 秒（首次要下载模型），所以按钮必须有「重启中」态，否则像坏了。
   */
  const handleRestartEngine = async () => {
    if (!api || restartingRef.current || testingRef.current) return
    restartingRef.current = true
    setRestarting(true)
    try {
      const result = await api.restartLocalEngine()
      if (result.ok) {
        toast.success('本地引擎已重启，可以直接开始转写')
        await handleTestConnection('asr')
      } else {
        toast.error(result.error || '本地引擎重启失败，请稍后再试', 8000)
      }
    } catch {
      toast.error('本地引擎重启失败。可在「关于与更新 → 打开日志文件夹」取日志后重新安装', 8000)
    } finally {
      restartingRef.current = false
      setRestarting(false)
    }
  }

  const handleCheckDictUpdate = async () => {
    if (!api || dictUpdating) return
    setDictUpdating(true)
    try {
      const result = await api.checkDictionaryUpdate()
      if (result.error) {
        toast.error(`检查词库更新失败：${result.error}`)
        return
      }
      if (!result.hasUpdate) {
        toast.info('词库已是最新版本')
        return
      }
      toast.loading('正在下载词库更新...')
      const download = await api.downloadDictionaryUpdate()
      if (download.success) {
        toast.success('词库更新成功')
        await loadDictVersion()
      } else {
        toast.error(`词库更新失败：${download.error || '未知错误'}`)
      }
    } catch {
      toast.error('检查词库更新失败')
    } finally {
      setDictUpdating(false)
    }
  }

  /**
   * 链接解析组件（yt-dlp）检查更新：清单里的版本比本机这版新才给「更新」按钮。
   * 网络不通时主进程回的是拼好的中文说明，直接 toast 出来，不要转成「未知错误」。
   */
  const handleCheckYtDlpUpdate = async () => {
    if (!api || ytDlpChecking || ytDlpApplying) return
    setYtDlpChecking(true)
    try {
      const result = await api.checkYtDlpUpdate()
      if (result.local) setYtDlpLocal(result.local)
      if (!result.ok) {
        toast.error(result.error || '检查链接解析组件更新失败', 8000)
        return
      }
      setYtDlpRemote(result.remote ?? null)
      setYtDlpHasUpdate(!!result.hasUpdate)
      if (result.hasUpdate) {
        toast.info(`链接解析组件可更新到 ${result.remote?.version}`, 6000)
      } else {
        // 清单可能比本机这版还旧，那句「已是最新」要带上当前的版本号，否则用户无从判断自己在用哪版
        toast.info(
          `链接解析组件无需更新（本机 ${result.local?.version ?? '版本未知'}，清单 ${result.remote?.version}）`,
          6000
        )
      }
    } catch {
      toast.error('检查链接解析组件更新失败：应用内部出错', 8000)
    } finally {
      setYtDlpChecking(false)
    }
  }

  /**
   * 下载约 37MB，慢网里要跑几分钟，所以必须订阅进度：
   * 只有按钮文字在变而不报字节，用户没法判断是真在动还是卡死了。
   */
  const handleApplyYtDlpUpdate = async () => {
    if (!api || ytDlpApplying || ytDlpChecking) return
    setYtDlpApplying(true)
    setYtDlpProgress(null)
    const unsubscribe = api.onYtDlpProgress?.((data) => setYtDlpProgress(data))
    try {
      const result = await api.applyYtDlpUpdate()
      if (result.success) {
        toast.success(`链接解析组件已更新到 ${result.version}，下次解析链接就用它`, 8000)
        // 换的是 userData/bin 里的那一份，本机生效版本随之改变，要重新探一次再显示
        setYtDlpHasUpdate(false)
        setYtDlpLocal(await api.getYtDlpLocal())
      } else if (result.systemSettingsHint) {
        // 与链接解析失败同一套处理：主进程判定「像是系统拦住执行」时才给一键直达隐私设置的入口
        toast.error(result.error || '链接解析组件更新失败', 10000, {
          label: '打开隐私设置',
          onClick: () => {
            void api.openSystemSettings()
          },
        })
      } else {
        toast.error(result.error || '链接解析组件更新失败', 10000)
      }
    } catch {
      toast.error('链接解析组件更新失败：应用内部出错', 8000)
    } finally {
      unsubscribe?.()
      setYtDlpProgress(null)
      setYtDlpApplying(false)
    }
  }

  const handleCheckUpdate = async () => {
    if (!api || checking) return
    setChecking(true)
    try {
      const info = await api.checkAppUpdate()
      setUpdateInfo(info)
      if (info.hasUpdate) {
        toast.info(`发现新版本 v${info.latestVersion}`)
      } else {
        toast.info(`当前已是最新版本（v${info.currentVersion}）`)
      }
    } catch {
      // 检查更新失败几乎都是「国内直连 GitHub 慢/被拦」，不该只甩一句「请检查网络」——
      // 用户手里没有第二个入口。给可复制的发布页直链，让他开加速或换官网下载。
      const releasePage = 'https://github.com/DaQI-X/Vv-Transcribe/releases/latest'
      toast.error(
        '连不上发布服务器（多为国内直连 GitHub 过慢所致）。可复制发布页地址，开网络加速后用浏览器下载，或访问官网 vvscribe.com',
        9000,
        {
          label: '复制发布页',
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(releasePage)
              toast.success('发布页地址已复制，可在浏览器粘贴打开')
            } catch {
              void handleOpenExternal(releasePage)
            }
          },
        }
      )
    } finally {
      setChecking(false)
    }
  }

  const handleOpenLogDirectory = async () => {
    if (!api) return
    try {
      const result = await api.openLogDirectory()
      if (!result.success) {
        toast.error(`打开日志文件夹失败：${result.error || '未知原因'}`)
      }
    } catch {
      toast.error('打开日志文件夹失败')
    }
  }

  const copyContactEmail = async (email: string) => {
    try {
      await navigator.clipboard.writeText(email)
      toast.success(`邮箱地址已复制：${email}`)
    } catch {
      toast.error(`复制失败，请手动记下：${email}`)
    }
  }

  const handleContactDeveloper = async () => {
    if (!api) return
    try {
      const result = await api.contactDeveloper()
      if (!result.success) {
        // 系统没配默认邮件客户端时 openExternal 会直接失败，此时复制地址是唯一出路
        toast.error(`打不开邮件客户端：${result.error || '系统可能没有默认的邮件应用'}`, 9000, {
          label: '复制邮箱地址',
          onClick: () => copyContactEmail(result.email || CONTACT_EMAIL),
        })
        return
      }
      // 成功只代表「已经把 mailto 交给系统」，macOS 上没装邮件应用时也不会报错，
      // 所以不把话说成「已打开写信窗口」；面板上的「复制邮箱地址」就是留好的退路。
      toast.info(
        '已把邮件交给系统默认邮件客户端。若没有任何反应，说明没配默认邮件应用，可点「复制邮箱地址」自行发送',
        9000
      )
    } catch {
      toast.error('唤起邮件客户端失败')
    }
  }

  const handleCopyContactEmail = () => copyContactEmail(CONTACT_EMAIL)

  const handleOpenExternal = async (url: string) => {
    if (!api) return
    const result = await api.openExternal(url)
    if (!result.success) {
      toast.error(`打开链接失败：${result.error}`)
    }
  }

  if (!tab) return null

  return (
    <div className="settings-overlay" onClick={requestClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal__header">
          <span className="settings-modal__title">{TAB_TITLES[tab]}</span>
          <button className="settings-modal__close" onClick={requestClose}>
            <X size={16} />
          </button>
        </div>

        <div className="settings-modal__body">
          {tab === 'asr' && (
            <>
              <div className="settings-form-group">
                <label className="settings-form-label">转写模式</label>
                <select
                  className="settings-form-select"
                  value={values.asrProvider}
                  onChange={(e) => updateField('asrProvider', e.target.value)}
                >
                  <option value="local">本地转写（默认）</option>
                  <option value="cloud">云端优先（需配置 API Key）</option>
                </select>
              </div>
              {values.asrProvider !== 'cloud' && (
                <div className="settings-form-group">
                  <label className="settings-form-label">本地模型档位</label>
                  <select
                    className="settings-form-select"
                    value={values.asrLocalModel}
                    onChange={(e) => updateField('asrLocalModel', e.target.value)}
                  >
                    {LOCAL_MODEL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <span className="settings-form-hint">
                    {values.asrLocalModel === 'small'
                      ? '精准档实测能把「英雄觉醒在即」听对，快速档这一段听成了「英雄绝性在急」——改意思的同音错字就是这么来的。代价：首次下载约 461MB，同一台机器耗时约为快速档的 2.8 倍，转一分钟音频约 15–17 秒。保存后引擎会自动重启一次'
                      : '快速档默认如此：权重约 138MB，实测转一分钟音频约 5–9 秒。代价是中文里会出现「英雄觉醒在即」被听成「英雄绝性在急」这类改意思的同音错字，字幕要求严就切到精准档。保存后引擎会自动重启一次'}
                  </span>
                </div>
              )}
              <div className="settings-form-group">
                <label className="settings-form-label">转写语言</label>
                <select
                  className="settings-form-select"
                  value={values.asrLanguage}
                  onChange={(e) => updateField('asrLanguage', e.target.value)}
                >
                  {ASR_LANGUAGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <span className="settings-form-hint">
                  本地和云端都按这个语言转写，保存后对下一次转写生效。选错会整段跑偏、甚至输出成另一种语言的翻译，比错字更难发现。
                  非中文内容暂不支持「本地校对」（误听表和词库都是中文的），需要在「校对配置」里填
                  API Key 走 AI 校对
                </span>
              </div>
              <div className="settings-form-group">
                <label className="settings-form-label">API Base URL</label>
                <input
                  className="settings-form-input"
                  value={values.asrApiBase}
                  onChange={(e) => updateField('asrApiBase', e.target.value)}
                  placeholder="https://api.openai.com"
                  disabled={values.asrProvider !== 'cloud'}
                />
                <span className="settings-form-hint">云端转写接口地址</span>
              </div>
              <div className="settings-form-group">
                <label className="settings-form-label">API Key</label>
                <ApiKeyField
                  value={values.asrApiKey}
                  status={keyStates.asr}
                  encryptable={keyStates.encryptable}
                  cleared={pendingKeyClear.asr}
                  disabled={values.asrProvider !== 'cloud'}
                  emptyHint="云端转写的 API 密钥，留空则使用本地转写"
                  onChange={(v) => updateKeyField('asr', 'asrApiKey', v)}
                  onClear={() => clearKeyField('asr', 'asrApiKey')}
                />
              </div>
              <div className="settings-form-group">
                <label className="settings-form-label">模型</label>
                <input
                  className="settings-form-input"
                  value={values.asrModel}
                  onChange={(e) => updateField('asrModel', e.target.value)}
                  placeholder="whisper-1"
                  disabled={values.asrProvider !== 'cloud'}
                />
              </div>
              <div className="settings-form-group">
                <label className="settings-form-label">配置自检</label>
                <button
                  type="button"
                  onClick={() => handleTestConnection('asr')}
                  disabled={testingKind !== null}
                  className="settings-modal__dict-update-btn"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <Plug size={12} />
                  {testingKind === 'asr'
                    ? '检查中...'
                    : values.asrProvider === 'cloud'
                      ? '测试连接'
                      : '检查引擎状态'}
                </button>
                {values.asrProvider !== 'cloud' && (
                  <button
                    type="button"
                    onClick={handleRestartEngine}
                    disabled={restarting || testingKind !== null}
                    className="settings-modal__dict-update-btn"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8 }}
                  >
                    <RotateCcw size={12} />
                    {restarting ? '重启中…' : '重启本地引擎'}
                  </button>
                )}
                <span className="settings-form-hint">
                  {values.asrProvider === 'cloud'
                    ? '按上面填写的值真实走一次转写接口：上传 1 秒静音音频，花费可忽略，不需要先保存；API Key 留空时用的是已保存的那把'
                    : '只检查本机转写引擎是否在线，不发起任何网络请求；引擎没起来时点「重启本地引擎」，不用退出应用（首次要下载模型，重启可能等上一两分钟）'}
                </span>
                {testResults.asr && <TestResultView result={testResults.asr} />}
              </div>
            </>
          )}

          {tab === 'ai' && (
            <>
              <div className="settings-form-group">
                <label className="settings-form-label">服务商</label>
                <select
                  className="settings-form-select"
                  value={values.aiProvider}
                  onChange={(e) => handleAiProviderChange(e.target.value)}
                >
                  <option value="openai">OpenAI</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="qwen">通义千问</option>
                  <option value="custom">自定义兼容接口</option>
                </select>
                <span className="settings-form-hint">
                  切换服务商会自动填入下方接口地址和模型，可自行修改，保存后生效
                </span>
              </div>
              <div className="settings-form-group">
                <label className="settings-form-label">API Base URL</label>
                <input
                  className="settings-form-input"
                  value={values.aiApiBase}
                  onChange={(e) => updateField('aiApiBase', e.target.value)}
                  placeholder="https://api.openai.com"
                />
                <span className="settings-form-hint">OpenAI / DeepSeek / 通义千问兼容地址</span>
              </div>
              <div className="settings-form-group">
                <label className="settings-form-label">API Key</label>
                <ApiKeyField
                  value={values.aiApiKey}
                  status={keyStates.ai}
                  encryptable={keyStates.encryptable}
                  cleared={pendingKeyClear.ai}
                  emptyHint="用于认证 AI 服务的密钥"
                  onChange={(v) => updateKeyField('ai', 'aiApiKey', v)}
                  onClear={() => clearKeyField('ai', 'aiApiKey')}
                />
              </div>
              <div className="settings-form-group">
                <label className="settings-form-label">模型</label>
                <input
                  className="settings-form-input"
                  value={values.aiModel}
                  onChange={(e) => updateField('aiModel', e.target.value)}
                  placeholder="gpt-4o-mini"
                />
              </div>
              <div className="settings-form-group">
                <label className="settings-form-label">配置自检</label>
                <button
                  type="button"
                  onClick={() => handleTestConnection('ai')}
                  disabled={testingKind !== null}
                  className="settings-modal__dict-update-btn"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <Plug size={12} />
                  {testingKind === 'ai' ? '检查中...' : '测试连接'}
                </button>
                <span className="settings-form-hint">
                  按上面填写的值发一条最短的校对请求（花费可忽略），确认这个模型能按我们的 JSON
                  格式返回，不需要先保存；API Key 留空时用的是已保存的那把
                </span>
                {testResults.ai && <TestResultView result={testResults.ai} />}
              </div>
              <div className="settings-form-group">
                <label className="settings-form-label">本地词典</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: '#9AA5B8' }}>
                    {dictVersion ? `v${dictVersion}` : '未加载'}
                  </span>
                  <button
                    type="button"
                    onClick={handleCheckDictUpdate}
                    disabled={dictUpdating}
                    className="settings-modal__dict-update-btn"
                  >
                    {dictUpdating ? '检查中...' : '检查更新'}
                  </button>
                </div>
              </div>
            </>
          )}

          {tab === 'tts' && (
            <>
              <div className="settings-form-group">
                <label className="settings-form-label">配音引擎</label>
                <select
                  className="settings-form-select"
                  value={ttsLocal ? 'local' : 'cloud'}
                  onChange={(e) => updateField('ttsEngine', e.target.value)}
                >
                  <option value="cloud">云端接口（花钱，效果由服务商决定）</option>
                  <option value="local">本地配音（在自己电脑上跑，不花钱，实验）</option>
                </select>
                <span className="settings-form-hint">
                  本地这一档是实验功能：引擎二进制和模型都不在安装包里，要先在「设置 → 关于与更新 → 按需组件」里下载。
                  切到这里不会立刻拉起引擎——第一次配音时才启动，那时第一次会多花几秒解包和读模型。
                </span>
              </div>

              {ttsLocal && (
                <>
                  <div className="settings-form-group">
                    <label className="settings-form-label">本地模型</label>
                    <select
                      className="settings-form-select"
                      value={values.ttsLocalEngine || LOCAL_TTS_DEFAULT_ENGINE}
                      onChange={(e) => {
                        updateField('ttsLocalEngine', e.target.value)
                        // 编号是「这一档模型里的第几个说话人」，换档后旧编号指的是另一个人，不能留
                        updateField('ttsLocalVoice', '0')
                      }}
                    >
                      {LOCAL_TTS_ENGINE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                          {localVoiceState?.modelPresent[option.value] === false
                            ? '（模型还没下载）'
                            : ''}
                        </option>
                      ))}
                    </select>
                    <span className="settings-form-hint">
                      {!localVoiceState
                        ? '还没读到本机的组件状态——这一档暂时不能配音。'
                        : !localVoiceState.binaryPresent
                          ? '这台机器上还没有引擎二进制，配音跑不起来——去「关于与更新 → 按需组件」下载。'
                          : localVoiceState.modelPresent[selectedTtsEngine] === false
                            ? `${missingModelHint(selectedTtsEngine)}。`
                            : `${localTtsEngineLabel(selectedTtsEngine)}的模型已在磁盘上。换档要点「保存设置」才生效；配音页那次换档只对本次调用有效，不会写回这里。`}
                      {localVoiceState &&
                        (!localVoiceState.binaryPresent ||
                          (localVoiceState.modelPresent[selectedTtsEngine] === false &&
                            hasInAppDownload(selectedTtsEngine))) && (
                          <button
                            type="button"
                            className="voice-studio__link"
                            onClick={() => useSettingsModalStore.getState().open('about')}
                          >
                            去按需组件
                          </button>
                        )}
                    </span>
                  </div>
                  <div className="settings-form-group">
                    <label className="settings-form-label">本地音色</label>
                    <select
                      className="settings-form-select"
                      value={/^\d+$/.test(values.ttsLocalVoice) ? values.ttsLocalVoice : '0'}
                      onChange={(e) => updateField('ttsLocalVoice', e.target.value)}
                    >
                      {voiceSidOptions(localVoiceState?.speakers ?? 0, values.ttsLocalVoice).map((sid) => (
                        <option key={sid} value={sid}>
                          音色 {sid}
                        </option>
                      ))}
                    </select>
                    <span className="settings-form-hint">
                      {(localVoiceState?.speakers ?? 0) > 0
                        ? `引擎报了这一档共 ${localVoiceState?.speakers} 个音色。上游没给音色名字，只能按编号挨个试听来认。`
                        : '音色总数要等引擎把模型读进内存才知道，所以现在只列得出默认那一个编号。点本页下面的「测试连接」，或去配音页「试听第一句」，引擎报完数这里就全了。'}
                    </span>
                  </div>
                </>
              )}

              {/* 本地档不看地址、Key、模型这三样：填了也不生效，摆在能切到的地方就是让人往不生效的框里填 Key */}
              {!ttsLocal && (
                <>
                  <div className="settings-form-group">
                    <label className="settings-form-label">API Base URL</label>
                    <input
                      className="settings-form-input"
                      value={values.ttsApiBase}
                      onChange={(e) => updateField('ttsApiBase', e.target.value)}
                      placeholder="留空＝沿用「校对配置」的地址"
                    />
                    <span className="settings-form-hint">
                      填了就用这条地址，请求会打在 {"{地址}"}/v1/audio/speech 上。配音和校对可以是两家不同的网关
                      ——校对那家不一定有音频接口，这里留空只是省事。
                    </span>
                  </div>
                  <div className="settings-form-group">
                    <label className="settings-form-label">API Key</label>
                    <ApiKeyField
                      value={values.ttsApiKey}
                      status={keyStates.tts}
                      encryptable={keyStates.encryptable}
                      cleared={pendingKeyClear.tts}
                      emptyHint={
                        keyStates.ai === 'none'
                          ? '还没填。配音需要一把 Key：在这里填，或者去「校对配置」填一把供两边共用'
                          : '留空＝沿用「校对配置」里已保存的那把 Key'
                      }
                      onChange={(v) => updateKeyField('tts', 'ttsApiKey', v)}
                      onClear={() => clearKeyField('tts', 'ttsApiKey')}
                    />
                  </div>
                  <div className="settings-form-group">
                    <label className="settings-form-label">配音模型</label>
                    <input
                      className="settings-form-input"
                      value={values.ttsModel}
                      onChange={(e) => updateField('ttsModel', e.target.value)}
                      placeholder="tts-1"
                    />
                    <span className="settings-form-hint">
                      音频接口的模型 id，和上面的校对模型是两回事——把校对模型填在这里会得到一句
                      「模型不存在」。留空时配音不会启动。
                    </span>
                  </div>
                  <div className="settings-form-group">
                    <label className="settings-form-label">配音音色</label>
                    <input
                      className="settings-form-input"
                      value={values.ttsVoice}
                      onChange={(e) => updateField('ttsVoice', e.target.value)}
                      placeholder="alloy"
                    />
                    <span className="settings-form-hint">
                      OpenAI 兼容接口的音色有 alloy、echo、fable、onyx、nova、shimmer
                      六种，中文听感上 onyx 偏沉、nova 偏亮，可以先各试一句再定。换网关时以对方给的音色名为准。
                    </span>
                  </div>
                </>
              )}
              <div className="settings-form-group">
                <label className="settings-form-label">配置自检</label>
                <button
                  type="button"
                  onClick={() => handleTestConnection('tts')}
                  disabled={testingKind !== null}
                  className="settings-modal__dict-update-btn"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <Plug size={12} />
                  {testingKind === 'tts' ? '检查中...' : '测试连接'}
                </button>
                <span className="settings-form-hint">
                  {ttsLocal
                    ? '按上面选的这一档在本机合成一句话（约 10 个字），不需要先保存。这一档不调接口、不花钱；' +
                      '引擎还没下载或模型还没下载时会直接告诉你缺哪一样，不用等配音跑失败。'
                    : '按上面填写的值合成一句话（约 10 个字），确认这把 Key、这个模型、这个音色能出音频，不需要先保存；' +
                      '地址和 Key 留空时用的是已保存的那套。本次只合成一句，按字符计费的接口上这是最小的一笔。'}
                </span>
                {testResults.tts && <TestResultView result={testResults.tts} />}
              </div>
            </>
          )}

          {tab === 'theme' && <ThemeSettings theme={themeValue} onChange={setThemeValue} />}

          {tab === 'about' && (
            <>
              <div className="settings-form-group">
                <label className="settings-form-label">当前版本</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: '#9AA5B8' }}>
                    {appVersion ? `v${appVersion}` : '读取中...'}
                  </span>
                  <button
                    type="button"
                    onClick={handleCheckUpdate}
                    disabled={checking}
                    className="settings-modal__dict-update-btn"
                  >
                    {checking ? '检查中...' : '检查更新'}
                  </button>
                </div>
                <span className="settings-form-hint">查询 GitHub Release 是否有新版本</span>
              </div>

              {updateInfo?.hasUpdate && (
                <div className="settings-update-notice">
                  <div className="settings-update-notice__title">
                    发现新版本 v{updateInfo.latestVersion}
                  </div>
                  <p className="settings-update-notice__text">
                    当前版本为 v{updateInfo.currentVersion}
                    。本应用不自动安装更新，请前往发布页获取最新安装包并覆盖安装。
                  </p>
                  <div className="settings-update-notice__actions">
                    <button
                      type="button"
                      className="settings-modal__save-btn"
                      onClick={() => handleOpenExternal(updateInfo.downloadUrl)}
                    >
                      前往发布页下载
                    </button>
                  </div>
                </div>
              )}

              <div className="settings-form-group">
                <label className="settings-form-label">链接解析组件</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: '#9AA5B8' }}>
                    {ytDlpLocal === null
                      ? '读取中...'
                      : `${ytDlpLocal.version ?? '版本未知'}（${YTDLP_SOURCE_LABEL[ytDlpLocal.source]}${
                          ytDlpLocal.bytes !== null ? `，${formatBytes(ytDlpLocal.bytes)}` : ''
                        }）`}
                  </span>
                  <button
                    type="button"
                    onClick={handleCheckYtDlpUpdate}
                    disabled={ytDlpChecking || ytDlpApplying}
                    className="settings-modal__dict-update-btn"
                  >
                    {ytDlpChecking ? '检查中...' : '检查更新'}
                  </button>
                  {ytDlpHasUpdate && ytDlpRemote && (
                    <button
                      type="button"
                      onClick={handleApplyYtDlpUpdate}
                      disabled={ytDlpApplying || ytDlpChecking}
                      className="settings-modal__save-btn"
                    >
                      {ytDlpApplying
                        ? ytDlpProgress
                          ? `下载中 ${formatBytes(ytDlpProgress.received)}/${formatBytes(ytDlpProgress.total)}`
                          : '准备中...'
                        : `更新到 ${ytDlpRemote.version}（${formatBytes(ytDlpRemote.bytes)}）`}
                    </button>
                  )}
                </div>
                <span className="settings-form-hint">
                  链接转写用的解析规则由它提供，站点改了规则就要换一版组件。更新只替换应用自己那份副本，
                  不动安装包里的内置版本，失败会自动退回原来的
                </span>
              </div>

              <ComponentsSection />

              <div className="settings-form-group">
                <label className="settings-form-label">运行日志</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    onClick={handleOpenLogDirectory}
                    className="settings-modal__dict-update-btn"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <FolderOpen size={12} />
                    打开日志文件夹
                  </button>
                </div>
                <span className="settings-form-hint">
                  转写或校对失败时，把这里的日志文件随邮件发给开发者便于排查
                </span>
              </div>

              <div className="settings-form-group">
                <label className="settings-form-label">问题反馈</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={handleContactDeveloper}
                    className="settings-modal__dict-update-btn"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <Mail size={12} />
                    发邮件反馈
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyContactEmail}
                    className="settings-modal__dict-update-btn"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <Copy size={12} />
                    复制邮箱地址
                  </button>
                  <span style={{ fontSize: 11, color: '#9AA5B8' }}>{CONTACT_EMAIL}</span>
                </div>
                <span className="settings-form-hint">
                  邮件会自动带上版本号与运行日志位置；附上日志比描述「转写不准」更容易定位问题
                </span>
              </div>
            </>
          )}
        </div>

        <div className="settings-modal__footer">
          {confirmDiscard ? (
            <>
              <span className="settings-modal__dirty-tip">有未保存的修改</span>
              <button
                onClick={() => setConfirmDiscard(false)}
                className="settings-modal__cancel-btn"
              >
                继续编辑
              </button>
              <button onClick={onClose} className="settings-modal__save-btn">
                放弃修改
              </button>
            </>
          ) : (
            <>
              <button onClick={requestClose} className="settings-modal__cancel-btn">
                {tab === 'about' ? '关闭' : '取消'}
              </button>
              {tab !== 'about' && (
                <button onClick={handleSave} disabled={saving} className="settings-modal__save-btn">
                  {saving ? (restartsEngine ? '保存中（重启本地引擎…）' : '保存中...') : '保存设置'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
