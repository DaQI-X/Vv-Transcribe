/**
 * SRT / WebVTT 的解析（#356）：留下时间轴，不吞重复行。
 *
 * 为什么不复用参考稿那条路上的 `extractSrtText`（electron/main/services/referenceParser.ts）：
 * 那一份的产物是「一篇拿来比对的纯文本」，它主动丢掉时间行，还用一把全局 `Set` 按整行去重——
 * 「好」这种重复两次的短台词会直接被吞掉一行。校验器要的正好相反：**每一条、每一个时间点都在**，
 * 少了行就算错。两件事共用一份解析器只会让其中一边说谎，所以这里另写。
 * （那一份的去重毛病同时是参考稿比对今天的一条既有缺陷，不在本条里顺手改——改它会动 diff 的对账行为。）
 *
 * 三条口径：
 * 1. 时间一律折成秒，并且走 `subtitleTime.fromClock`——和导出器写盘那一步同一个算法，
 *    「导出 → 解析」和「直接判定」才是同一把尺（tests/subtitleSpec.test.ts 有一条守卫钉住）。
 * 2. **不把坏块悄悄丢掉**：解析不出来的块进 `issues`，一块都不少。丢掉等于替文件遮掩。
 * 3. 毫秒按小数读（`1,5` 是 500 毫秒不是 5 毫秒），位数多于三位只取前三位——文件本来就写不出更低的位，
 *    多出来的位数由 L1 单独报，不在这里判死刑。
 */
import { fromClock, toClock, type SubtitleClock } from './subtitleTime'

export type SubtitleFormat = 'srt' | 'vtt'

/** 时间行上读出来的一个落点 */
export interface ParsedTime {
  /** 秒 */
  value: number
  /** 文件上写的那一串原文 */
  raw: string
  /** 小数点位置用的分隔符；没写小数位是 null */
  delimiter: ',' | '.' | null
  /** 小数位写了几位（SRT 认三位） */
  fractionDigits: number
}

export interface SubtitleCue {
  /** 第几条（从 1 起，按出现顺序数；和文件上写的序号是两件事） */
  index: number
  /** 文件上写的那个序号（SRT 块的第一行）；没写是 null */
  number: number | null
  start: ParsedTime
  end: ParsedTime
  /** 上屏的那些行，已摘掉 `<i>` 这类标记；一条都没有时是空数组 */
  lines: string[]
  /** 时间行原文，报错要把那一行念回给人看 */
  timing: string
  /** 时间行在文件里的行号（1 基）；指向它，因为那是这块最靠前的定位锚 */
  line: number
}

export interface ParseIssue {
  /** 文件里的行号（1 基）；认不出来是哪一行时是 null */
  line: number | null
  message: string
  /** 原文片段（截断），报错要点名文件里到底写了什么 */
  snippet: string
}

export interface ParseResult {
  format: SubtitleFormat
  cues: SubtitleCue[]
  issues: ParseIssue[]
}

/** 一行时间戳：可省小时，分隔符逗号/点都收（收下来才知道该不该报），后面可跟 VTT 的挂载设置 */
const TIMING_LINE =
  /^(\d{1,3}):([0-5]?\d):([0-5]?\d)(?:([.,])(\d*))?[ \t]*-->[ \t]*(\d{1,3}):([0-5]?\d):([0-5]?\d)(?:([.,])(\d*))?[ \t]*(.*)$/
/** VTT 的块可以是 NOTE / REGION / STYLE 这类说明块，它们不是字幕 */
const VTT_META = /^(NOTE|REGION|STYLE)\b/

function readTime(
  hours: string,
  minutes: string,
  seconds: string,
  delimiter: string | undefined,
  fraction: string | undefined,
  raw: string,
): ParsedTime {
  const digits = fraction ?? ''
  const clock: SubtitleClock = {
    hours: Number(hours),
    minutes: Number(minutes),
    seconds: Number(seconds),
    // 当小数读：`,5` 是半秒而不是 5 毫秒；位数不足右侧补零，超过三位只取前三位
    millis: Number((digits + '000').slice(0, 3)),
  }
  return {
    value: fromClock(clock),
    raw,
    delimiter: (delimiter as ',' | '.' | undefined) ?? null,
    fractionDigits: digits.length,
  }
}

/** 摘掉 SRT/VTT 的内联标记：`<i>词</i>` 上屏只有「词」那两个字 */
export function stripSubtitleMarkup(line: string): string {
  return line.replace(/<[^>]*>/g, '')
}

function snippet(line: string): string {
  const flat = line.trim()
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
}

/** 认文件是 SRT 还是 VTT：只看第一处非空内容，VTT 必须以 WEBVTT 开头（规范就这一条硬要求） */
export function detectFormat(text: string): SubtitleFormat {
  const first = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/).find((line) => line.trim() !== '') ?? ''
  return /^WEBVTT(\s|$)/.test(first.trim()) ? 'vtt' : 'srt'
}

export function parseSubtitle(text: string, format?: SubtitleFormat): ParseResult {
  const kind = format ?? detectFormat(text)
  const issues: ParseIssue[] = []
  const cues: SubtitleCue[] = []
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)

  // 按空行分块；同时记住每一块的第一行在文件里是第几行
  const blocks: { start: number; rows: { text: string; line: number }[] }[] = []
  let current: { start: number; rows: { text: string; line: number }[] } | null = null
  lines.forEach((row, i) => {
    const lineNo = i + 1
    if (row.trim() === '') {
      current = null
      return
    }
    if (!current) {
      current = { start: lineNo, rows: [] }
      blocks.push(current)
    }
    current.rows.push({ text: row, line: lineNo })
  })

  for (const block of blocks) {
    const rows = block.rows
    const head = rows[0]?.text.trim() ?? ''

    // VTT 的文件头那一块（WEBVTT + 可选的元数据）不是字幕
    if (kind === 'vtt' && /^WEBVTT(\s|$)/.test(head)) continue
    if (kind === 'vtt' && VTT_META.test(head)) continue

    // 一个块里可能有不止一个时间行：标准上那是「两块之间少了一个空行」，但照样每条都要认出来，
    // 一条都不能吞——吞了下一条，序号连续那条就会报出一个文件里根本不存在的错。
    const timingAt: number[] = []
    rows.forEach((row, i) => {
      if (TIMING_LINE.test(row.text.trim())) timingAt.push(i)
    })

    if (timingAt.length === 0) {
      issues.push({
        line: rows[0]?.line ?? null,
        message: '这一块里没有一行是时间戳（SRT 每一条都得有一行 `00:00:01,000 --> 00:00:03,000`）',
        snippet: snippet(head),
      })
      continue
    }
    if (timingAt[0]! > 1) {
      issues.push({
        line: rows[0]?.line ?? null,
        message: '时间行之前还有别的内容没被认出来（这里应该只有一个序号，或者什么都没有）',
        snippet: snippet(head),
      })
    }
    if (timingAt.length > 1) {
      issues.push({
        line: rows[timingAt[1]!]!.line,
        message: '这两条字幕之间缺一个空行，被当成同一块了（内容没有丢，但文件不合 SRT/VTT 的写法）',
        snippet: snippet(rows[timingAt[1]!]!.text),
      })
    }

    timingAt.forEach((at, n) => {
      const timingRow = rows[at]!
      const matched = TIMING_LINE.exec(timingRow.text.trim())!
      const numberRow = at > 0 && /^\d+$/.test(rows[at - 1]!.text.trim()) ? rows[at - 1]! : null
      // 下一条的字幕内容到哪里为止：撞上下一个时间行就停，而紧挨在它上面的那个纯数字是**下一条的序号**，
      // 不是这一条的最后一行台词（识别序号用的规矩两边一致，才不会一条数成两行、另一行数成零行）
      const nextAt = n + 1 < timingAt.length ? timingAt[n + 1]! : null
      const nextHasCounter =
        nextAt !== null && nextAt > 0 && /^\d+$/.test(rows[nextAt - 1]!.text.trim())
      const stopAt = nextAt === null ? rows.length : nextHasCounter ? nextAt - 1 : nextAt
      const [, sh, sm, ss, sd, sf, eh, em, es, ed, ef] = matched
      const timing = timingRow.text.trim()
      const cue: SubtitleCue = {
        index: cues.length + 1,
        number: numberRow ? Number(numberRow.text.trim()) : null,
        start: readTime(sh!, sm!, ss!, sd, sf, timing),
        end: readTime(eh!, em!, es!, ed, ef, timing),
        lines: [],
        timing,
        line: timingRow.line,
      }
      for (let i = at + 1; i < stopAt; i++) cue.lines.push(stripSubtitleMarkup(rows[i]!.text))
      const settings = matched[11]?.trim()
      // VTT 允许时间行后面挂 `line:90%` 这类位置设置；SRT 里出现这一串只可能是文件写坏了
      if (settings && kind === 'srt') {
        issues.push({
          line: timingRow.line,
          message: `SRT 的时间行后面多了「${settings}」（只有 VTT 才在那儿挂位置设置）`,
          snippet: timing,
        })
      }
      cues.push(cue)
    })
  }

  return { format: kind, cues, issues }
}

/**
 * 摘标记前先把「整行空白」的行滤掉，顺序不能反：解析器分块时也是**按原文**丢掉空行的
 * （`row.trim() === ''` 判在摘标记之前），所以 `<i></i>` 这种一行在两边都算一行。
 * 反过来的话台词里带一个结尾换行就会一边数 2 行、一边数 1 行，一致守卫白红。
 */
function linesLikeParser(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(stripSubtitleMarkup)
}

/**
 * 界面里那份 segments 走另一条路进到同一套判定里（#356 的一致守卫要用）。
 *
 * 每个时间点都先过一遍 `fromClock(toClock(...))`——也就是「导出成文件时会被写成什么」。不这么做的话，
 * 直接判定读的是 1.9994 而文件里写的是 1,999，两条路的结论就允许不一样，而那条守卫测就没内容了。
 *
 * 一个已知的边界：台词自己写成一行时间戳（或紧挨着下一条纯数字那行）时，走文件那一路会被解析器
 * 认成结构，两边必然不同——那是文件的歧义不是这里的 bug，守卫用例不用这种素材。
 */
export function cuesFromSegments(
  segments: { startTime: number; endTime: number; text: string }[],
  format: SubtitleFormat = 'srt',
): SubtitleCue[] {
  return segments.map((segment, i) => {
    const written = (seconds: number): ParsedTime => ({
      value: fromClock(toClock(seconds)),
      raw: '',
      delimiter: format === 'srt' ? ',' : '.',
      fractionDigits: 3,
    })
    return {
      index: i + 1,
      number: i + 1,
      start: written(segment.startTime),
      end: written(segment.endTime),
      lines: linesLikeParser(segment.text),
      timing: '',
      line: 0,
    }
  })
}
