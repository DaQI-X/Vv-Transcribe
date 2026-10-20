/**
 * 设置弹窗组件
 * 提供两个配置 Tab：
 * - 转写配置（asr）：转写模式（本地/云端）、API Base、API Key、模型
 * - 纠错配置（ai）：AI 服务商、API Base、API Key、模型、本地词典版本与更新
 * 设置通过 IPC 持久化到 userData/settings.json
 */
import { useState, useEffect, useCallback } from 'react'
import { X, Eye, EyeOff, Sun, Moon } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { useThemeStore } from '@/stores/useThemeStore'

interface SettingsValues {
  asrProvider: string; asrApiKey: string; asrApiBase: string; asrModel: string
  aiProvider: string; aiApiKey: string; aiApiBase: string; aiModel: string
}

const DEFAULT_VALUES: SettingsValues = {
  asrProvider: 'local', asrApiKey: '', asrApiBase: '', asrModel: '',
  aiProvider: 'openai', aiApiKey: '', aiApiBase: '', aiModel: '',
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
  releaseUrl: string
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
  const [saving, setSaving] = useState(false)
  const [dictVersion, setDictVersion] = useState('')
  const [dictUpdating, setDictUpdating] = useState(false)
  const [themeValue, setThemeValue] = useState<string>('light')
  const [appVersion, setAppVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const api = getElectronAPI()
  const { setTheme } = useThemeStore()

  const updateField = (field: keyof SettingsValues, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }))
  }

  const loadDictVersion = useCallback(async () => {
    if (!api) return
    try {
      const version = await api.getDictionaryVersion()
      setDictVersion(version)
    } catch { /* ignore */ }
  }, [api])

  useEffect(() => {
    if (!tab) return
    ;(async () => {
      if (!api) { setValues(DEFAULT_VALUES); return }
      try {
        const saved = await api.getSettings()
        setValues((saved && Object.keys(saved).length > 0 ? { ...DEFAULT_VALUES, ...saved } : DEFAULT_VALUES) as SettingsValues)
      } catch {
        setValues(DEFAULT_VALUES)
      }
      if (tab === 'ai') loadDictVersion()
      if (tab === 'theme') {
        const currentTheme = useThemeStore.getState().theme
        setThemeValue(currentTheme)
      }
      if (tab === 'about') {
        setUpdateInfo(null)
        try {
          setAppVersion(await api.getAppVersion())
        } catch { /* ignore */ }
      }
    })()
  }, [tab, api, loadDictVersion])

  const handleSave = async () => {
    if (!api) return
    setSaving(true)
    try {
      await api.saveSettings(values as unknown as Record<string, unknown>)
      if (tab === 'theme') {
        setTheme(themeValue as 'light' | 'dark')
      }
      toast.success('设置已保存')
      onClose()
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleCheckDictUpdate = async () => {
    if (!api || dictUpdating) return
    setDictUpdating(true)
    try {
      const result = await api.checkDictionaryUpdate()
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
        toast.error(`词库更新失败：${download.error}`)
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

  const handleOpenExternal = async (url: string) => {
    if (!api) return
    const result = await api.openExternal(url)
    if (!result.success) {
      toast.error(`打开链接失败：${result.error}`)
    }
  }

  if (!tab) return null

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal__header">
          <span className="settings-modal__title">{TAB_TITLES[tab]}</span>
          <button className="settings-modal__close" onClick={onClose}>
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
            </>
          )}

          {tab === 'ai' && (
            <>
              <div className="settings-form-group">
                <label className="settings-form-label">服务商</label>
                <select
                  className="settings-form-select"
                  value={values.aiProvider}
                  onChange={(e) => updateField('aiProvider', e.target.value)}
                >
                  <option value="openai">OpenAI</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="qwen">通义千问</option>
                  <option value="custom">自定义兼容接口</option>
                </select>
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
                    当前版本为 v{updateInfo.currentVersion}。本应用不自动安装更新，请前往下载页获取最新安装包并覆盖安装。
                  </p>
                  <div className="settings-update-notice__actions">
                    <button
                      type="button"
                      className="settings-modal__save-btn"
                      onClick={() => handleOpenExternal(updateInfo.downloadUrl)}
                    >
                      前往下载页
                    </button>
                    <button
                      type="button"
                      className="settings-modal__cancel-btn"
                      onClick={() => handleOpenExternal(updateInfo.releaseUrl)}
                    >
                      查看发布说明
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="settings-modal__footer">
          <button onClick={onClose} className="settings-modal__cancel-btn">
            {tab === 'about' ? '关闭' : '取消'}
          </button>
          {tab !== 'about' && (
            <button onClick={handleSave} disabled={saving} className="settings-modal__save-btn">
              {saving ? '保存中...' : '保存设置'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
