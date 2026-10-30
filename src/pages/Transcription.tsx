/**
 * 转写主页面
 * 顶部 tab 决定看哪一块：字幕配音是一整个页面（工作台），其余按文件状态切换三种视图：
 * 上传区 → 处理状态 → 结果展示（播放器 + 编辑器）
 * 顶部导航包含品牌标识和设置下拉菜单（转写配置 / 校对配置 / 配音配置）
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import { Settings } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { FileUploader } from '@/components/transcription/FileUploader'
import { UploadStatus } from '@/components/transcription/UploadStatus'
import { TranscriptEditor } from '@/components/transcription/TranscriptEditor'
import { AudioPlayer } from '@/components/transcription/AudioPlayer'
import { VoiceStudio } from '@/components/transcription/VoiceStudio'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { ToastContainer, toast } from '@/components/ui/Toast'
import { Dropdown } from '@/components/ui/Dropdown'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { usePlayerStore } from '@/stores/usePlayerStore'
import { useReferenceStore } from '@/stores/useReferenceStore'
import { useSettingsModalStore } from '@/stores/useSettingsModalStore'
import { useVoiceStudioStore } from '@/stores/useVoiceStudioStore'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { openUserDataDirectory } from '@/utils/userData'
import logoIcon from '@/assets/mac/logo_1024.png'

const SETTINGS_MENU = [
  { key: 'asr', label: '转写配置' },
  { key: 'ai', label: '校对配置' },
  { key: 'tts', label: '配音配置' },
  { key: 'theme', label: '主题' },
  { key: 'about', label: '关于与更新' },
]

export function Transcription() {
  const navigate = useNavigate()
  // 设置弹窗改成全局状态：开工前置校验等入口也要能把某个 tab 直接打开
  const settingsTab = useSettingsModalStore((s) => s.tab)
  const openSettings = useSettingsModalStore((s) => s.open)
  const closeSettings = useSettingsModalStore((s) => s.close)
  const [appVersion, setAppVersion] = useState('')
  const { fileName, status, reset } = useTranscriptionStore()
  // 顶部 tab 也存在 store 里：配音跑起来是分钟级的后台任务，状态跟着组件走会丢
  const tab = useVoiceStudioStore((s) => s.tab)

  useEffect(() => {
    const api = getElectronAPI()
    if (!api) return
    api.getAppVersion()
      .then(setAppVersion)
      .catch(() => {})
  }, [])

  /**
   * 设置没能从磁盘读出来时，启动就得当面说一次。不说，界面看到的是「几把 Key 全是 none」，
   * 用户以为是自己漏填——而真相是磁盘那份被留档了（或根本读不了），继续保存会把它盖掉。
   * 只在启动时报：保存失败走 settings:save 的 saveError，两条话不会出现同一句弹两遍。
   */
  useEffect(() => {
    const api = getElectronAPI()
    if (!api) return
    api
      .getSettings()
      .then((saved) => {
        const problem = saved?.storageProblem
        if (typeof problem !== 'string' || !problem) return
        toast.error(problem, 20000, {
          label: '打开数据目录',
          onClick: () => void openUserDataDirectory(),
        })
      })
      .catch(() => {})
  }, [])

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
    // 稿子要被清空了，从这份稿子长出来的配音产物也就没有归属，当场回收
    useVoiceStudioStore.getState().backToUpload()
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
            <Dropdown items={SETTINGS_MENU.map((item) => ({ key: item.key, label: item.label, onClick: () => openSettings(item.key) }))}>
              <button>
                <Settings size={16} />
              </button>
            </Dropdown>
          </div>
        </div>
      </header>

      <main style={{ flex: 1, overflow: 'hidden' }}>
        {tab === 'voice' ? (
          <VoiceStudio />
        ) : !hasFile ? (
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
          {appVersion ? `Vv Transcribe v${appVersion}` : 'Vv Transcribe'}
        </span>
      </div>

      <SettingsModal tab={settingsTab} onClose={closeSettings} />
      <ToastContainer />
    </div>
  )
}
