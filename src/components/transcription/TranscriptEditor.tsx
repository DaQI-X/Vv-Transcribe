/**
 * 转写结果编辑器组件
 * 展示转写段落列表，支持：
 * - 段落文本编辑（TextArea 行内编辑）
 * - 上传参考稿比对（字级 diff，点击校对后分析差异 + 参考稿疑问）
 * - 校对（本地/ AI 两种方式；有参考稿以参考稿为准，行内 Popover 显示说明）
 * - 多格式字幕导出（SRT / VTT 字幕、台词表 TSV、TXT、JSON、Markdown）
 * - 一键字幕配音（跳到「字幕配音」工作台，这一段稿子按时间轴铺成一条独立音轨）
 * - 点击段落跳转到对应播放时间点
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Pencil, Download, FileText, X, ArrowLeft, AudioLines } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { Dropdown } from '@/components/ui/Dropdown'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { usePlayerStore } from '@/stores/usePlayerStore'
import { useReferenceStore } from '@/stores/useReferenceStore'
import { useVoiceStudioStore } from '@/stores/useVoiceStudioStore'
import { SegmentRow } from './SegmentRow'
import { ProofreadModeDialog, type ProofreadMode } from './ProofreadModeDialog'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { exportTranscript, getExportExtension } from '@/utils/exportTranscript'
import { checkCorrectionReady, hasCorrectionModel, raiseReadinessBlock } from '@/utils/readiness'
import { hasLocalProofreadRules, languageLabel } from '@/utils/asrLanguage'
import { compareWithReference } from '@/utils/referenceComparator'
import { computeSegmentDiff } from '@/utils/segmentDiff'
import { alignReferenceToSegments } from '@/utils/textAlignment'
import { alignCorrectedToSegments } from '@/utils/correctedTextAlignment'
import type { ExportFormat } from '@/types/transcription'
import type { SegmentDiff, DiffExplanation, ReferenceIssue } from '@/types/reference'

const FORMAT_OPTIONS: { key: ExportFormat; label: string }[] = [
  { key: 'srt', label: 'SRT 字幕文件' }, { key: 'vtt', label: 'VTT 字幕文件' },
  { key: 'tsv', label: '台词表 TSV（时间码 + 台词）' }, { key: 'txt', label: '纯文本 TXT' },
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

/** 只有参考稿疑问、没有字面差异的段落占位：DiffPanel 按 referenceIssues 渲染 */
function emptySegmentDiff(segmentId: string): SegmentDiff {
  return {
    segmentId,
    chunks: [],
    explanations: [],
    referenceIssues: [],
    hasDifference: false,
    totalChanges: 0,
  }
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
      <FileText className="reference-bubble__icon" size={14} />
      <span className="reference-bubble__name" title={fileName}>{fileName}</span>
      <button className="reference-bubble__close" onClick={onClear} disabled={disabled} title="清除参考">
        <X size={10} />
      </button>
    </div>
  )
}

export function TranscriptEditor({ onGoHome }: { onGoHome?: () => void }) {
  const { segments, updateSegment, asrProvider, asrLanguage, fileName } = useTranscriptionStore()
  const { activeSegmentId, seekToTime, setActiveSegment } = usePlayerStore()
  const {
    referenceText, referenceFileName, segmentDiffs,
    setReference, clearReference, setAllSegmentDiffs, setStatus, setError,
  } = useReferenceStore()

  // 本地校对吃的是「常见误听表 + 中文词库」，非中文素材跑它等于空转。
  // 不是禁用了事：大模型那条路照走，只是把这条的限制说清楚。
  const localUnavailableReason = hasLocalProofreadRules(asrLanguage)
    ? undefined
    : `本地校对只支持中文（靠常见误听表和中文词库逐段修正），当前转写语言是「${languageLabel(asrLanguage)}」。想用 AI 校对，请到「设置 → 校对配置」填写 API Key`

  const activeRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(false)
  const [proofreadMode, setProofreadMode] = useState<ProofreadMode>('local')
  const [modeDialogOpen, setModeDialogOpen] = useState(false)
  const setVoiceTab = useVoiceStudioStore((s) => s.setTab)

  useEffect(() => {
    if (activeRef.current) activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [activeSegmentId])

  const totalChars = segments.reduce((sum, seg) => sum + seg.text.length, 0)

  const handleExport = async (format: ExportFormat) => {
    const api = getElectronAPI()
    if (!api || segments.length === 0) return

    const content = exportTranscript(segments, format)
    const ext = getExportExtension(format)
    const baseName = fileName?.replace(/\.[^.]+$/, '') ?? 'transcript'

    try {
      const result = await api.saveTextFile(`${baseName}.${ext}`, content)
      if (result.canceled) return
      if (result.success) {
        toast.success(`已导出 ${result.name}`)
      } else {
        toast.error(result.error || '导出失败')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导出失败')
    }
  }

  const fetchExplanations = useCallback(async (
    diffs: Map<string, SegmentDiff>,
    mode: ProofreadMode,
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

    const explanations = mode === 'local'
      ? await api.proofreadExplain(allDiffs)
      : await api.explainDifferences(allDiffs)
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

  const runProofread = useCallback(async (mode: ProofreadMode) => {
    const api = getElectronAPI()
    if (!api || segments.length === 0) return

    // 本地校对这条路径不看 Key；只有走大模型才需要前置校验
    if (mode === 'ai') {
      const blocked = await checkCorrectionReady()
      if (blocked) {
        raiseReadinessBlock(blocked)
        return
      }
    }

    const modeLabel = mode === 'local' ? '本地校对' : 'AI 校对'
    setProofreadMode(mode)
    setLoading(true)

    const waitingMessages = ['再等等～', '再等等等～', '再等等等等～', '再等等等等等～', '马上就好～']
    let waitingIndex = 0
    const waitingTimer = setInterval(() => {
      toast.info(waitingMessages[waitingIndex % waitingMessages.length], 1500)
      waitingIndex++
    }, 15000)

    try {
      if (referenceText) {
        setStatus('comparing')
        const alignment = alignReferenceToSegments(segments, referenceText)
        const diffs = compareWithReference(segments, referenceText)
        const totalChanges = Array.from(diffs.values()).reduce((sum, d) => sum + d.totalChanges, 0)

        setStatus('explaining')

        // 参考稿本身的疑问只有大模型能判，本地模式跳过；逐字差异是本地算的，照样有效
        const [explainedDiffs, referenceAnalysis] = await Promise.all([
          fetchExplanations(diffs, mode),
          mode === 'local' ? Promise.resolve(null) : api.analyzeReference(referenceText),
        ])

        if (referenceAnalysis) {
          const issuesBySegment = mapIssuesToSegments(referenceAnalysis.issues, alignment)
          for (const [segId, issues] of issuesBySegment) {
            // 没被对齐上的段落不会出现在 diffs 里，可它的「参考稿疑问」照样得显示：
            // 补一个空差异占位，否则这段疑问会被整段丢弃、用户看不到任何提示
            const segDiff = explainedDiffs.get(segId) ?? emptySegmentDiff(segId)
            segDiff.referenceIssues = issues
            explainedDiffs.set(segId, segDiff)
          }
        }

        setAllSegmentDiffs(explainedDiffs)
        setStatus('completed')

        const issueCount = referenceAnalysis?.issues.length ?? 0
        if (referenceAnalysis?.error) {
          // 字符级差异是本地算出来的，AI 分析失败时照样有效，只把 AI 那部分的失败如实说出
          toast.error(`${referenceAnalysis.error}（下方差异为逐字比对结果，不含 AI 判断）`)
        } else if (totalChanges === 0 && issueCount === 0) {
          toast.info('转写内容与参考稿一致，无需校对')
        } else {
          const parts: string[] = []
          if (totalChanges > 0) parts.push(`${totalChanges} 处差异`)
          if (issueCount > 0) parts.push(`${issueCount} 处参考稿疑问`)
          toast.success(`${modeLabel}完成（以参考稿为准），${parts.join('，')}`)
        }
        return
      }

      setStatus('comparing')
      const diffs = new Map<string, SegmentDiff>()

      if (mode === 'local') {
        const local = await api.proofreadLocal(segments.map((s) => ({ id: s.id, text: s.text })))
        // 与云端那一支同一个口径：本地校对没跑成不能走到下面那句「未发现需要纠正的内容」——
        // 那是磁盘/词库读失败，不是这份稿子真的没得改
        if (local.error) {
          setStatus('idle')
          toast.error(local.error)
          return
        }
        for (const result of local.results) {
          const seg = segments.find((s) => s.id === result.segmentId)
          if (!seg || result.corrected === seg.text) continue
          diffs.set(result.segmentId, computeSegmentDiff(seg.text, result.corrected, seg.id))
        }
      } else {
        const fullText = segments.map((s) => s.text).join('')
        const result = await api.correctText(fullText, { language: asrLanguage })

        if (result.error) {
          setStatus('idle')
          toast.error(result.error)
          return
        }

        if (!result.corrected || result.corrected.trim() === fullText) {
          setStatus('idle')
          toast.info('未发现需要纠正的内容')
          return
        }

        const correctedLines = alignCorrectedToSegments(segments, result.corrected)
        segments.forEach((seg, idx) => {
          const correctedText = correctedLines[idx] ?? seg.text
          if (correctedText !== seg.text) {
            diffs.set(seg.id, computeSegmentDiff(seg.text, correctedText, seg.id))
          }
        })
      }

      if (diffs.size === 0) {
        setStatus('idle')
        toast.info('未发现需要纠正的内容')
        return
      }

      setStatus('explaining')
      const explainedDiffs = await fetchExplanations(diffs, mode)
      setAllSegmentDiffs(explainedDiffs)
      setStatus('completed')

      const totalChanges = Array.from(diffs.values()).reduce((sum, d) => sum + d.totalChanges, 0)
      toast.success(`${modeLabel}完成，共 ${totalChanges} 处差异`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '校对失败')
      toast.error(`${modeLabel}失败`)
    } finally {
      clearInterval(waitingTimer)
      setLoading(false)
    }
  }, [segments, referenceText, asrLanguage, setAllSegmentDiffs, setStatus, setError, fetchExplanations])

  /** 没配模型就不弹选择框——直接本地跑完，并把「为什么只有本地结果」说清楚 */
  const handleProofreadClick = useCallback(async () => {
    const hasModel = await hasCorrectionModel()

    // 非中文时本地校对这条路不成立，也不偷偷降级：配了模型就让用户在弹窗里选（本地项已置灰说明原因），
    // 没配就只能把他送到校对配置那页
    if (localUnavailableReason) {
      if (!hasModel) {
        raiseReadinessBlock({ message: localUnavailableReason, settingsTab: 'ai' })
        return
      }
      setModeDialogOpen(true)
      return
    }

    if (!hasModel) {
      toast.info('未配置校对模型，已用本地校对。想要结合上下文的结果，可在「设置 → 校对配置」里填写 API Key', 5000)
      void runProofread('local')
      return
    }
    setModeDialogOpen(true)
  }, [runProofread, localUnavailableReason])

  const handlePickMode = useCallback((mode: ProofreadMode) => {
    setModeDialogOpen(false)
    void runProofread(mode)
  }, [runProofread])

  const handleUploadReference = useCallback(async () => {
    const api = getElectronAPI()
    if (!api || segments.length === 0) return

    if (referenceText) {
      toast.error('上传失败，已存在参考文件，请先清除后再上传')
      return
    }

    try {
      const filePath = await api.selectTextFile()
      if (!filePath) return

      const content = await api.readTextFile(filePath)
      if (!content || !content.trim()) {
        toast.error('参考文件为空或读取失败')
        return
      }

      const name = filePath.split('/').pop() ?? '参考稿'
      setReference(content, name)

      const diffs = compareWithReference(segments, content)
      setAllSegmentDiffs(diffs)

      const totalChanges = Array.from(diffs.values()).reduce((sum, d) => sum + d.totalChanges, 0)
      if (totalChanges === 0) {
        toast.info('参考稿已上传，转写内容与参考稿一致')
      } else {
        toast.success(`参考稿已上传，共 ${totalChanges} 处差异，点击「校对」查看详细说明`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '参考稿上传失败')
      toast.error('参考稿上传失败')
    }
  }, [segments, setReference, setAllSegmentDiffs, setError])

  const handleClearReference = useCallback(() => {
    clearReference()
    toast.info('已清除参考稿')
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
      toast.success('已采纳修正')
    }
  }, [segmentDiffs, updateSegment])

  if (segments.length === 0) {
    return (
      <div className="transcript-editor__empty">
        <span className="transcript-editor__empty-text">暂无转写内容</span>
        {/* 空状态原来只有一句话，「返回首页」在下面的正文分支里——一句人声都没有的素材跑完就卡在这 */}
        {onGoHome && (
          <button onClick={onGoHome} className="transcript-editor__back-btn" title="返回首页">
            <ArrowLeft size={14} />
            <span>返回首页</span>
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="transcript-editor">
      <div className="transcript-editor__header">
        <div className="transcript-editor__title-group">
          {onGoHome && (
            <button onClick={onGoHome} className="transcript-editor__back-btn" title="返回首页">
              <ArrowLeft size={14} />
              <span>返回首页</span>
            </button>
          )}
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
            <FileText size={14} /> 上传参考
          </button>
          <button
            onClick={handleProofreadClick}
            disabled={loading}
            className="transcript-editor__correct-btn"
          >
            <Pencil size={14} />
            {loading ? (proofreadMode === 'local' ? '本地校对中…' : 'AI 校对中…') : '校对'}
          </button>
          <button
            onClick={() => setVoiceTab('voice')}
            disabled={loading}
            className="transcript-editor__voice-btn"
          >
            <AudioLines size={14} /> 字幕配音
          </button>
          <Dropdown items={FORMAT_OPTIONS.map((opt) => ({ key: opt.key, label: opt.label, onClick: () => handleExport(opt.key) }))}>
            <button className="transcript-editor__export-btn">
              <Download size={14} />导出
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
                diffMode={referenceText ? 'reference' : 'proofread'}
                onClick={() => {
                  setActiveSegment(segment.id)
                  seekToTime(segment.startTime)
                }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* 参考稿气泡是视口级浮层，必须挂在 body 上：卡片 hover 的 transform（以及入场动画）
          会把 position: fixed 的后代重新锚定到卡片里，鼠标一进一出气泡就会跳位。 */}
      {referenceFileName &&
        createPortal(
          <ReferenceBubble fileName={referenceFileName} onClear={handleClearReference} disabled={loading} />,
          document.body,
        )}

      {modeDialogOpen && (
        <ProofreadModeDialog
          onPick={handlePickMode}
          onClose={() => setModeDialogOpen(false)}
          localUnavailableReason={localUnavailableReason}
        />
      )}
    </div>
  )
}
