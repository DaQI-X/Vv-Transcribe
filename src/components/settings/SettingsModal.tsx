/**
 * 设置弹窗组件
 * 提供两个配置 Tab：
 * - 转写配置（asr）：转写模式（本地/云端）、API Base、API Key、模型
 * - 纠错配置（ai）：AI 服务商、API Base、API Key、模型、本地词典版本与更新
 * 设置通过 IPC 持久化到 userData/settings.json
 *
 * 保存只在点「保存设置」时发生，且保存后不关窗，方便紧接着点「测试连接」；
 * 有未保存修改时关闭会先二次确认，切 Tab 不再重新拉取磁盘值，避免静默丢掉刚填的内容。
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { X, Eye, EyeOff, Sun, Moon, FolderOpen, Plug, CircleCheck, CircleX, TriangleAlert } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { useThemeStore } from '@/stores/useThemeStore'

interface SettingsValues {
  asrProvider: string; asrApiKey: string; asrApiBase: string; asrModel: string
  aiProvider: string; aiApiKey: string; aiApiBase: string; aiModel: string
}

/** 与主进程 connectionTestService 的 TestOutcome 对应 */
interface TestOutcome {
  level: 'pass' | 'warn' | 'fail'
  title: string
  message: string
}

const DEFAULT_VALUES: SettingsValues = {
  asrProvider: 'local', asrApiKey: '', asrApiBase: '', asrModel: '',
  aiProvider: 'openai', aiApiKey: '', aiApiBase: '', aiModel: '',
}

/** 纠错服务商用到的端点与默认模型；主进程会在 apiBase 拼 /v1/chat/completions */
const AI_PROVIDER_PRESETS: Record<string, { apiBase: string; model: string }> = {
  openai: { apiBase: 'https://api.openai.com', model: 'gpt-4o-mini' },
  deepseek: { apiBase: 'https://api.deepseek.com', model: 'deepseek-chat' },
  qwen: { apiBase: 'https://dashscope.aliyuncs.com/compatible-mode', model: 'qwen-plus' },
}

const TAB_TITLES: Record<string, string> = {
  asr: '转写配置',
  ai: '纠错配置',
  theme: '主题',
  about: '关于与更新',
}

interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  downloadUrl: string
}

interface SettingsModalProps {
  tab: string | null
  onClose: () => void
}

function PasswordInput({ value, onChange, placeholder, disabled }: {
  value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean
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
  const [testingKind, setTestingKind] = useState<'asr' | 'ai' | null>(null)
  const [testResults, setTestResults] = useState<{ asr?: TestOutcome; ai?: TestOutcome }>({})
  const api = getElectronAPI()
  const { theme, setTheme } = useThemeStore()

  // 主题只在点保存后才落到 store，所以「改了没存」拿 store 当前值和表单值比
  const isDirty = tab === 'theme' ? themeValue !== theme : JSON.stringify(values) !== snapshot

  /** 改过哪一组就作废那一组的测试结论：留着上一次填法测出来的绿色会误导 */
  const invalidateTest = (kind: 'asr' | 'ai') => {
    setTestResults((prev) => (prev[kind] === undefined ? prev : { ...prev, [kind]: undefined }))
  }

  const updateField = (field: keyof SettingsValues, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }))
    invalidateTest(field.startsWith('asr') ? 'asr' : 'ai')
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
    } catch { /* ignore */ }
  }, [api])

  // 表单值只在窗口打开后拉一次磁盘值；切 Tab 再拉会把用户刚填没存的内容静默冲掉
  useEffect(() => {
    if (!tab) {
      setHydrated(false)
      setConfirmDiscard(false)
      setTestResults({})
      return
    }
    if (hydrated || !api) return
    ;(async () => {
      let loaded: SettingsValues = DEFAULT_VALUES
      try {
        const saved = await api.getSettings()
        if (saved && Object.keys(saved).length > 0) loaded = { ...DEFAULT_VALUES, ...saved } as SettingsValues
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
      ;(async () => {
        try {
          setAppVersion(await api.getAppVersion())
        } catch { /* ignore */ }
      })()
    }
  }, [tab, api, loadDictVersion])

  /** 保存后保持窗口打开：用户下一步往往就是点「测试连接」，关窗等于逼他重开 */
  const handleSave = async () => {
    if (!api) return
    setSaving(true)
    try {
      await api.saveSettings(values as unknown as Record<string, unknown>)
      setSnapshot(JSON.stringify(values))
      if (tab === 'theme') setTheme(themeValue as 'light' | 'dark')
      toast.success('设置已保存')
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

  const handleTestConnection = async (kind: 'asr' | 'ai') => {
    if (!api || testingKind) return
    setTestingKind(kind)
    try {
      const payload = kind === 'asr'
        ? { provider: values.asrProvider, apiBase: values.asrApiBase, apiKey: values.asrApiKey, model: values.asrModel }
        : { apiBase: values.aiApiBase, apiKey: values.aiApiKey, model: values.aiModel }
      const result = await api.testConnection(kind, payload)
      setTestResults((prev) => ({ ...prev, [kind]: result }))
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [kind]: { level: 'fail', title: '测试没能跑完', message: '应用内部出错，请关闭设置窗口后重试' } as TestOutcome,
      }))
    } finally {
      setTestingKind(null)
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
      toast.error('检查更新失败，请检查网络后重试')
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
                <PasswordInput
                  value={values.asrApiKey}
                  onChange={(v) => updateField('asrApiKey', v)}
                  placeholder="sk-..."
                  disabled={values.asrProvider !== 'cloud'}
                />
                <span className="settings-form-hint">云端转写的 API 密钥，留空则使用本地转写</span>
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
                  {testingKind === 'asr' ? '检查中...' : values.asrProvider === 'cloud' ? '测试连接' : '检查引擎状态'}
                </button>
                <span className="settings-form-hint">
                  {values.asrProvider === 'cloud'
                    ? '按上面填写的值真实走一次转写接口：上传 1 秒静音音频，花费可忽略，不需要先保存'
                    : '只检查本机转写引擎是否在线，不发起任何网络请求'}
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
                <span className="settings-form-hint">切换服务商会自动填入下方接口地址和模型，可自行修改，保存后生效</span>
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
                <PasswordInput
                  value={values.aiApiKey}
                  onChange={(v) => updateField('aiApiKey', v)}
                  placeholder="sk-..."
                />
                <span className="settings-form-hint">用于认证 AI 服务的密钥</span>
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
                  按上面填写的值发一条最短的纠错请求（花费可忽略），确认这个模型能按我们的 JSON 格式返回，不需要先保存
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

          {tab === 'theme' && (
            <ThemeSettings theme={themeValue} onChange={setThemeValue} />
          )}

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
                    当前版本为 v{updateInfo.currentVersion}。本应用不自动安装更新，请前往发布页获取最新安装包并覆盖安装。
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
                <span className="settings-form-hint">转写或纠错失败时，把这里的日志文件发给开发者便于排查</span>
              </div>
            </>
          )}
        </div>

        <div className="settings-modal__footer">
          {confirmDiscard ? (
            <>
              <span className="settings-modal__dirty-tip">有未保存的修改</span>
              <button onClick={() => setConfirmDiscard(false)} className="settings-modal__cancel-btn">
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
                  {saving ? '保存中...' : '保存设置'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
