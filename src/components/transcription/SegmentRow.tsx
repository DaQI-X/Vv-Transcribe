/**
 * 段落行组件
 * 显示单个转写段落的时间戳和可编辑文本
 * 点击时触发播放器跳转到对应时间点，播放时自动高亮当前段落
 * 支持参考稿比对差异展示和校对结果行内 Popover
 * 点时间那格改的是这一段的起止（#361 范围②，规矩在 src/utils/timelineEdit.ts）
 */
import { useState } from 'react'
import type { TranscriptionSegment } from '@/types/transcription'
import type { SegmentDiff } from '@/types/reference'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { usePlayerStore } from '@/stores/usePlayerStore'
import { formatTime } from '@/utils/formatTime'
import { editSegmentTimes, formatSeconds, parseSeconds } from '@/utils/timelineEdit'
import { Popover } from '@/components/ui/Popover'
import { toast } from '@/components/ui/Toast'
import { DiffPanel } from './DiffPanel'

interface SegmentRowProps {
  segment: TranscriptionSegment
  isActive?: boolean
  onClick?: () => void
  diff?: SegmentDiff | null
  onAccept?: () => void
  diffMode?: 'reference' | 'proofread'
}

/**
 * 一行字幕的起止编辑器。
 *
 * 两格填的是「秒」而不是 00:12 那种时码：填进去的数就是 segments 里存的数，也就是 SRT 那行
 * 换算之前的数，中间不需要第二个换算函数。本仓的时钟只有 src/utils/formatTime.ts 一把尺
 * （判据见 tests/formatTime.test.ts「时钟只剩一把尺」），再配一个「时码字符串 → 秒」的解析器，
 * 等于请人日后补第二把格式化尺来配平。想要一个现成的落点就点「取播放位置」，把播放器此刻那个数抄过来。
 */
function SegmentTimeEditor({ segment }: { segment: TranscriptionSegment }) {
  const { segments, setSegments } = useTranscriptionStore()
  const [start, setStart] = useState(formatSeconds(segment.startTime))
  const [end, setEnd] = useState(formatSeconds(segment.endTime))

  const save = () => {
    const result = editSegmentTimes(segments, segment.id, start, end)
    if (!result.ok) {
      // 拒掉的每一条都点名了要改的是哪一段、上限是多少秒，所以这条值得多停一会儿
      toast.error(result.error, 6000)
      return
    }
    setSegments(result.segments)
    if (result.changed) toast.success(result.summary)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      save()
    }
  }

  const takePlayhead = (field: 'start' | 'end') => {
    const text = formatSeconds(usePlayerStore.getState().currentTime)
    if (field === 'start') setStart(text)
    else setEnd(text)
  }

  const readStart = parseSeconds(start)
  const readEnd = parseSeconds(end)

  return (
    <div className="time-editor">
      <div className="time-editor__field">
        <span className="time-editor__label">起（秒）</span>
        <input
          className="time-editor__input"
          value={start}
          onChange={(event) => setStart(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="time-editor__capture" onClick={() => takePlayhead('start')}>
          取播放位置
        </button>
      </div>
      <div className="time-editor__field">
        <span className="time-editor__label">止（秒）</span>
        <input
          className="time-editor__input"
          value={end}
          onChange={(event) => setEnd(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="time-editor__capture" onClick={() => takePlayhead('end')}>
          取播放位置
        </button>
      </div>
      <div className="time-editor__foot">
        <span className="time-editor__readout">
          {readStart === null || readEnd === null
            ? '两格都得填数字才生效'
            : `界面读数 ${formatTime(readStart)} → ${formatTime(readEnd)}`}
        </span>
        <button className="time-editor__save" onClick={save}>
          保存
        </button>
      </div>
    </div>
  )
}

export function SegmentRow({ segment, isActive, onClick, diff, onAccept, diffMode }: SegmentRowProps) {
  const { updateSegment } = useTranscriptionStore()
  // 只有「参考稿疑问」、字面没差异的段落也要亮出来，否则用户看不到 AI 提的那条疑问
  const showPanel = !!diff && (diff.hasDifference || diff.referenceIssues.length > 0)

  return (
    <div className={`segment-row ${isActive ? 'active' : ''} ${showPanel ? 'segment-row--has-diff' : ''}`} onClick={onClick}>
      {/* 这一格不跟着整行跳播放点：它现在是编辑器，跳过去会把刚要填的数冲成下一个问题 */}
      <div className="segment-row__time" onClick={(event) => event.stopPropagation()}>
        <Popover content={<SegmentTimeEditor segment={segment} />} placement="bottom">
          <span className="segment-row__time-text" title="点击改这一段的起止时间">
            {formatTime(segment.startTime)}
          </span>
        </Popover>
      </div>
      <div className="segment-row__content">
        <textarea
          className="segment-row__textarea"
          value={segment.text}
          onChange={(e) => updateSegment(segment.id, e.target.value)}
          onClick={(e) => e.stopPropagation()}
          rows={1}
          style={{
            width: '100%',
            overflow: 'hidden',
            resize: 'none',
          }}
          onInput={(e) => {
            const target = e.target as HTMLTextAreaElement
            target.style.height = 'auto'
            target.style.height = target.scrollHeight + 'px'
          }}
        />
        {diff && showPanel && (
          <DiffPanel diff={diff} onAcceptAll={onAccept} mode={diffMode} />
        )}
      </div>
    </div>
  )
}
