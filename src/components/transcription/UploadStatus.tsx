/**
 * 上传/处理状态展示组件
 * 根据转写状态切换三种视图：
 * - UploadingView: 文件读取中（提取音频阶段）
 * - ProcessingView: ASR 转写中（带波形动画和进度条）
 * - FailureView: 处理失败（显示错误信息和重试按钮）
 */
import { CloseOutlined, SoundOutlined, LoadingOutlined } from '@ant-design/icons'
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
          <LoadingOutlined className="uploading-spinner__icon" spin />
        </div>

        <div className="uploading-title">正在上传文件</div>
        <div className="uploading-desc">正在读取音频数据，准备转写环境...</div>

        <div className="uploading-file-info">
          <SoundOutlined className="uploading-file-info__icon" />
          <span className="uploading-file-info__name">{fileName || '未命名文件'}</span>
          {sizeText && <span className="uploading-file-info__size">{sizeText}</span>}
        </div>
      </div>
    </div>
  )
}

function ProcessingView({ fileName, progress }: { fileName: string | null; progress: number }) {
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
          {Array.from({ length: 40 }, (_, i) => {
            const height = 20 + Math.sin(i * 0.5) * 15 + Math.random() * 10
            const isTeal = i % 3 === 0
            return (
              <div
                key={i}
                className="waveform-bar"
                style={{
                  height: `${height}px`,
                  backgroundColor: isTeal ? '#2EE6D6' : '#2F80ED',
                  animationDelay: `${i * 0.05}s`,
                }}
              />
            )
          })}
        </div>

        <div className="processing-text">
          <span className="processing-text__title">ASR 识别转写处理中</span>
          <span className="processing-text__desc">AI 正在分析音频内容，自动识别语音并生成文字</span>
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
            <CloseOutlined />
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
  const { fileName, fileSize, status, progress, error, reset } = useTranscriptionStore()

  const isProcessing = status === 'transcribing'
  const isFailed = status === 'error' || !!error

  const handleRetry = () => {
    reset()
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
    return <ProcessingView fileName={fileName} progress={progress} />
  }

  return <UploadingView fileName={fileName} fileSize={fileSize} />
}
