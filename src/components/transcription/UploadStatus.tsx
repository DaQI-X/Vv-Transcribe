/**
 * 上传/处理状态展示组件
 * 根据转写状态切换三种视图：
 * - UploadingView: 文件读取中（提取音频阶段）
 * - ProcessingView: ASR 转写中（带波形动画、进度条和取消入口）
 * - FailureView: 处理失败（显示错误信息和重试按钮）
 */
import { useState } from 'react'
import { X, Volume2, Loader2, Ban } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function UploadingView({ fileName, fileSize }: { fileName: string | null; fileSize: number | null }) {
  const sizeText = fileSize ? formatFileSize(fileSize) : ''

  return (
    <div className="status-container">
      <div className="status-card status-card--uploading">
        <div className="uploading-spinner">
          <Loader2 className="uploading-spinner__icon animate-spin" size={32} />
        </div>

        <div className="uploading-title">正在上传文件</div>
        <div className="uploading-desc">正在读取音频数据，准备转写环境...</div>

        <div className="uploading-file-info">
          <Volume2 className="uploading-file-info__icon" size={14} />
          <span className="uploading-file-info__name">{fileName || '未命名文件'}</span>
          {sizeText && <span className="uploading-file-info__size">{sizeText}</span>}
        </div>
      </div>
    </div>
  )
}

function ProcessingView({ fileName, progress, stage, onCancel, cancelling }: {
  fileName: string | null
  progress: number
  stage: string | null
  onCancel: () => void
  cancelling: boolean
}) {
  const loadingModel = stage === 'loading_model'

  return (
    <div className="status-container">
      <div className="status-card status-card--processing">
        <div className="processing-header">
          <div className="processing-badge">
            <span className="processing-badge__dot" />
            <span className="processing-badge__text">AI 转写中</span>
          </div>
        </div>

        <div className="processing-waveform">
          <svg className="waveform-svg" viewBox="0 0 400 80" preserveAspectRatio="none">
            <defs>
              <linearGradient id="waveGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#1b55f5" />
                <stop offset="50%" stopColor="#3378ff" />
                <stop offset="100%" stopColor="#1b55f5" />
              </linearGradient>
            </defs>
            <path
              className="waveform-path waveform-path--back"
              d="M0,40 C50,20 100,60 150,40 C200,20 250,60 300,40 C350,20 400,60 400,40"
              fill="none"
              stroke="url(#waveGradient)"
              strokeWidth="2"
              opacity="0.3"
            />
            <path
              className="waveform-path waveform-path--front"
              d="M0,40 C50,60 100,20 150,40 C200,60 250,20 300,40 C350,60 400,20 400,40"
              fill="none"
              stroke="url(#waveGradient)"
              strokeWidth="3"
            />
          </svg>
        </div>

        <div className="processing-text">
          <span className="processing-text__title">
            {loadingModel ? '正在加载语音模型' : 'ASR 识别转写处理中'}
          </span>
          <span className="processing-text__desc">
            {loadingModel
              ? '首次使用需下载模型（约 150MB），完成后不再需要'
              : 'AI 正在分析音频内容，自动识别语音并生成文字'}
          </span>
        </div>

        <div className="processing-progress">
          <div className="processing-progress__bar">
            <div
              className="processing-progress__fill"
              style={{ width: `${Math.round(progress)}%` }}
            />
          </div>
          <span className="processing-progress__text">{Math.round(progress)}%</span>
        </div>

        <div className="processing-file-name">{fileName}</div>

        <button className="processing-cancel-btn" onClick={onCancel} disabled={cancelling}>
          <Ban size={14} />
          {cancelling ? '取消中...' : '取消转写'}
        </button>
      </div>
    </div>
  )
}

function FailureView({ title, message, fileName, onRetry, buttonLabel = '重新上传' }: {
  title: string
  message: string
  fileName: string | null
  onRetry: () => void
  buttonLabel?: string
}) {
  return (
    <div className="status-container">
      <div className="status-card">
        <div className="failure-content">
          <div className="failure-icon">
            <X size={28} />
          </div>

          <span className="failure-title">{title}</span>
          <span className="failure-message">{message}</span>

          {fileName && (
            <span className="failure-file-info">{fileName}</span>
          )}

          <button onClick={onRetry} className="failure-retry-btn">
            {buttonLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function UploadStatus() {
  const { fileName, fileSize, status, progress, stage, error, reset, jobId } = useTranscriptionStore()
  const [cancelling, setCancelling] = useState(false)

  const isProcessing = status === 'transcribing'
  const isFailed = status === 'error' || !!error

  const handleRetry = () => {
    reset()
  }

  const handleCancel = async () => {
    const api = getElectronAPI()
    if (!api || !jobId) {
      reset()
      return
    }
    setCancelling(true)
    try {
      await api.cancelTranscription(jobId)
    } catch (err) {
      setCancelling(false)
      toast.error(err instanceof Error ? err.message : '取消转写失败')
    }
    // 不在这里 reset：等 asr:start 以 canceled 结束，由 FileUploader 统一回到初始态
  }

  if (isFailed) {
    return (
      <FailureView
        title="音视频处理失败"
        message={error || '未知错误'}
        fileName={fileName}
        onRetry={handleRetry}
        buttonLabel="重新上传"
      />
    )
  }

  if (isProcessing) {
    return (
      <ProcessingView
        fileName={fileName}
        progress={progress}
        stage={stage}
        onCancel={handleCancel}
        cancelling={cancelling}
      />
    )
  }

  return <UploadingView fileName={fileName} fileSize={fileSize} />
}
