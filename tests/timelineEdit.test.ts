/**
 * 字幕时间轴编辑（#361）。
 *
 * 这一层的价值全在「拒掉」那半边：接受改动的路径谁都写得出来，重叠和倒序的轴才是会把
 * 配音铺轴与播放器高亮一起带跑的东西，所以每条拒绝都要有名字、有数字、有出路。
 * 用例分四组：整轴平移、单段起止、读数范围、以及改完轴的**下游**（导出的 SRT 与浮点尾巴）。
 */
import { describe, expect, it } from 'vitest'
import { exportTranscript } from '../src/utils/exportTranscript'
import { editSegmentTimes, shiftTimeline, timelineSpan, type TimelineEditResult } from '../src/utils/timelineEdit'
import type { TranscriptionSegment } from '../src/types/transcription'

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

/** 三段连续轴：0-10 / 10-20 / 20-30，相邻刚好贴着不重叠 */
function threeSegments(): TranscriptionSegment[] {
  return [
    segment({ id: 'a', startTime: 0, endTime: 10 }),
    segment({ id: 'b', startTime: 10, endTime: 20 }),
    segment({ id: 'c', startTime: 20, endTime: 30 }),
  ]
}

/** 只把通过的结果取出来，红的时候比较对象少一层噪音 */
function applied(result: TimelineEditResult): TranscriptionSegment[] {
  if (!result.ok) throw new Error(`这次编辑本该通过，却拒了：${result.error}`)
  return result.segments
}

function summary(result: TimelineEditResult): string {
  if (!result.ok) throw new Error(`这次编辑本该通过，却拒了：${result.error}`)
  return result.summary
}

describe('整轴平移：shiftTimeline', () => {
  it('填 0.2 就是每一段的起止都加 0.2 秒', () => {
    const next = applied(shiftTimeline(threeSegments(), '0.2'))
    expect(next.map((s) => [s.startTime, s.endTime])).toEqual([
      [0.2, 10.2],
      [10.2, 20.2],
      [20.2, 30.2],
    ])
  })

  it('段与段之间的距离一个都没变——这就是它不用查相邻的原因', () => {
    const next = applied(shiftTimeline(threeSegments(), '3.75'))
    const gaps = next.slice(1).map((s, i) => +(s.startTime - next[i].endTime).toFixed(6))
    expect(gaps).toEqual([0, 0])
  })

  it('往前挪到刚好 0 是允许的，再往前一名就拒并说出上限', () => {
    const segments = [segment({ id: 'a', startTime: 5.5, endTime: 12 }), segment({ id: 'b', startTime: 12, endTime: 20 })]
    expect(shiftTimeline(segments, '-5.5').ok).toBe(true)
    const blocked = shiftTimeline(segments, '-5.6')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error).toContain('最多只能往前 5.5 秒')
  })

  it('偏移量是 0 不算成功：那是用户以为自己改了', () => {
    const result = shiftTimeline(threeSegments(), '0')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('填负数')
  })

  /** 裸 Number() 会把这四种都读成「有个数」，其中空串读成 0——那是把整轴拉回 0 点 */
  it('空串、1e3、0x10、abc 一律不当数字用', () => {
    for (const text of ['', '   ', '1e3', '0x10', 'abc', '1.2.3', '12秒']) {
      expect(shiftTimeline(threeSegments(), text).ok).toBe(false)
    }
  })

  it('没有字幕时给一句人话，不报 undefined 秒', () => {
    const result = shiftTimeline([], '0.2')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('还没有字幕，时间轴没东西可移')
  })

  it('成功那行说的是这次的量与新的两头', () => {
    expect(summary(shiftTimeline(threeSegments(), '5'))).toBe('3 段整体往后 5 秒，轴现在是 5–35 秒')

    const late = [
      segment({ id: 'a', startTime: 8, endTime: 15 }),
      segment({ id: 'b', startTime: 15, endTime: 22 }),
    ]
    expect(summary(shiftTimeline(late, '-3'))).toBe('2 段整体往前 3 秒，轴现在是 5–19 秒')
  })

  /**
   * 两头报「秒」而不是时钟：挪 0.5 秒时界面那格的读数一位都不动（formatTime 取整秒），
   * 回一句「现在从 00:00 到 00:30」听起来就像什么都没发生——#287 在配音结果卡上踩过同一坑。
   */
  it('挪不到 1 秒时，成功那行也得报得出动了', () => {
    expect(summary(shiftTimeline(threeSegments(), '0.5'))).toBe('3 段整体往后 0.5 秒，轴现在是 0.5–30.5 秒')
  })
})

describe('单段起止：editSegmentTimes', () => {
  it('改中间那段只动它自己，id 与别的段都原样', () => {
    const next = applied(editSegmentTimes(threeSegments(), 'b', '10', '18.5'))
    expect(next[1]).toMatchObject({ id: 'b', startTime: 10, endTime: 18.5 })
    expect(next[0]).toMatchObject({ id: 'a', startTime: 0, endTime: 10 })
    expect(next[2]).toMatchObject({ id: 'c', startTime: 20, endTime: 30 })
  })

  it('成功那行把这两个数原样念回去（秒，不是时钟）', () => {
    expect(summary(editSegmentTimes(threeSegments(), 'b', '10.25', '18.5'))).toBe(
      '这一段现在是 10.25 → 18.5 秒',
    )
  })

  it('填的就是现在这两个数时 changed 是 false，界面据此不弹提示', () => {
    const result = editSegmentTimes(threeSegments(), 'b', '10', '20')
    expect(result.ok && result.changed).toBe(false)
  })

  it('起点填负数拒', () => {
    const result = editSegmentTimes(threeSegments(), 'b', '-1', '18')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('起点不能早于 0 秒')
  })

  it('止点等于起点是 0 长度、小于起点是倒着，两种都拒且各说各的', () => {
    const zero = editSegmentTimes(threeSegments(), 'b', '10', '10')
    const reversed = editSegmentTimes(threeSegments(), 'b', '10', '9')
    expect(!zero.ok && zero.error).toContain('这一段长度是 0')
    expect(!reversed.ok && reversed.error).toContain('这一段是倒着的')
  })

  /** 这两条是本层存在的理由：重叠不会被修好，只会被 find 第一个命中悄悄吞掉 */
  it('起点早于上一段止点就拒，并点名要改的是上一段', () => {
    const result = editSegmentTimes(threeSegments(), 'b', '9.5', '18')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('上一段的止点 10 秒')
      expect(result.error).toContain('先把上一段改掉')
    }
  })

  it('止点晚于下一段起点就拒，并点名要改的是下一段', () => {
    const result = editSegmentTimes(threeSegments(), 'b', '10', '20.5')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('下一段的起点 20 秒')
  })

  it('贴着邻居是允许的：等于上一段止点、等于下一段起点都过', () => {
    expect(editSegmentTimes(threeSegments(), 'b', '10', '20').ok).toBe(true)
  })

  it('第一段没有上邻、最后一段没有下邻，只剩 0 和正长度这两道', () => {
    expect(editSegmentTimes(threeSegments(), 'a', '0', '0.5').ok).toBe(true)
    expect(editSegmentTimes(threeSegments(), 'c', '20', '300').ok).toBe(true)
  })

  it('id 对不上时不假装改好了', () => {
    const result = editSegmentTimes(threeSegments(), 'zzz', '1', '2')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('没找到这一段')
  })

  it('任何一格填非数字都拒，不拿 0 去顶替', () => {
    expect(editSegmentTimes(threeSegments(), 'b', '', '18').ok).toBe(false)
    expect(editSegmentTimes(threeSegments(), 'b', '12', '十五').ok).toBe(false)
  })
})

describe('读数范围：timelineSpan', () => {
  it('空稿给 null，界面无话可说而不是 0 到 0', () => {
    expect(timelineSpan([])).toBeNull()
  })

  it('取的是最早起点与最晚止点，跟数组里排在第几没关系', () => {
    const segments = [
      segment({ id: 'a', startTime: 20, endTime: 30 }),
      segment({ id: 'b', startTime: 0, endTime: 10 }),
    ]
    expect(timelineSpan(segments)).toEqual({ start: 0, end: 30 })
  })
})

describe('改完轴的下游', () => {
  it('整轴平移后导出 SRT，每行时间码就是挪过的那两个数', () => {
    const srt = exportTranscript(applied(shiftTimeline(threeSegments(), '0.5')), 'srt')
    expect(srt).toContain('00:00:00,500 --> 00:00:10,500')
    expect(srt).toContain('00:00:20,500 --> 00:00:30,500')
  })

  it('单段改止点后导出 SRT，只有那一行跟着变', () => {
    const srt = exportTranscript(applied(editSegmentTimes(threeSegments(), 'b', '10', '19.25')), 'srt')
    expect(srt).toContain('00:00:10,000 --> 00:00:19,250')
    expect(srt).toContain('00:00:20,000 --> 00:00:30,000')
  })

  /**
   * 反复 ±0.1 是最真实的用法（挪一点、听一下、收一点）。不取整到毫秒的话，
   * 十轮之后第一段起点会是 1.1102230246251565e-16 这种数，导出去就写进交付文件了。
   */
  it('来回挪十次，落点还是干净的毫秒整数', () => {
    let segments = threeSegments()
    for (let i = 0; i < 10; i++) {
      segments = applied(shiftTimeline(segments, '0.1'))
      segments = applied(shiftTimeline(segments, '-0.1'))
    }
    expect(segments[0]).toMatchObject({ startTime: 0, endTime: 10 })
  })
})
