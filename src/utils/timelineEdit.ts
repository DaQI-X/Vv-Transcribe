/**
 * 字幕时间轴的编辑动作：整轴平移、单段改起止（#361 范围①②），拆段/合段/删段（#364）。
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
  const index = locate(segments, segmentId)
  if (index < 0) return NOT_FOUND
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

/**
 * 拆出来的后半段另起一个 id：沿用导入时 `${起}-${止}` 那个格式，再挂一个没人占的序号。
 * `#` 是引擎与参考稿那两侧都不会出现在时间串里的字符，查一遍现有 id 才敢用——
 * 两个同名 id 到 React 那里是「同一个 key」，界面会把其中一行的输入框挂到另一行上。
 */
function mintSplitId(
  start: number,
  end: number,
  segments: TranscriptionSegment[],
): string {
  const taken = new Set(segments.map((seg) => seg?.id))
  let suffix = 1
  while (taken.has(`${start}-${end}#${suffix}`)) suffix++
  return `${start}-${end}#${suffix}`
}

/** 按字码点数：`length` 会把一个 emoji 数成 2 字，摊时间时前半就多拿一份时长 */
function charCount(text: string): number {
  return [...text].length
}

function locate(segments: TranscriptionSegment[], segmentId: string): number {
  return segments.findIndex((seg) => seg?.id === segmentId)
}

/** 列表在编辑期间变了（校对回写、切了另一个文件）时都要给同一句话，别报 undefined */
const NOT_FOUND = { ok: false, error: '没找到这一段，列表可能已经变了；重新点一下那行再试' } as const

/**
 * 拆段：文字按 `cutChar`（这一行 textarea 的光标位）分开，时间按两半的字数分摊这一段的时长。
 *
 * 为什么时间不直接抄播放位置：那会让同一颗按钮按两次得两个结果，而播放头动没动过是看不出来的状态。
 * 「这段太长了，拆成两行」要的从来不是精确落点，是把时长摊匀；要按耳朵听到的那个点对齐，
 * 回执里那两段起止就是给它准备的——拆完在上一行用「改这一段的起止」点一次「取播放位置」。
 *
 * 这一刀只可能坏在自己之内：分摊出来的落点必然在 (起点, 止点) 里，所以不查相邻那两道。
 * 唯一的例外是这一段短到摊不出两个都满 1 毫秒的起止，那是真拆不出东西，得当场拒。
 * 文字两边一个字都不裁：整篇稿子＝segments.map(s => s.text).join('')，AI 校对把 join 出来的
 * 这篇发出去、再把结果按行贴回来（TranscriptEditor.tsx:288 与 textAlignment）。裁掉一个空格
 * 等于改了原文，贴回来就少一个字。
 */
export function splitSegment(
  segments: TranscriptionSegment[],
  segmentId: string,
  cutChar: number,
): TimelineEditResult {
  const index = locate(segments, segmentId)
  if (index < 0) return NOT_FOUND
  const current = segments[index]

  // 落在代理对中间会把一个字切成两半，两边各剩一个乱码字符（emoji 和生僻字都是两个字码）：
  // 往后挪一格，整个字留在前半
  const straddle =
    cutChar > 0 && cutChar < current.text.length && /[\uD800-\uDBFF]/.test(current.text[cutChar - 1])
  const cut = straddle ? cutChar + 1 : cutChar
  const head = current.text.slice(0, cut)
  const tail = current.text.slice(cut)
  if (!head.trim() || !tail.trim()) {
    return {
      ok: false,
      error: `文字切点得落在字与字之间：现在切出来${head.trim() ? '后半' : '前半'}是空的。把光标点到要分开的两个字中间，再右键这一行`,
    }
  }

  const start = roundMs(current.startTime)
  const end = roundMs(current.endTime)
  const headChars = charCount(head)
  const tailChars = charCount(tail)
  const splitAt = roundMs(start + ((end - start) * headChars) / (headChars + tailChars))
  if (splitAt <= start || splitAt >= end) {
    return {
      ok: false,
      error: `这一段只有 ${formatSeconds(start)}–${formatSeconds(end)} 秒，摊不出两半都落得住的起止。先把这一段的止点改晚一点（或起点改早一点）再拆`,
    }
  }

  const first: TranscriptionSegment = { ...current, endTime: splitAt, text: head }
  const second: TranscriptionSegment = {
    ...current,
    id: mintSplitId(splitAt, end, segments),
    startTime: splitAt,
    text: tail,
  }
  return {
    ok: true,
    segments: [...segments.slice(0, index), first, second, ...segments.slice(index + 1)],
    changed: true,
    summary: `拆成两段：${formatSeconds(start)}–${formatSeconds(splitAt)} 和 ${formatSeconds(splitAt)}–${formatSeconds(end)} 秒（按 ${headChars}/${tailChars} 字摊的时间；落点不对就改这两段的起止）`,
  }
}

/**
 * 合段：只跟**下一段**并——往前并的话，被吃掉的那一行 id 就没了，而界面里想改回去只需在上一行
 * 再点一次「与下一段合并」，方向唯一比两个方向各一套闸门好讲。
 *
 * 活下来的是当前这段的 id；文字按 join('') 那条规矩直接相接，不补空格也不裁空格：
 * 上一段末尾有没有标点、要不要断开，只有用户自己知道，这里不能替他造字。
 * 止点取下一段的止点，中间若原本有空档，并完就把那段空白也算进时长里——回执要点名。
 */
export function mergeSegment(
  segments: TranscriptionSegment[],
  segmentId: string,
): TimelineEditResult {
  const index = locate(segments, segmentId)
  if (index < 0) return NOT_FOUND
  const current = segments[index]
  const next = index + 1 < segments.length ? segments[index + 1] : undefined
  if (!next) {
    return {
      ok: false,
      error: '这已经是最后一行，下面没有可并的段。要并进来的是上面那条的话，去它那一行右键',
    }
  }

  const startTime = roundMs(current.startTime)
  const endTime = roundMs(next.endTime)
  const gap = roundMs(next.startTime) - roundMs(current.endTime)
  const merged: TranscriptionSegment = { ...current, endTime, text: current.text + next.text }
  return {
    ok: true,
    segments: [...segments.slice(0, index), merged, ...segments.slice(index + 2)],
    changed: true,
    summary: `并成一段：${formatSeconds(startTime)}–${formatSeconds(endTime)} 秒、${charCount(merged.text)} 字${
      gap > 0 ? `，中间 ${formatSeconds(current.endTime)}–${formatSeconds(next.startTime)} 秒原本是空档` : ''
    }`,
  }
}

/**
 * 删段：只删这一行，邻居不往前挪。
 *
 * 自动补位（把后面所有段一起往前拉）是另一种产品，它会把用户没打算动的行改掉；
 * 删完留下的空档由「轴偏移」那一格统一处理，那儿一次改完全部且不撞闸门。
 * 最后一段不叫删：删完这份稿子就是空的，导出、校对、配音三条路当场都没东西可走。
 */
export function deleteSegment(
  segments: TranscriptionSegment[],
  segmentId: string,
): TimelineEditResult {
  const index = locate(segments, segmentId)
  if (index < 0) return NOT_FOUND
  const remaining = segments.filter(Boolean).length - 1
  if (remaining < 1) {
    return {
      ok: false,
      error: '这是最后一段，删掉就没有字幕可导出、也没法撤销。要整份重来，用返回按钮回上传页',
    }
  }

  const prev = index > 0 ? segments[index - 1] : undefined
  const next = index + 1 < segments.length ? segments[index + 1] : undefined
  // 邻居原本贴着、删完就多出一个空档——这一句要让用户看见，否则他只知道行数少了
  let gapNote = ''
  if (prev && next) {
    const gap = roundMs(next.startTime) - roundMs(prev.endTime)
    if (gap > 0) gapNote = `；${formatSeconds(prev.endTime)}–${formatSeconds(next.startTime)} 秒现在是空档`
  }
  return {
    ok: true,
    segments: [...segments.slice(0, index), ...segments.slice(index + 1)],
    changed: true,
    summary: `删掉这一段，还剩 ${remaining} 段${gapNote}`,
  }
}
