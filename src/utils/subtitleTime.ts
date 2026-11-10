/**
 * 「字幕文件里写得出的那一份时间」只留一把尺（#356）。
 *
 * 为什么单独一层：导出器（`exportTranscript`）和校验器（`subtitleSpec`）以前各算各的毫秒，
 * 那 `vv check` 判的就是 1.9999 秒这一行、而盘上那个文件里写的是 1,999——「导出 → 解析 → 判定」
 * 和「直接判定」会给出两种结论，而这两条路必须同判（tests/subtitleSpec.test.ts 里那条一致守卫
 * 量的正是这件事）。把取整口径收在这里，两边吃同一个函数，就不存在「两套真相」。
 *
 * 取整是**向下**（不是四舍五入），而且沿用导出器一直以来的那份算式：一位小数都不往上进，
 * 否则界面上 1.9994 秒开始的那一段会被写成 00:00:02,000——比它真正开始得晚，字幕会比声音慢半拍。
 */

export interface SubtitleClock {
  hours: number
  minutes: number
  seconds: number
  millis: number
}

/** 拆成文件上那四个数：时 / 分 / 秒 / 毫秒（毫秒是 `Math.floor` 下来的，凑不满也不进位） */
export function toClock(totalSeconds: number): SubtitleClock {
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: Math.floor(totalSeconds % 60),
    millis: Math.floor((totalSeconds % 1) * 1000),
  }
}

/**
 * 折回成秒。写法和 `parseSubtitle` 那边逐字对齐（先加整数位、再加毫秒/1000），
 * 这样同一个时钟在两条路上必然落进同一个双精度数，而不是「差最后一位浮点」。
 */
export function fromClock(clock: SubtitleClock): number {
  return clock.hours * 3600 + clock.minutes * 60 + clock.seconds + clock.millis / 1000
}

/** 一个数落进「文件写得出来」那张格子之后的秒数 */
export function toWrittenSeconds(totalSeconds: number): number {
  return fromClock(toClock(totalSeconds))
}

function pad(value: number, width: number): string {
  return value.toString().padStart(width, '0')
}

/** SRT 的毫秒分隔符是逗号 */
export function formatSrtClock(totalSeconds: number): string {
  const c = toClock(totalSeconds)
  return `${pad(c.hours, 2)}:${pad(c.minutes, 2)}:${pad(c.seconds, 2)},${pad(c.millis, 3)}`
}

/** WebVTT 的毫秒分隔符是点——写成逗号会被当坏文件，所以这一句不能省 */
export function formatVttClock(totalSeconds: number): string {
  const c = toClock(totalSeconds)
  return `${pad(c.hours, 2)}:${pad(c.minutes, 2)}:${pad(c.seconds, 2)}.${pad(c.millis, 3)}`
}
