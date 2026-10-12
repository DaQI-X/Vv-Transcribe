/**
 * 文件上传组件
 * 支持两种输入方式：本地文件上传（点击/拖拽）和 视频链接转写
 * Tab 切换两种模式，选择文件/输入链接后自动触发转写流程
 */
import { useState, useCallback, useEffect } from 'react'
import { UploadOutlined, LinkOutlined, CopyOutlined, LoadingOutlined } from '@ant-design/icons'
import { message } from 'antd'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { frontendLogger } from '@/utils/logger'

type UploadMode = 'file' | 'url'

export function FileUploader() {
  const { setFile, setStatus, setProgress, setJobId, setAsrProvider, addSegment, setError, setUnsubscribeProgress } = useTranscriptionStore()
  const api = getElectronAPI()
  const [isDragging, setIsDragging] = useState(false)
  const [mode, setMode] = useState<UploadMode>('file')
  const [urlInput, setUrlInput] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [downloadStatus, setDownloadStatus] = useState('')

  useEffect(() => {
    if (api) {
      frontendLogger.setAPI(api)
      frontendLogger.info('FileUploader', 'Component initialized')
    }
  }, [api])

  const startTranscriptionProcess = useCallback(async (filePath: string, fileName: string, fileSize: number) => {
    frontendLogger.userAction('Start transcription process', { fileName, fileSize })
    if (!api) {
      frontendLogger.error('FileUploader', 'API is null')
      return
    }

    setFile({ filePath, fileName, fileSize, duration: 0 })
    setStatus('extracting_audio')
    setProgress(0)

    try {
      const unsubscribe = api.onTranscriptionProgress((data) => {
        setProgress(data.progress)

        if (data.progress < 5) {
          setStatus('extracting_audio')
        } else if (data.progress < 100) {
          setStatus('transcribing')
        }

        if (data.segment) {
          addSegment({
            id: `${data.segment.startTime}-${data.segment.endTime}`,
            startTime: data.segment.startTime,
            endTime: data.segment.endTime,
            text: data.segment.text,
            originalText: data.segment.text,
            isEdited: false,
            isCorrected: false,
            confidence: data.segment.confidence,
          })
        }

        if (data.progress >= 100) {
          setStatus('completed')
          frontendLogger.userAction('Transcription completed', { fileName })
          unsubscribe()
          setUnsubscribeProgress(null)
        }
      })

      setUnsubscribeProgress(unsubscribe)

      frontendLogger.serviceCall('ASR', 'startTranscription', { filePath, language: 'zh' })
      const result = await api.startTranscription(filePath, { language: 'zh' })

      if (!result.success) {
        frontendLogger.error('FileUploader', 'Transcription failed', (result as any).error)
        setError((result as any).error || '转写启动失败')
        unsubscribe()
        setUnsubscribeProgress(null)
        return
      }

      setJobId(result.jobId)
      if (result.provider) {
        setAsrProvider(result.provider)
        frontendLogger.info('FileUploader', 'ASR provider set', { provider: result.provider })
      }
    } catch (err) {
      frontendLogger.error('FileUploader', 'Transcription error', err instanceof Error ? err.message : '转写失败')
      setError(err instanceof Error ? err.message : '转写失败')
    }
  }, [api, setFile, setStatus, setProgress, setJobId, setAsrProvider, addSegment, setError, setUnsubscribeProgress])

  const handleSelectFile = useCallback(async () => {
    frontendLogger.userAction('File selection dialog opened')
    if (!api) return
    const selectedPath = await api.selectFile()
    if (!selectedPath) {
      frontendLogger.userAction('File selection cancelled')
      return
    }
    frontendLogger.userAction('File selected', { path: selectedPath })
    const metadata = await api.getFileMetadata(selectedPath)
    if (!metadata) return

    await startTranscriptionProcess(metadata.path, metadata.name, metadata.size)
  }, [api, startTranscriptionProcess])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setIsDragging(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    if (!api) return

    const file: any = e.dataTransfer.files[0]
    if (!file) return

    const validExts = ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.wma', '.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv']
    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    if (!validExts.includes(ext)) {
      frontendLogger.warn('FileUploader', 'Invalid file format', { fileName: file.name, ext })
      return
    }

    frontendLogger.userAction('File dropped', { fileName: file.name })
    const filePath = api.getDroppedFilePath(file)
    if (!filePath) return

    const metadata = await api.getFileMetadata(filePath)
    if (!metadata) return

    await startTranscriptionProcess(metadata.path, metadata.name, metadata.size)
  }, [api, startTranscriptionProcess])

  const handlePasteUrl = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      setUrlInput(text)
    } catch {
      frontendLogger.warn('FileUploader', 'Failed to read clipboard')
    }
  }, [])

  const handleSubmitUrl = useCallback(async () => {
    const url = urlInput.trim()
    if (!url || !api) return
    frontendLogger.userAction('URL transcription submitted', { url })

    setDownloading(true)
    setDownloadStatus('正在解析链接...')

    try {
      const result = await api.downloadFromUrl(url)
      if (!result.success) {
        frontendLogger.error('FileUploader', 'Download failed', result.error)
        message.error(result.error || '链接解析失败，请重试')
        setDownloading(false)
        setDownloadStatus('')
        return
      }

      setDownloadStatus('正在获取文件信息...')
      const metadata = await api.getFileMetadata(result.filePath!)
      if (!metadata) {
        message.error('无法获取下载文件信息')
        setDownloading(false)
        setDownloadStatus('')
        return
      }

      setDownloadStatus('')
      setDownloading(false)
      frontendLogger.info('FileUploader', 'Download completed', { title: result.title, path: result.filePath })

      await startTranscriptionProcess(metadata.path, result.title || metadata.name, metadata.size)
    } catch (err) {
      frontendLogger.error('FileUploader', 'URL download error', err instanceof Error ? err.message : '下载失败')
      message.error('链接解析失败，请重试')
      setDownloading(false)
      setDownloadStatus('')
    }
  }, [urlInput, api, startTranscriptionProcess])

  return (
    <div className="upload_zone">
      <div className="upload-tabs">
        <button
          className={`upload-tab ${mode === 'file' ? 'active' : ''}`}
          onClick={() => setMode('file')}
        >
          <UploadOutlined />
          <span>本地文件</span>
        </button>
        <button
          className={`upload-tab ${mode === 'url' ? 'active' : ''}`}
          onClick={() => setMode('url')}
        >
          <LinkOutlined />
          <span>视频链接</span>
        </button>
      </div>

      {mode === 'file' ? (
        <div
          className={`upload-zone ${isDragging ? 'dragging' : ''}`}
          onClick={handleSelectFile}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <div className="upload-icon-circle">
            <UploadOutlined />
          </div>
          <div className="upload-title">
            {isDragging ? '释放以上传文件' : '点击或拖拽上传音视频文件'}
          </div>
          <div className="upload-subtitle">
            支持 MP4, MP3, WAV, M4A 等常见格式
          </div>
        </div>
      ) : (
        <div className="url-input-zone">
          <div className="upload-icon-circle">
            <LinkOutlined />
          </div>
          <div className="upload-title">粘贴视频/音频链接</div>
          <div className="url-input-row">
            <input
              className="url-input"
              type="text"
              placeholder="支持 YouTube, Bilibili, 抖音等公开视频链接"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !downloading && handleSubmitUrl()}
              disabled={downloading}
            />
            <button className="url-paste-btn" onClick={handlePasteUrl} title="粘贴" disabled={downloading}>
              <CopyOutlined />
            </button>
          </div>
          <button
            className="url-submit-btn"
            disabled={!urlInput.trim() || downloading}
            onClick={handleSubmitUrl}
          >
            {downloading ? <><LoadingOutlined spin /> {downloadStatus || '下载中...'}</> : '开始转写'}
          </button>
        </div>
      )}

      <div className="feature_highlights">
        <span className="feature_highlights_text">
          支持音频、视频转写 · AI 智能纠错 · 多格式导出
        </span>
      </div>
    </div>
  )
}
