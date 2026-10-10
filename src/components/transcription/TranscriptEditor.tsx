/**
 * 转写结果编辑器组件
 * 展示转写段落列表，支持：
 * - 段落文本编辑（TextArea 行内编辑）
 * - AI 纠错（调用主进程 AI 服务，弹出 Diff 对比弹窗）
 * - 多格式导出（SRT / TXT / JSON / Markdown）
 * - 点击段落跳转到对应播放时间点
 */
import { useEffect, useRef, useState } from 'react'
import { Modal, message, Dropdown } from 'antd'
import { EditOutlined, DiffOutlined, ExportOutlined } from '@ant-design/icons'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { usePlayerStore } from '@/stores/usePlayerStore'
import { SegmentRow } from './SegmentRow'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { exportTranscript, getExportExtension } from '@/utils/exportTranscript'
import type { ExportFormat } from '@/types/transcription'

const FORMAT_OPTIONS: { key: ExportFormat; label: string }[] = [
  { key: 'srt', label: 'SRT 字幕文件' }, { key: 'txt', label: '纯文本 TXT' },
  { key: 'json', label: 'JSON 数据' }, { key: 'md', label: 'Markdown 文档' },
]

interface CorrectionResult { corrected: string; changes: string[] }

function DiffView({ original, corrected, changes }: { original: string; corrected: string; changes: string[] }) {
  return (
    <div className="diff-view">
      <div className="diff-view__original">
        <span className="diff-view__label">原文</span>
        <p style={{ margin: 0, fontSize: 14, color: '#102A43' }}>{original}</p>
      </div>
      <div className="diff-view__corrected">
        <span className="diff-view__label">修正后</span>
        <p style={{ margin: 0, fontSize: 14, color: '#102A43' }}>{corrected}</p>
      </div>
      {changes.length > 0 && (
        <div className="diff-view__changes">
          <span className="diff-view__changes-label">改动说明</span>
          <div className="diff-view__change-list">
            {changes.map((change, idx) => (
              <div key={idx} className="diff-view__change-item">
                <DiffOutlined />
                <span className="diff-view__change-text">{change}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function TranscriptEditor() {
  const { segments, setSegments, asrProvider, fileName } = useTranscriptionStore()
  const { activeSegmentId, seekToTime, setActiveSegment } = usePlayerStore()
  const activeRef = useRef<HTMLDivElement>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [currentResult, setCurrentResult] = useState<CorrectionResult | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (activeRef.current) activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [activeSegmentId])

  const totalChars = segments.reduce((sum, seg) => sum + seg.text.length, 0)

  const handleExport = (format: ExportFormat) => {
    if (segments.length === 0) return
    const content = exportTranscript(segments, format)
    const ext = getExportExtension(format)
    const baseName = fileName?.replace(/\.[^.]+$/, '') ?? 'transcript'
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${baseName}.${ext}`; a.click()
    URL.revokeObjectURL(url)
  }

  const handleAICorrection = async () => {
    const api = getElectronAPI()
    if (!api || segments.length === 0) return
    setLoading(true)
    try {
      const fullText = segments.map((s) => s.text).join('\n')
      const result = await api.correctText(fullText, { language: 'zh' })
      setCurrentResult(result); setModalOpen(true)
      if (result.corrected !== fullText) {
        const correctedLines = result.corrected.split('\n')
        setSegments(segments.map((seg, idx) => {
          const t = correctedLines[idx] ?? seg.text
          return t !== seg.text ? { ...seg, text: t, originalText: seg.text, isCorrected: true } : seg
        }))
        message.success(`纠错完成，共 ${result.changes.length} 处改动`)
      } else { message.info('未发现需要纠正的内容') }
    } catch (err) { message.error(err instanceof Error ? err.message : '纠错失败') }
    finally { setLoading(false) }
  }

  if (segments.length === 0) {
    return (
      <div className="transcript-editor__empty">
        <span className="transcript-editor__empty-text">暂无转写内容</span>
      </div>
    )
  }

  return (
    <>
      <div className="transcript-editor">
        <div className="transcript-editor__header">
          <div className="transcript-editor__title-group">
            <span className="transcript-editor__title">转写结果</span>
            <span className="transcript-editor__char-count">共 {totalChars.toLocaleString()} 字</span>
            {asrProvider && (
              <span className={`provider-badge provider-badge--${asrProvider}`}>
                {asrProvider === 'cloud' ? '云端转写' : '本地转写'}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleAICorrection}
              disabled={loading}
              className="transcript-editor__correct-btn"
            >
              <EditOutlined />{loading ? '纠错中...' : 'AI 纠错'}
            </button>
            <Dropdown menu={{ items: FORMAT_OPTIONS.map((opt) => ({ key: opt.key, label: opt.label, onClick: () => handleExport(opt.key) })) }}>
              <button className="transcript-editor__correct-btn">
                <ExportOutlined />导出
              </button>
            </Dropdown>
          </div>
        </div>

        <div className="transcript-editor__segments">
          <div>
            {segments.filter(Boolean).map((segment) => (
              <div key={segment.id} ref={segment.id === activeSegmentId ? activeRef : undefined}>
                <SegmentRow 
                  segment={segment} 
                  isActive={segment.id === activeSegmentId} 
                  onClick={() => {
                    setActiveSegment(segment.id)
                    seekToTime(segment.startTime)
                  }} 
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <Modal title="AI 纠错结果" open={modalOpen} onCancel={() => setModalOpen(false)} footer={null} width={640}>
        {currentResult && <DiffView original={segments.map((s) => s.originalText ?? s.text).join('\n')} corrected={currentResult.corrected} changes={currentResult.changes} />}
      </Modal>
    </>
  )
}
