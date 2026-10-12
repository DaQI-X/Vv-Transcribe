/**
 * 段落行组件
 * 显示单个转写段落的时间戳和可编辑文本
 * 点击时触发播放器跳转到对应时间点，播放时自动高亮当前段落
 * 支持参考稿比对差异展示和 AI 纠错行内 Popover
 */
import { Input } from 'antd'
import type { TranscriptionSegment } from '@/types/transcription'
import type { SegmentDiff } from '@/types/reference'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { DiffPanel } from './DiffPanel'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

interface SegmentRowProps {
  segment: TranscriptionSegment
  isActive?: boolean
  onClick?: () => void
  diff?: SegmentDiff | null
  onAccept?: () => void
  diffMode?: 'reference' | 'ai'
}

export function SegmentRow({ segment, isActive, onClick, diff, onAccept, diffMode }: SegmentRowProps) {
  const { updateSegment } = useTranscriptionStore()

  return (
    <div className={`segment-row ${isActive ? 'active' : ''} ${diff?.hasDifference ? 'segment-row--has-diff' : ''}`} onClick={onClick}>
      <div className="segment-row__time">
        <span className="segment-row__time-text">{formatTime(segment.startTime)}</span>
      </div>
      <div className="segment-row__content">
        <Input.TextArea
          className="segment-row__textarea"
          value={segment.text}
          onChange={(e) => updateSegment(segment.id, e.target.value)}
          autoSize={{ minRows: 1, maxRows: 4 }}
          onClick={(e) => e.stopPropagation()}
        />
        {diff && diff.hasDifference && (
          <DiffPanel diff={diff} onAcceptAll={onAccept} mode={diffMode} />
        )}
      </div>
    </div>
  )
}
