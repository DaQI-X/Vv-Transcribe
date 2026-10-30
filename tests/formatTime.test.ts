/**
 * 时钟这一把尺（#287 派生，接 #282 的体积尺）。
 *
 * 改之前有三份逐字节相同的实现（AudioPlayer / VoiceStudio / SegmentRow），都只算到分钟、没有小时位：
 * 一档 61 分钟的节目在播放器、字幕行、配音结果卡上会写成 `61:23`。本仓其实早就认过这个坑——
 * Markdown 导出那条短时码自己补了小时位，只是没回头收这三处界面。所以用例分三层：换算钉形态；
 * 跨文件钉「界面和导出的 Markdown 是同一个读数」；判据按文件与代码行查「不再出现第二把尺」。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportTranscript } from '../src/utils/exportTranscript'
import { formatTime } from '../src/utils/formatTime'
import type { TranscriptionSegment } from '../src/types/transcription'

/** 只收 .ts/.tsx：非代码文件里出现「/ 60」不构成第二把尺，扫进去纯属噪音 */
async function collectCode(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await collectCode(path)))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path)
  }
  return out
}

/** 仓库相对路径，测试红了时读起来比绝对路径省事 */
function repoPath(file: string): string {
  return file.replace(`${process.cwd()}/`, '')
}

/** 去掉行注释与 JSDoc 正文，只留可能真的在跑的那几行 */
function codeLines(source: string): string[] {
  return source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
}

/** 找到 src+electron 里命中判式的文件 */
async function holdersOf(pattern: RegExp): Promise<string[]> {
  const hits: string[] = []
  for (const dir of ['src', 'electron']) {
    for (const file of await collectCode(join(process.cwd(), dir))) {
      if (codeLines(await readFile(file, 'utf-8')).some((line) => pattern.test(line))) {
        hits.push(repoPath(file))
      }
    }
  }
  return hits.sort()
}

function segment(overrides: Partial<TranscriptionSegment>): TranscriptionSegment {
  return {
    id: '1',
    startTime: 0,
    endTime: 0,
    text: '监管部门提醒投资者注意风险',
    isEdited: false,
    isCorrected: false,
    ...overrides,
  }
}

describe('formatTime：形态', () => {
  it('一小时以内是补零的 MM:SS', () => {
    expect(formatTime(0)).toBe('00:00')
    expect(formatTime(7)).toBe('00:07')
    expect(formatTime(58.31)).toBe('00:58')
    expect(formatTime(60)).toBe('01:00')
    expect(formatTime(305)).toBe('05:05')
    expect(formatTime(3599.99)).toBe('59:59')
  })

  /**
   * 这条是这次改动真正新增的行为：原先那三处界面尺会把 3725 秒念成 `62:05`。
   * 一档一小时的新闻节目是这个应用的目标素材，读数必须是人认得的 HH:MM:SS。
   */
  it('满一小时补小时位，不再写出 62:05 这种没人认的读数', () => {
    expect(formatTime(3600)).toBe('01:00:00')
    expect(formatTime(3725)).toBe('01:02:05')
    expect(formatTime(86399)).toBe('23:59:59')
    expect(formatTime(86400)).toBe('24:00:00')
    expect(formatTime(3661)).not.toBe('61:01')
  })

  /**
   * floor，不四舍五入：进度条正在走的读数和总时长并排出现时，`00:59` 与 `01:00` 差一秒会被读成
   * 「这两个数说的不是同一个东西」。代价是不足一秒的余量被抹掉——所以亚秒差不能套这把尺，
   * 见下面「亚秒差」那组。
   */
  it('一律 floor：59.7 秒是 00:59，不是 01:00', () => {
    expect(formatTime(59.7)).toBe('00:59')
    expect(formatTime(59.999)).toBe('00:59')
    expect(formatTime(3600 - 0.5)).toBe('59:59')
  })
})

describe('实测数：日志里那批 12 段确实读得出「差不到 1 秒」', () => {
  /**
   * 2026-10-30 21:10 那批（app.log 的 Voice track assembled）：trackDuration 58.31、originalEnd 58.42。
   * 两个数各自套这把尺都落进 00:58，差却是 0.11 秒——这正是 #287 报的现象：界面写成「差 00:00」
   * 看着像严丝合缝。所以这里钉两件事：两个读数相同（证明整秒尺给不出差），以及差值本身小于 1 秒
   * （证明「差不到 1 秒」那句话术不是在骗人）。
   */
  it('轨 58.31 与 原时间轴 58.42 同读 00:58，而它们差 0.11 秒', () => {
    expect(formatTime(58.31)).toBe('00:58')
    expect(formatTime(58.42)).toBe('00:58')
    expect(+(58.42 - 58.31).toFixed(2)).toBe(0.11)
    expect(Math.abs(58.31 - 58.42)).toBeLessThan(1)
  })

  /**
   * 接线判据：整秒尺 floor 得掉亚秒差，这个回归只活在界面文案里，单测抓不到渲染结果，
   * 所以直接钉那句活着的中文话术还在配音结果卡上。删掉它会让这条变红，逼着改的人回答为什么。
   */
  it('配音结果卡那条差仍走亚秒口径，没被整秒尺吞回去', async () => {
    const source = await readFile(
      join(process.cwd(), 'src/components/transcription/VoiceStudio.tsx'),
      'utf-8',
    )
    expect(source).toContain("'差不到 1 秒'")
    expect(source).toContain('formatDrift(track.duration - track.originalEnd)')
  })
})

describe('界面与导出同一个读数', () => {
  /**
   * Markdown 台词稿那行 `**[起 - 止]**` 以前由本文件另一套实现拼，用户拿它对着字幕行核落点。
   * 现在两侧走同一个函数，这条用例证明它俩不可能分叉，同时钉住满一小时的形态。
   */
  it('Markdown 导出的时间码等于界面读出来的那个字符串', () => {
    const md = exportTranscript(
      [segment({ startTime: 3725.7, endTime: 3731 })],
      'md',
    )
    expect(md).toContain(`**[${formatTime(3725.7)} - ${formatTime(3731)}]**`)
    expect(md).toContain('**[01:02:05 - 01:02:11]**')
  })

  /**
   * SRT/VTT 是交付文件，格式由规范说了算（毫秒用逗号分隔、VTT 用点），故意不走界面那把尺。
   * 这条钉住它没被顺手改成界面口径——真改了，剪辑软件会把文件当坏文件。
   */
  it('字幕文件的时间戳仍是规范格式，没跟界面口径混', () => {
    const srt = exportTranscript([segment({ startTime: 62.5, endTime: 70 })], 'srt')
    expect(srt).toContain('00:01:02,500 --> 00:01:10,000')
    const vtt = exportTranscript([segment({ startTime: 62.5, endTime: 70 })], 'vtt')
    expect(vtt).toContain('00:01:02.500 --> 00:01:10.000')
  })
})

describe('判据：时钟只剩一把尺', () => {
  /**
   * 补零到两位是「自己拼时钟」的指纹。今天允许的两处：
   * - `src/utils/formatTime.ts`：那把尺本身。
   * - `src/utils/exportTranscript.ts`：SRT/VTT 的字幕时间戳，是文件格式不是界面读数，
   *   收进界面尺等于改一次显示口径就写坏一份交付文件。
   * 出现第三个文件时得先回答：这是界面读数（改用那把尺），还是别的格式（在这里写清为什么留）。
   */
  it('自己补两位拼时钟的文件只有这两个', async () => {
    expect(await holdersOf(/padStart\(2/)).toEqual([
      'src/utils/exportTranscript.ts',
      'src/utils/formatTime.ts',
    ])
  })

  /**
   * 第二条指纹量换算本身（`Math.floor(... / 60)` 把秒折成分），防的是「不补零但自己算分钟」这种
   * 写法——上面那条抓不到它。播放器里 `(i / 60) * duration` 那行数的是 60 根波形柱的序号、
   * 不折时间，所以判式要求同一行出现 floor：这是刻意的，不是漏收。
   */
  it('把秒折成分的地方也只有这两个', async () => {
    expect(await holdersOf(/Math\.floor\(.*\/\s*60\)/)).toEqual([
      'src/utils/exportTranscript.ts',
      'src/utils/formatTime.ts',
    ])
  })
})
