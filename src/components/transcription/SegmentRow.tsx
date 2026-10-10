/**
 * 段落行组件
 * 显示单个转写段落的时间戳和可编辑文本
 * 点击时触发播放器跳转到对应时间点，播放时自动高亮当前段落
 */
import { Input } from 'antd'
import type { TranscriptionSegment } from '@/types/transcription'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

interface SegmentRowProps {
  segment: TranscriptionSegment
  isActive?: boolean
  onClick?: () => void
}

export function SegmentRow({ segment, isActive, onClick }: SegmentRowProps) {
  const { updateSegment } = useTranscriptionStore()

  return (
    <div className={`segment-row ${isActive ? 'active' : ''}`} onClick={onClick}>
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
      </div>
    </div>
  )
}
