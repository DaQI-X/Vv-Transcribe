/**
 * 转写主页面
 * 根据文件状态切换三种视图：上传区 → 处理状态 → 结果展示（播放器 + 编辑器）
 * 顶部导航包含品牌标识和设置下拉菜单（转写配置 / 纠错配置）
 */
import { useState, useRef, useCallback } from 'react'
import { Settings } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { FileUploader } from '@/components/transcription/FileUploader'
import { UploadStatus } from '@/components/transcription/UploadStatus'
import { TranscriptEditor } from '@/components/transcription/TranscriptEditor'
import { AudioPlayer } from '@/components/transcription/AudioPlayer'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { ToastContainer, toast } from '@/components/ui/Toast'
import { Dropdown } from '@/components/ui/Dropdown'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { usePlayerStore } from '@/stores/usePlayerStore'
import { useReferenceStore } from '@/stores/useReferenceStore'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import logoIcon from '@/assets/mac/logo_1024.png'

const SETTINGS_MENU = [
  { key: 'asr', label: '转写配置' },
  { key: 'ai', label: '纠错配置' },
  { key: 'theme', label: '主题' },
  { key: 'about', label: '关于与更新' },
]

export function Transcription() {
  const navigate = useNavigate()
  const [settingsTab, setSettingsTab] = useState<string | null>(null)
  const { fileName, status, reset } = useTranscriptionStore()

  const clickCountRef = useRef(0)
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const headerRef = useRef<HTMLElement>(null)

  const handleVersionClick = async () => {
    clickCountRef.current += 1

    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
    }

    clickTimerRef.current = setTimeout(() => {
      clickCountRef.current = 0
    }, 2000)

    if (clickCountRef.current >= 8) {
      clickCountRef.current = 0
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current)
      }

      const api = getElectronAPI()
      if (api) {
        const result = await api.openLogDirectory()
        if (result.success) {
          toast.success('已打开日志目录')
        } else {
          toast.error(`打开日志目录失败: ${result.error}`)
        }
      }
    }
  }

  const handleHeaderDoubleClick = useCallback(() => {
    const api = getElectronAPI()
    if (api?.toggleWindowMaximize) {
      api.toggleWindowMaximize()
    }
  }, [])

  const handleGoHome = useCallback(() => {
    reset()
    usePlayerStore.getState().reset()
    useReferenceStore.getState().clearReference()
    navigate('/')
  }, [navigate, reset])

  const hasFile = !!fileName
  const isCompleted = status === 'completed'
  const showStatusView = hasFile && !isCompleted
  const showTranscriptionView = hasFile && isCompleted

  return (
    <div>
      <header
        ref={headerRef}
        className="harder_top"
        onDoubleClick={handleHeaderDoubleClick}
      >
        <div className="header_brand">
          <img src={logoIcon} alt="Vv Transcribe" className="header_logo_icon" />
          <span className="header_app_name">Vv Transcribe</span>
        </div>
        <div className="header_actions">
          <div className="header_settings">
            <Dropdown items={SETTINGS_MENU.map((item) => ({ key: item.key, label: item.label, onClick: () => setSettingsTab(item.key) }))}>
              <button>
                <Settings size={16} />
              </button>
            </Dropdown>
          </div>
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
              <TranscriptEditor onGoHome={handleGoHome} />
            </div>
          </div>
        ) : null}
      </main>

      <div className="version_footer">
        <span
          className="version_footer_text"
          onClick={handleVersionClick}
          style={{ cursor: 'pointer', userSelect: 'none' }}
        >
          Vv Transcribe v1.0.0
        </span>
      </div>

      <SettingsModal tab={settingsTab} onClose={() => setSettingsTab(null)} />
      <ToastContainer />
    </div>
  )
}
