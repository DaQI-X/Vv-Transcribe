/**
 * 段落行组件
 * 显示单个转写段落的时间戳和可编辑文本
 * 左键点行＝跳到那个播放点（时间那格不再有特殊行为，免得想跳播放却开出输入框）
 * 双击时间那格＝行内展开这一段的起止编辑条；右键这一行＝这一段的动作菜单
 * 动作菜单里 #361 那两个（改起止、把播放位置落成起/止）之外，1.1.5 补上拆/并/删三个结构动作：
 * 拆与并都是点一下就落地，不额外要一个数——文字切点就是这一行的光标，时间按两半的字数摊；
 * 只有删要展开一条确认条，它是这三个里唯一把一行字整个丢掉的
 * 支持参考稿比对差异展示和校对结果行内 Popover
 * 单位、闸门、回执的规矩全在 src/utils/timelineEdit.ts，这里只搬过来
 */
import { useEffect, useRef, useState } from 'react'
import type { TranscriptionSegment } from '@/types/transcription'
import type { SegmentDiff } from '@/types/reference'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { usePlayerStore } from '@/stores/usePlayerStore'
import { formatTime } from '@/utils/formatTime'
import {
  deleteSegment,
  editSegmentTimes,
  formatSeconds,
  mergeSegment,
  parseSeconds,
  splitSegment,
} from '@/utils/timelineEdit'
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu'
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

/** 这一行底下同时只摊一条：改起止 / 删（拆与并点一下就走，不摊条） */
type Strip = 'time' | 'delete' | null

/**
 * 一行字幕的起止编辑条（展开在那一行底下，跟差异面板同一个位置）。
 *
 * 两格填的是「秒」而不是 00:12 那种时码：填进去的数就是 segments 里存的数，也就是 SRT 那行
 * 换算之前的数，中间不需要第二个换算函数。本仓的时钟只有 src/utils/formatTime.ts 一把尺
 * （判据见 tests/formatTime.test.ts「时钟只剩一把尺」），再配一个「时码字符串 → 秒」的解析器，
 * 等于请人日后补第二把格式化尺来配平。想要一个现成的落点就点「取播放位置」，把播放器此刻那个数抄过来。
 *
 * 拒掉的时候不关这条：那句错误里点名了上限是多少秒、要先改哪一段，用户往往就地就能把数改对。
 */
function SegmentTimeEditor({ segment, onClose }: { segment: TranscriptionSegment; onClose: () => void }) {
  const { segments, setSegments } = useTranscriptionStore()
  const [start, setStart] = useState(formatSeconds(segment.startTime))
  const [end, setEnd] = useState(formatSeconds(segment.endTime))
  const startRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    startRef.current?.focus()
    startRef.current?.select()
  }, [])

  const save = () => {
    const result = editSegmentTimes(segments, segment.id, start, end)
    if (!result.ok) {
      // 拒掉的每一条都点名了要改的是哪一段、上限是多少秒，所以这条值得多停一会儿
      toast.error(result.error, 6000)
      return
    }
    setSegments(result.segments)
    if (result.changed) toast.success(result.summary)
    onClose()
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
    <div className="time-editor" onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      <div className="time-editor__field">
        <span className="time-editor__label">起（秒）</span>
        <input
          ref={startRef}
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
        <button className="time-editor__capture" onClick={onClose}>
          取消
        </button>
        <button className="time-editor__save" onClick={save}>
          保存
        </button>
      </div>
    </div>
  )
}

/**
 * 删段的确认条：删是唯一一个不回来得了的动作，所以它要一次点击确认，且当场说清留下什么。
 *
 * 不自动把后面的行往前挪是刻意的（规矩在 timelineEdit.ts），这句话就得在这儿说到，
 * 否则用户删完只看到多出来的空档，不知道是谁干的。
 */
function SegmentDeleteConfirm({
  segment,
  hole,
  onClose,
}: {
  segment: TranscriptionSegment
  hole: { start: number; end: number } | null
  onClose: () => void
}) {
  const { segments, setSegments } = useTranscriptionStore()

  const remove = () => {
    const result = deleteSegment(segments, segment.id)
    if (!result.ok) {
      toast.error(result.error, 6000)
      return
    }
    setSegments(result.segments)
    toast.success(result.summary)
    onClose()
  }

  return (
    <div className="time-editor" onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      <p className="segment-structure__note">
        删掉这一行只删它自己
        {hole
          ? `：${formatSeconds(hole.start)}–${formatSeconds(hole.end)} 秒会留成空档，后面的行不往前挪。要整条轴往前挪，用工具条上那颗「轴偏移」`
          : '，后面的行不往前挪'}
        。
      </p>
      <div className="time-editor__foot">
        <button className="time-editor__capture" onClick={onClose}>
          取消
        </button>
        <button className="segment-structure__danger" onClick={remove}>
          删除这一段
        </button>
      </div>
    </div>
  )
}

export function SegmentRow({ segment, isActive, onClick, diff, onAccept, diffMode }: SegmentRowProps) {
  const { segments, setSegments, updateSegment } = useTranscriptionStore()
  const [strip, setStrip] = useState<Strip>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 只有「参考稿疑问」、字面没差异的段落也要亮出来，否则用户看不到 AI 提的那条疑问
  const showPanel = !!diff && (diff.hasDifference || diff.referenceIssues.length > 0)

  const index = segments.findIndex((seg) => seg?.id === segment.id)
  const prev = index > 0 ? segments[index - 1] : undefined
  const next = index + 1 < segments.length ? segments[index + 1] : undefined
  // 删掉这一行之后，前后两行之间露出来的那段空白（贴着的话就不算）
  const hole = prev && next && next.startTime > prev.endTime ? { start: prev.endTime, end: next.startTime } : null

  /**
   * 右键菜单里那两格「设为播放位置」：一步落地，不用先开编辑条再点两次。
   * 走的是同一个 editSegmentTimes，闸门与回执跟手动填数完全一样——播放位置撞上邻居
   * 照样拒，拒的那句会说要先改哪一段。
   */
  const setBoundaryFromPlayhead = (field: 'start' | 'end') => {
    const playhead = formatSeconds(usePlayerStore.getState().currentTime)
    const result = editSegmentTimes(
      segments,
      segment.id,
      field === 'start' ? playhead : formatSeconds(segment.startTime),
      field === 'end' ? playhead : formatSeconds(segment.endTime),
    )
    if (!result.ok) {
      toast.error(result.error, 6000)
      return
    }
    setSegments(result.segments)
    if (result.changed) toast.success(result.summary)
  }

  /**
   * 拆段的切点直接取这一行 textarea 此刻的光标位——从 DOM 读，不自己存一份：
   * 存进 state 的那份要跟每次点击同步，而右键菜单不在 textarea 里，它按下时光标已经定好了。
   * 没点进这一行时它是 0，那一刀切不出前半，拒掉的那句会教他把光标放到哪儿。
   */
  const splitAtCaret = () => {
    const result = splitSegment(segments, segment.id, textareaRef.current?.selectionStart ?? 0)
    if (!result.ok) {
      toast.error(result.error, 6000)
      return
    }
    setSegments(result.segments)
    toast.success(result.summary)
  }

  const mergeNext = () => {
    const result = mergeSegment(segments, segment.id)
    if (!result.ok) {
      toast.error(result.error, 6000)
      return
    }
    setSegments(result.segments)
    toast.success(result.summary)
  }

  const menuItems: ContextMenuItem[] = [
    { label: '改这一段的起止', onSelect: () => setStrip('time') },
    { label: '起点设为播放位置', onSelect: () => setBoundaryFromPlayhead('start') },
    { label: '止点设为播放位置', onSelect: () => setBoundaryFromPlayhead('end') },
    { label: '从光标处拆开', onSelect: splitAtCaret },
    { label: '与下一段合并', onSelect: mergeNext, disabled: !next },
    { label: '删除这一段', onSelect: () => setStrip('delete') },
  ]

  return (
    <div
      className={`segment-row ${isActive ? 'active' : ''} ${showPanel ? 'segment-row--has-diff' : ''}`}
      onClick={onClick}
      onContextMenu={(event) => {
        // 右键这一行不做跳转，只开菜单；原生菜单本仓没装，不拦也不会露出空白项
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      {/* 这一格跟整行同一个左键行为（跳到那个播放点）；改起止要双击，或右键选第一项。
          双击前那两下左键只是把播放点跳到这里，没有别的副作用。 */}
      <div
        className="segment-row__time"
        onDoubleClick={(event) => {
          event.stopPropagation()
          setStrip('time')
        }}
      >
        <span className="segment-row__time-text" title="双击改这一段的起止时间（或右键这一行）">
          {formatTime(segment.startTime)}
        </span>
      </div>
      <div className="segment-row__content">
        <textarea
          ref={textareaRef}
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
        {strip && (
          // 编辑条底下这层不跟着整行跳播放点：跳过去会把刚要填的数冲成下一个问题
          <div className="segment-row__strip" onClick={(e) => e.stopPropagation()}>
            {strip === 'time' && <SegmentTimeEditor segment={segment} onClose={() => setStrip(null)} />}
            {strip === 'delete' && (
              <SegmentDeleteConfirm segment={segment} hole={hole} onClose={() => setStrip(null)} />
            )}
          </div>
        )}
        {diff && showPanel && <DiffPanel diff={diff} onAcceptAll={onAccept} mode={diffMode} />}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  )
}
