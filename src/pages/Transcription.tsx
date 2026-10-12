/**
 * 转写主页面
 * 根据文件状态切换三种视图：上传区 → 处理状态 → 结果展示（播放器 + 编辑器）
 * 顶部导航包含 Logo（点击重置）和设置下拉菜单（转写配置 / 纠错配置）
 */
import { useState } from 'react'
import { SettingOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { Typography, Dropdown } from 'antd'
import { FileUploader } from '@/components/transcription/FileUploader'
import { UploadStatus } from '@/components/transcription/UploadStatus'
import { TranscriptEditor } from '@/components/transcription/TranscriptEditor'
import { AudioPlayer } from '@/components/transcription/AudioPlayer'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { usePlayerStore } from '@/stores/usePlayerStore'
import { useReferenceStore } from '@/stores/useReferenceStore'
import logoImg from '@/assets/public/header_logo.png'

const { Text } = Typography

const SETTINGS_MENU = [
  { key: 'asr', label: '转写配置' },
  { key: 'ai', label: '纠错配置' },
]

export function Transcription() {
  const navigate = useNavigate()
  const [settingsTab, setSettingsTab] = useState<string | null>(null)
  const { fileName, status, reset } = useTranscriptionStore()

  const hasFile = !!fileName
  const isCompleted = status === 'completed'
  const showStatusView = hasFile && !isCompleted
  const showTranscriptionView = hasFile && isCompleted

  return (
    <div>
      <header className="harder_top">
        <div onClick={() => { reset(); usePlayerStore.getState().reset(); useReferenceStore.getState().clearReference(); navigate('/') }} style={{ cursor: hasFile ? 'pointer' : 'default' }}>
          <img src={logoImg} alt="Vv Transcribe" className="header_logo" />
        </div>
        <div className="header_settings">
          <Dropdown menu={{ items: SETTINGS_MENU.map((item) => ({ key: item.key, label: item.label, onClick: () => setSettingsTab(item.key) })) }}>
            <button>
              <SettingOutlined />
            </button>
          </Dropdown>
        </div>
      </header>

      <main style={{ flex: 1, overflow: 'hidden' }}>
        {!hasFile ? (
          <FileUploader />
        ) : showStatusView ? (
          <UploadStatus />
        ) : showTranscriptionView ? (
          <div className="result-layout">
            <div className="result-layout__player">
              <AudioPlayer />
            </div>
            <div className="result-layout__editor">
              <TranscriptEditor />
            </div>
          </div>
        ) : null}
      </main>

      <div className="version_footer">
        <Text className="version_footer_text">
          Vv Transcribe v1.0.0
        </Text>
      </div>

      <SettingsModal tab={settingsTab} onClose={() => setSettingsTab(null)} />
    </div>
  )
}
