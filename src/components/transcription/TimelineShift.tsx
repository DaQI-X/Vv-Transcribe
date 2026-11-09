/**
 * 「轴偏移」：把整条时间轴往前或往后挪同一个量（#361 范围①）。
 *
 * 为什么单独占列表顶上那一格、而不是塞进每一行：整条偏 0.2 秒是最常见的那种毛病——引擎断句没错，
 * 就是整体早了或晚了。一行一行改要改几百次，而且得从最后一段往前倒着改才不撞重叠闸门；
 * 而加同一个增量既造不出重叠也造不出倒序，所以这一格只需要一道「不许把最早的段推到 0 之前」，
 * 不用单段那套相邻检查（都在 timelineEdit.ts）。
 * 挪过了想回来，填一个相反数就是精确撤回：段与段之间的距离一直没动。
 */
import { useState } from 'react'
import { MoveHorizontal } from 'lucide-react'
import { Popover } from '@/components/ui/Popover'
import { toast } from '@/components/ui/Toast'
import { useTranscriptionStore } from '@/stores/useTranscriptionStore'
import { formatSeconds, shiftTimeline, timelineSpan } from '@/utils/timelineEdit'

export function TimelineShift() {
  const { segments, setSegments } = useTranscriptionStore()
  const [text, setText] = useState('')
  const span = timelineSpan(segments)
  // 跟那两句回执同一个数：shiftTimeline 报的段数把空洞剔掉了，这里别多报
  const count = segments.filter(Boolean).length

  const apply = () => {
    const result = shiftTimeline(segments, text)
    if (!result.ok) {
      toast.error(result.error, 6000)
      return
    }
    setSegments(result.segments)
    setText('')
    toast.success(result.summary)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      apply()
    }
  }

  return (
    <Popover
      placement="bottom"
      content={
        <div className="axis-shift">
          <div className="axis-shift__field">
            <input
              className="axis-shift__input"
              placeholder="0.2 或 -1.5"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
            />
            <button className="axis-shift__apply" onClick={apply}>
              应用
            </button>
          </div>
          <p className="axis-shift__hint">
            {span
              ? `单位秒，正数往后、负数往前，一次改完全部 ${count} 段。往前最多 ${formatSeconds(span.start)} 秒——最早那段就从那儿起。`
              : '单位秒，正数往后、负数往前。'}
          </p>
        </div>
      }
    >
      <button className="transcript-editor__axis-btn">
        <MoveHorizontal size={14} /> 轴偏移
      </button>
    </Popover>
  )
}
