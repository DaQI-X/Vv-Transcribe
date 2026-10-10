/**
 * 文件上传组件
 * 支持点击选择和拖拽上传两种方式
 * 选择文件后自动触发转写流程：获取元数据 → 启动 ASR 转写 → 监听进度回调
 */
import { useState, useCallback, useEffect } from 'react'
import { UploadOutlined } from '@ant-design/icons'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { frontendLogger } from '@/utils/logger'

export function FileUploader() {
  const { setFile, setStatus, setProgress, setJobId, setAsrProvider, addSegment, setError, setUnsubscribeProgress } = useTranscriptionStore()
  const api = getElectronAPI()
  const [isDragging, setIsDragging] = useState(false)

  // 初始化前端日志 API
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

  return (
    <div className="upload_zone">
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

      <div className="feature_highlights">
        <span className="feature_highlights_text">
          支持音频、视频转写 · AI 智能纠错 · 多格式导出
        </span>
      </div>
    </div>
  )
}
