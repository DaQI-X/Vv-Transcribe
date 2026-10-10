/**
 * 设置弹窗组件
 * 提供两个配置 Tab：
 * - 转写配置（asr）：转写模式（本地/云端）、API Base、API Key、模型
 * - 纠错配置（ai）：AI 服务商、API Base、API Key、模型、本地词典版本与更新
 * 设置通过 IPC 持久化到 userData/settings.json
 */
import { Modal, Form, Input, Select, message } from 'antd'
import { useState, useEffect, useCallback } from 'react'
import { getElectronAPI } from '@/hooks/useElectronAPI'

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
}

interface SettingsModalProps {
  tab: string | null
  onClose: () => void
}

export function SettingsModal({ tab, onClose }: SettingsModalProps) {
  const [form] = Form.useForm<SettingsValues>()
  const [saving, setSaving] = useState(false)
  const [dictVersion, setDictVersion] = useState('')
  const [dictUpdating, setDictUpdating] = useState(false)
  const api = getElectronAPI()
  const asrProvider = Form.useWatch('asrProvider', form)
  const isCloudASR = asrProvider === 'cloud'

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
      if (!api) { form.setFieldsValue(DEFAULT_VALUES); return }
      try {
        const saved = await api.getSettings()
        form.setFieldsValue((saved && Object.keys(saved).length > 0 ? saved : DEFAULT_VALUES) as SettingsValues)
      } catch {
        form.setFieldsValue(DEFAULT_VALUES)
      }
      if (tab === 'ai') loadDictVersion()
    })()
  }, [tab, form, api, loadDictVersion])

  const handleSave = async () => {
    if (!api) return
    setSaving(true)
    try {
      await api.saveSettings(form.getFieldsValue())
      message.success('设置已保存')
      onClose()
    } catch {
      message.error('保存失败')
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
        message.info('词库已是最新版本')
        return
      }
      message.loading({ content: '正在下载词库更新...', key: 'dict-update', duration: 0 })
      const download = await api.downloadDictionaryUpdate()
      if (download.success) {
        message.success({ content: '词库更新成功', key: 'dict-update' })
        await loadDictVersion()
      } else {
        message.error({ content: `词库更新失败：${download.error}`, key: 'dict-update' })
      }
    } catch {
      message.error('检查词库更新失败')
    } finally {
      setDictUpdating(false)
    }
  }

  return (
    <Modal
      open={!!tab}
      onCancel={onClose}
      title={null}
      footer={null}
      width={480}
      className="settings-modal"
      centered
    >
      <div className="settings-modal__header">
        <span className="settings-modal__title">{tab ? TAB_TITLES[tab] : ''}</span>
      </div>

      <div className="settings-modal__body">
        <Form form={form} layout="vertical" className="settings-modal__form">
          {tab === 'asr' && (
            <>
              <Form.Item label={<span style={{ fontSize: 12, color: '#5A6A85' }}>转写模式</span>} name="asrProvider">
                <Select options={[
                  { value: 'local', label: '本地转写（默认）' },
                  { value: 'cloud', label: '云端优先（需配置 API Key）' },
                ]} />
              </Form.Item>
              <Form.Item label={<span style={{ fontSize: 12, color: '#5A6A85' }}>API Base URL</span>} name="asrApiBase" extra={<span style={{ fontSize: 10, color: '#9AA5B8' }}>云端转写接口地址</span>}>
                <Input placeholder="https://api.openai.com" disabled={!isCloudASR} />
              </Form.Item>
              <Form.Item label={<span style={{ fontSize: 12, color: '#5A6A85' }}>API Key</span>} name="asrApiKey" extra={<span style={{ fontSize: 10, color: '#9AA5B8' }}>云端转写的 API 密钥，留空则使用本地转写</span>}>
                <Input.Password placeholder="sk-..." disabled={!isCloudASR} />
              </Form.Item>
              <Form.Item label={<span style={{ fontSize: 12, color: '#5A6A85' }}>模型</span>} name="asrModel">
                <Input placeholder="whisper-1" disabled={!isCloudASR} />
              </Form.Item>
            </>
          )}

          {tab === 'ai' && (
            <>
              <Form.Item label={<span style={{ fontSize: 12, color: '#5A6A85' }}>服务商</span>} name="aiProvider">
                <Select options={[
                  { value: 'openai', label: 'OpenAI' },
                  { value: 'deepseek', label: 'DeepSeek' },
                  { value: 'qwen', label: '通义千问' },
                  { value: 'custom', label: '自定义兼容接口' },
                ]} />
              </Form.Item>
              <Form.Item label={<span style={{ fontSize: 12, color: '#5A6A85' }}>API Base URL</span>} name="aiApiBase" extra={<span style={{ fontSize: 10, color: '#9AA5B8' }}>OpenAI / DeepSeek / 通义千问兼容地址</span>}>
                <Input placeholder="https://api.openai.com" />
              </Form.Item>
              <Form.Item label={<span style={{ fontSize: 12, color: '#5A6A85' }}>API Key</span>} name="aiApiKey" extra={<span style={{ fontSize: 10, color: '#9AA5B8' }}>用于认证 AI 服务的密钥</span>}>
                <Input.Password placeholder="sk-..." />
              </Form.Item>
              <Form.Item label={<span style={{ fontSize: 12, color: '#5A6A85' }}>模型</span>} name="aiModel">
                <Input placeholder="gpt-4o-mini" />
              </Form.Item>
              <Form.Item label={<span style={{ fontSize: 12, color: '#5A6A85' }}>本地词典</span>}>
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
              </Form.Item>
            </>
          )}
        </Form>
      </div>

      <div className="settings-modal__footer">
        <button onClick={onClose} className="settings-modal__cancel-btn">取消</button>
        <button onClick={handleSave} disabled={saving} className="settings-modal__save-btn">
          {saving ? '保存中...' : '保存设置'}
        </button>
      </div>
    </Modal>
  )
}
