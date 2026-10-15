/**
 * 转写结果编辑器组件
 * 展示转写段落列表，支持：
 * - 段落文本编辑（TextArea 行内编辑）
 * - 上传参考稿比对（字级 diff，点击 AI 纠错后分析差异 + 参考稿疑问）
 * - AI 纠错（有参考稿以参考稿为准，无参考稿调用 AI，行内 Popover 显示）
 * - 多格式导出（SRT / TXT / JSON / Markdown）
 * - 点击段落跳转到对应播放时间点
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { message, Dropdown } from 'antd'
import { EditOutlined, ExportOutlined, FileTextOutlined, CloseOutlined } from '@ant-design/icons'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { usePlayerStore } from '@/stores/usePlayerStore'
import { useReferenceStore } from '@/stores/useReferenceStore'
import { SegmentRow } from './SegmentRow'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { exportTranscript, getExportExtension } from '@/utils/exportTranscript'
import { compareWithReference } from '@/utils/referenceComparator'
import { computeSegmentDiff } from '@/utils/segmentDiff'
import { alignReferenceToSegments } from '@/utils/textAlignment'
import { alignCorrectedToSegments } from '@/utils/correctedTextAlignment'
import type { ExportFormat } from '@/types/transcription'
import type { SegmentDiff, DiffExplanation, ReferenceIssue } from '@/types/reference'

const FORMAT_OPTIONS: { key: ExportFormat; label: string }[] = [
  { key: 'srt', label: 'SRT 字幕文件' }, { key: 'txt', label: '纯文本 TXT' },
  { key: 'json', label: 'JSON 数据' }, { key: 'md', label: 'Markdown 文档' },
]

interface DifferenceItem { original: string; corrected: string; context: string }

interface RawReferenceIssue {
  text: string
  suggestion?: string
  explanation: string
  dictionaryHint?: string
  refStart: number
  refEnd: number
}

function mapIssuesToSegments(
  issues: RawReferenceIssue[],
  alignment: Array<{ segmentId: string; referenceStart: number; referenceEnd: number }>,
): Map<string, ReferenceIssue[]> {
  const result = new Map<string, ReferenceIssue[]>()

  for (const issue of issues) {
    for (const span of alignment) {
      if (span.referenceStart < 0) continue
      const overlaps = issue.refStart < span.referenceEnd && issue.refEnd > span.referenceStart
      if (overlaps) {
        const existing = result.get(span.segmentId) ?? []
        existing.push({
          text: issue.text,
          suggestion: issue.suggestion,
          explanation: issue.explanation,
          dictionaryHint: issue.dictionaryHint,
        })
        result.set(span.segmentId, existing)
      }
    }
  }

  return result
}

function ReferenceBubble({ fileName, onClear, disabled }: { fileName: string; onClear: () => void; disabled?: boolean }) {
  return (
    <div className="reference-bubble">
      <FileTextOutlined className="reference-bubble__icon" />
      <span className="reference-bubble__name" title={fileName}>{fileName}</span>
      <button className="reference-bubble__close" onClick={onClear} disabled={disabled} title="清除参考">
        <CloseOutlined />
      </button>
    </div>
  )
}

export function TranscriptEditor() {
  const { segments, updateSegment, asrProvider, fileName } = useTranscriptionStore()
  const { activeSegmentId, seekToTime, setActiveSegment } = usePlayerStore()
  const {
    referenceText, referenceFileName, segmentDiffs,
    setReference, clearReference, setAllSegmentDiffs, setStatus, setError,
  } = useReferenceStore()

  const activeRef = useRef<HTMLDivElement>(null)
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

  const fetchExplanations = useCallback(async (
    diffs: Map<string, SegmentDiff>,
  ): Promise<Map<string, SegmentDiff>> => {
    const api = getElectronAPI()
    if (!api) return diffs

    const allDiffs: DifferenceItem[] = []
    const diffIndexMap: Array<{ segmentId: string; chunkIndex: number }> = []

    for (const [segId, segDiff] of diffs) {
      for (let i = 0; i < segDiff.chunks.length; i++) {
        const chunk = segDiff.chunks[i]
        if (chunk.type === 'insert' || chunk.type === 'delete') {
          const seg = segments.find((s) => s.id === segId)
          allDiffs.push({
            original: chunk.type === 'delete' ? chunk.value : '',
            corrected: chunk.type === 'insert' ? chunk.value : '',
            context: seg?.text ?? '',
          })
          diffIndexMap.push({ segmentId: segId, chunkIndex: i })
        }
      }
    }

    if (allDiffs.length === 0) return diffs

    const explanations = await api.explainDifferences(allDiffs)
    const updatedDiffs = new Map(diffs)

    for (let i = 0; i < diffIndexMap.length; i++) {
      const { segmentId, chunkIndex } = diffIndexMap[i]
      const segDiff = updatedDiffs.get(segmentId)
      if (segDiff && explanations[i]) {
        segDiff.explanations[chunkIndex] = explanations[i] as DiffExplanation
      }
    }

    return updatedDiffs
  }, [segments])

  const handleAICorrection = useCallback(async () => {
    const api = getElectronAPI()
    if (!api || segments.length === 0) return
    setLoading(true)

    const waitingMessages = ['再等等～', '再等等等～', '再等等等等～', '再等等等等等～', '马上就好～']
    let waitingIndex = 0
    const waitingTimer = setInterval(() => {
      message.info(waitingMessages[waitingIndex % waitingMessages.length], 1.5)
      waitingIndex++
    }, 15000)

    try {
      if (referenceText) {
        setStatus('comparing')
        const alignment = alignReferenceToSegments(segments, referenceText)
        const diffs = compareWithReference(segments, referenceText)
        const totalChanges = Array.from(diffs.values()).reduce((sum, d) => sum + d.totalChanges, 0)

        setStatus('explaining')

        const [explainedDiffs, rawIssues] = await Promise.all([
          fetchExplanations(diffs),
          api.analyzeReference(referenceText),
        ])

        const issuesBySegment = mapIssuesToSegments(rawIssues, alignment)
        for (const [segId, issues] of issuesBySegment) {
          const segDiff = explainedDiffs.get(segId)
          if (segDiff) {
            segDiff.referenceIssues = issues
          }
        }

        setAllSegmentDiffs(explainedDiffs)
        setStatus('completed')

        const issueCount = rawIssues.length
        if (totalChanges === 0 && issueCount === 0) {
          message.info('转写内容与参考稿一致，无需纠错')
        } else {
          const parts: string[] = []
          if (totalChanges > 0) parts.push(`${totalChanges} 处差异`)
          if (issueCount > 0) parts.push(`${issueCount} 处参考稿疑问`)
          message.success(`AI 纠错完成（以参考稿为准），${parts.join('，')}`)
        }
      } else {
        setStatus('comparing')
        const fullText = segments.map((s) => s.text).join('')
        const result = await api.correctText(fullText, { language: 'zh' })

        if (!result.corrected || result.corrected.trim() === fullText) {
          setStatus('idle')
          message.info('未发现需要纠正的内容')
          setLoading(false)
          return
        }

        // 使用文本对齐将纠错后的文本映射回各个段落
        const correctedLines = alignCorrectedToSegments(segments, result.corrected)
        const diffs = new Map<string, SegmentDiff>()

        segments.forEach((seg, idx) => {
          const correctedText = correctedLines[idx] ?? seg.text
          if (correctedText !== seg.text) {
            const diff = computeSegmentDiff(seg.text, correctedText, seg.id)
            diffs.set(seg.id, diff)
          }
        })

        setStatus('explaining')
        const explainedDiffs = await fetchExplanations(diffs)
        setAllSegmentDiffs(explainedDiffs)
        setStatus('completed')

        const totalChanges = Array.from(diffs.values()).reduce((sum, d) => sum + d.totalChanges, 0)
        message.success(`AI 纠错完成，共 ${totalChanges} 处差异`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI 纠错失败')
      message.error('AI 纠错失败')
    } finally {
      clearInterval(waitingTimer)
      setLoading(false)
    }
  }, [segments, referenceText, setAllSegmentDiffs, setStatus, setError, fetchExplanations])

  const handleUploadReference = useCallback(async () => {
    const api = getElectronAPI()
    if (!api || segments.length === 0) return

    if (referenceText) {
      message.error('上传失败，已存在参考文件，请先清除后再上传')
      return
    }

    try {
      const filePath = await api.selectTextFile()
      if (!filePath) return

      const content = await api.readTextFile(filePath)
      if (!content || !content.trim()) {
        message.error('参考文件为空或读取失败')
        return
      }

      const name = filePath.split('/').pop() ?? '参考稿'
      setReference(content, name)

      const diffs = compareWithReference(segments, content)
      setAllSegmentDiffs(diffs)

      const totalChanges = Array.from(diffs.values()).reduce((sum, d) => sum + d.totalChanges, 0)
      if (totalChanges === 0) {
        message.info('参考稿已上传，转写内容与参考稿一致')
      } else {
        message.success(`参考稿已上传，共 ${totalChanges} 处差异，点击"AI 纠错"查看详细说明`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '参考稿上传失败')
      message.error('参考稿上传失败')
    }
  }, [segments, setReference, setAllSegmentDiffs, setError])

  const handleClearReference = useCallback(() => {
    clearReference()
    message.info('已清除参考稿')
  }, [clearReference])

  const handleAcceptCorrection = useCallback((segmentId: string) => {
    const diff = segmentDiffs.get(segmentId)
    if (!diff) return

    let correctedText = ''
    for (const chunk of diff.chunks) {
      if (chunk.type === 'equal' || chunk.type === 'insert') {
        correctedText += chunk.value
      }
    }

    if (correctedText) {
      updateSegment(segmentId, correctedText)
      message.success('已采纳修正')
    }
  }, [segmentDiffs, updateSegment])

  if (segments.length === 0) {
    return (
      <div className="transcript-editor__empty">
        <span className="transcript-editor__empty-text">暂无转写内容</span>
      </div>
    )
  }

  return (
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
            onClick={handleUploadReference}
            disabled={!!referenceText}
            className="transcript-editor__ref-btn"
          >
            <FileTextOutlined /> 上传参考
          </button>
          <button
            onClick={handleAICorrection}
            disabled={loading}
            className="transcript-editor__correct-btn"
          >
            <EditOutlined />
            {loading ? '纠错中...' : 'AI 纠错'}
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
                diff={segmentDiffs.get(segment.id) ?? null}
                onAccept={() => handleAcceptCorrection(segment.id)}
                diffMode={referenceText ? 'reference' : 'ai'}
                onClick={() => {
                  setActiveSegment(segment.id)
                  seekToTime(segment.startTime)
                }}
              />
            </div>
          ))}
        </div>
      </div>

      {referenceFileName && (
        <ReferenceBubble fileName={referenceFileName} onClear={handleClearReference} disabled={loading} />
      )}
    </div>
  )
}
