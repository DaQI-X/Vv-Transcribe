/**
 * 字幕时间轴的两个编辑动作（#361 范围①②）：整轴平移、单段改起止。拆段/合段/删段留 1.1.5。
 *
 * 为什么规矩全部写在这一层纯函数里，而不是界面里各写一份：这份 segments 同时被三处读——
 * 播放器靠「currentTime 落在哪个区间」决定亮哪一行（AudioPlayer.tsx:78 的 find，第一个命中就赢）、
 * 配音铺轴把数组序当时间序排（ttsService.ts 的 planPlacements：placedAt = max(clip.startTime, cursor)）、
 * 导出把两个时间点原样写进 SRT/VTT。「数组序＝时间序、相邻不重叠」是这三处共同的隐含前提。
 * 让用户写出重叠或倒序的轴，症状不是「这一行显示不对」，而是「配音轨和画面越到后面差越多」，
 * 他联不到刚才那个输入框——所以宁可当场拒掉，并点名「要挪到那儿得先改哪一段」。
 *
 * 单位是秒，跟 segments 里存的一致（渲染层、主进程、Python 引擎端到端都是秒）。
 * 界面不另起一把时码尺：给人看的读数仍然只有 src/utils/formatTime.ts 那一个（判据见
 * tests/formatTime.test.ts「时钟只剩一把尺」）。本文件的 formatSeconds 输出的是**数字**，
 * 用来把用户自己填进去的那个数原样念回给他，不参与读数口径。
 */
import type { TranscriptionSegment } from '@/types/transcription'

export type TimelineEditResult =
  | { ok: true; segments: TranscriptionSegment[]; changed: boolean; summary: string }
  | { ok: false; error: string }

/** 毫秒是 SRT/VTT 写得出的最低位：落到这里，反复平移才攒不出 00:01:02,3999999 这种小数尾巴 */
function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

/** 把秒当一个数字念回去（12.5 / 0.2 / -1），不是时钟 */
export function formatSeconds(seconds: number): string {
  return String(roundMs(seconds))
}

/**
 * 只认「一个十进制数」。不用裸 Number()：它把 '' 读成 0（等于一声不吭把整轴拉回 0 点）、
 * 把 '0x10' 读成 16、把 '1e3' 读成 1000——用户以为自己填的是偏移量，生效的却是另一个数。
 * 界面那格「实时读数预览」也走它，为的是预览和真正生效的那个数是同一个判式。
 */
export function parseSeconds(text: string): number | null {
  const trimmed = text.trim()
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

/** 这份稿子在时间轴上占的范围；空稿返回 null */
export function timelineSpan(
  segments: TranscriptionSegment[],
): { start: number; end: number } | null {
  let start = Infinity
  let end = -Infinity
  for (const seg of segments) {
    if (!seg) continue
    if (seg.startTime < start) start = seg.startTime
    if (seg.endTime > end) end = seg.endTime
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return { start: roundMs(start), end: roundMs(end) }
}

/**
 * 整轴平移：所有段加同一个偏移量（秒，负数往前）。
 * 只可能坏在一件事上——最早的段被推到 0 之前；同一个增量既造不出重叠也造不出倒序，所以不查相邻。
 */
export function shiftTimeline(
  segments: TranscriptionSegment[],
  offsetText: string,
): TimelineEditResult {
  const span = timelineSpan(segments)
  if (!span) return { ok: false, error: '还没有字幕，时间轴没东西可移' }

  const offset = parseSeconds(offsetText)
  if (offset === null) {
    return {
      ok: false,
      error: `偏移量得是一个数字（单位秒），比如 0.2 或 -1.5。你填的是「${offsetText.trim()}」`,
    }
  }
  const delta = roundMs(offset)
  if (delta === 0) return { ok: false, error: '偏移量是 0，时间轴不会有任何变化；要往前挪就填负数' }

  const firstStart = roundMs(span.start + delta)
  if (firstStart < 0) {
    return {
      ok: false,
      error: `最多只能往前 ${formatSeconds(span.start)} 秒：最早那段现在从 ${formatSeconds(span.start)} 秒开始，再往前就掉到 0 之前了`,
    }
  }

  const next = segments.map((seg) =>
    seg
      ? { ...seg, startTime: roundMs(seg.startTime + delta), endTime: roundMs(seg.endTime + delta) }
      : seg,
  )
  const count = segments.filter(Boolean).length
  const shiftedEnd = roundMs(span.end + delta)
  return {
    ok: true,
    segments: next,
    changed: true,
    // 端点报「秒」而不是 00:02 那种读数：挪 0.5 秒时界面那格的时钟不动（formatTime 取整秒），
    // 回一句「现在从 00:02 到 00:32」听起来就像什么都没发生（#287 踩过同一坑，见那次的判据）。
    // 想看看懂的那个读数，编辑气泡底下有一行专门标着「界面读数」。
    summary: `${count} 段整体${delta > 0 ? '往后' : '往前'} ${formatSeconds(Math.abs(delta))} 秒，轴现在是 ${formatSeconds(firstStart)}–${formatSeconds(shiftedEnd)} 秒`,
  }
}

/**
 * 单段改起止：只换这一段的两个时间点，**id 不动**。
 * id 同时是 React 的 key、参考稿 diff 的对账键、配音批次的段引用；改轴不改字，动 id 会把三处对应关系一起冲掉。
 *
 * 不给止点按文件总时长封顶：ffprobe 读 mp3 拿到的是容器估算值，本身就可能比真实音频长或短，
 * 用会飘的数当闸门会把合法编辑拒掉。真填长了播放停在那段末尾、导出照写那两个数，都不算坏文件。
 */
export function editSegmentTimes(
  segments: TranscriptionSegment[],
  segmentId: string,
  startText: string,
  endText: string,
): TimelineEditResult {
  const index = segments.findIndex((seg) => seg?.id === segmentId)
  if (index < 0) return { ok: false, error: '没找到这一段，列表可能已经变了；重新点一下那行再试' }
  const current = segments[index]

  const parsedStart = parseSeconds(startText)
  if (parsedStart === null) {
    return {
      ok: false,
      error: `「起」得是一个数字（单位秒），比如 12.5。你填的是「${startText.trim()}」`,
    }
  }
  const parsedEnd = parseSeconds(endText)
  if (parsedEnd === null) {
    return {
      ok: false,
      error: `「止」得是一个数字（单位秒），比如 15.3。你填的是「${endText.trim()}」`,
    }
  }

  const startTime = roundMs(parsedStart)
  const endTime = roundMs(parsedEnd)

  if (startTime < 0) {
    return { ok: false, error: `起点不能早于 0 秒（你填的是 ${formatSeconds(startTime)} 秒）` }
  }
  if (endTime <= startTime) {
    return {
      ok: false,
      error:
        endTime === startTime
          ? `止点必须晚于起点：两格都填了 ${formatSeconds(startTime)} 秒，这一段长度是 0`
          : `止点必须晚于起点：填的是 ${formatSeconds(startTime)} → ${formatSeconds(endTime)} 秒，这一段是倒着的`,
    }
  }

  const prev = index > 0 ? segments[index - 1] : undefined
  if (prev && startTime < roundMs(prev.endTime)) {
    return {
      ok: false,
      error: `起点不能早于上一段的止点 ${formatSeconds(prev.endTime)} 秒：两段重叠时播放器只亮先命中的那段、配音铺轴也跟着错位。要挪到那儿，先把上一段改掉`,
    }
  }
  const next = index + 1 < segments.length ? segments[index + 1] : undefined
  if (next && endTime > roundMs(next.startTime)) {
    return {
      ok: false,
      error: `止点不能晚于下一段的起点 ${formatSeconds(next.startTime)} 秒：两段重叠时播放器只亮先命中的那段、配音铺轴也跟着错位。要挪到那儿，先把下一段改掉`,
    }
  }

  const changed = startTime !== roundMs(current.startTime) || endTime !== roundMs(current.endTime)
  const nextSegments = segments.map((seg, i) => (i === index ? { ...seg, startTime, endTime } : seg))
  return {
    ok: true,
    segments: nextSegments,
    changed,
    summary: `这一段现在是 ${formatSeconds(startTime)} → ${formatSeconds(endTime)} 秒`,
  }
}
