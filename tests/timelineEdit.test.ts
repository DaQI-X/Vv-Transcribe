/**
 * 字幕时间轴编辑（#361 平移/单段起止，#364 拆/并/删）。
 *
 * 这一层的价值全在「拒掉」那半边：接受改动的路径谁都写得出来，重叠和倒序的轴才是会把
 * 配音铺轴与播放器高亮一起带跑的东西，所以每条拒绝都要有名字、有数字、有出路。
 * 用例分组：整轴平移、单段起止、拆段、合段、删段、读数范围，以及改完轴的**下游**
 * （导出的 SRT、浮点尾巴，还有拆/并/删之后「数组序＝时间序、相邻不重叠」这条前提还在不在）。
 */
import { describe, expect, it } from 'vitest'
import { exportTranscript } from '../src/utils/exportTranscript'
import {
  deleteSegment,
  editSegmentTimes,
  mergeSegment,
  shiftTimeline,
  splitSegment,
  timelineSpan,
  type TimelineEditResult,
} from '../src/utils/timelineEdit'
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

/** b 那行是「监管部门提醒投资者注意风险」（13 字），光标放在第 6 个字后面：前半 6 字、后半 7 字 */
const CUT = 6

describe('拆段：splitSegment', () => {
  it('文字按光标分开、时间按两半的字数摊开，别的行一个字都不动', () => {
    const next = applied(splitSegment(threeSegments(), 'b', CUT))
    expect(next.map((s) => [s.startTime, s.endTime])).toEqual([
      [0, 10],
      [10, 14.615],
      [14.615, 20],
      [20, 30],
    ])
    expect(next.map((s) => s.text)).toEqual([
      '监管部门提醒投资者注意风险',
      '监管部门提醒',
      '投资者注意风险',
      '监管部门提醒投资者注意风险',
    ])
  })

  /** 整篇稿子＝各行 join('')，AI 校对把这一篇发出去再按行贴回来：拆这一刀不能增减一个字 */
  it('拆完 join 起来跟拆之前一模一样，空格也不裁', () => {
    const segments = [segment({ id: 'a', startTime: 0, endTime: 10, text: '监管部门 提醒投资者' })]
    const before = segments.map((s) => s.text).join('')
    const next = applied(splitSegment(segments, 'a', 5))
    expect(next.map((s) => s.text).join('')).toBe(before)
    expect(next[0].text).toBe('监管部门 ')
  })

  /** 摊比例用的是码点数：`length` 会把一个 emoji 数成 2 字，前半就多拿一份时长 */
  it('摊时间按字数、不按 UTF-16 长度', () => {
    const segments = [segment({ id: 'a', startTime: 0, endTime: 10, text: '🎧🎧🎧🎧🎧🎧🎧' })]
    // 光标位是按 UTF-16 码元报的（textarea 的 selectionStart 就是这个口径），8 码元＝第 4 个字后面
    const next = applied(splitSegment(segments, 'a', 8))
    expect(next.map((s) => s.text)).toEqual(['🎧🎧🎧🎧', '🎧🎧🎧'])
    expect(next.map((s) => [s.startTime, s.endTime])).toEqual([
      [0, 5.714],
      [5.714, 10],
    ])
  })

  it('前半沿用原来的 id，后半另起一个不撞车的 id', () => {
    const next = applied(splitSegment(threeSegments(), 'b', CUT))
    expect(next[1].id).toBe('b')
    expect(next[2].id).toBe('14.615-20#1')
    expect(new Set(next.map((s) => s.id)).size).toBe(4)

    // 同一刀拆两次（挪回原位再拆）会算出同一个落点，撞上已经存在的 id，序号往上找一个没人占的
    const crowded = [segment({ id: '14.615-20#1', startTime: 10, endTime: 20 })]
    expect(applied(splitSegment(crowded, '14.615-20#1', CUT))[1].id).toBe('14.615-20#2')
  })

  it('光标在开头或末尾时拒，并说清是哪一半空了', () => {
    const head = splitSegment(threeSegments(), 'b', 0)
    const tail = splitSegment(threeSegments(), 'b', 13)
    expect(!head.ok && head.error).toContain('前半是空的')
    expect(!tail.ok && tail.error).toContain('后半是空的')
  })

  it('只有空格的半边也算空：拆出来是一行看不见的字幕', () => {
    const segments = [segment({ id: 'a', startTime: 0, endTime: 10, text: '监管部门　　' })]
    const result = splitSegment(segments, 'a', 4)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('后半是空的')
  })

  /** emoji 与生僻字占两个字码，正好切在中间会造出两个乱码字符 */
  it('光标落在代理对中间时往后挪一格，字不切坏', () => {
    const segments = [segment({ id: 'a', startTime: 0, endTime: 10, text: '前面🎧后面' })]
    const next = applied(splitSegment(segments, 'a', 3))
    expect(next.map((s) => s.text)).toEqual(['前面🎧', '后面'])
  })

  /** 摊到亚毫秒就被 roundMs 收回原处：这一刀落不进轴里，硬拆会写出 10–10 的零长段 */
  it('短到摊不出两半的起止时拒，并说要改哪一格', () => {
    const result = splitSegment([segment({ id: 'a', startTime: 10, endTime: 10.001 })], 'a', CUT)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('摊不出两半都落得住的起止')
      expect(result.error).toContain('10–10.001')
    }
  })

  it('id 对不上时不假装拆好了', () => {
    const result = splitSegment(threeSegments(), 'zzz', CUT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('没找到这一段')
  })

  it('成功那行把两段的时间与摊法念回去', () => {
    expect(summary(splitSegment(threeSegments(), 'b', CUT))).toBe(
      '拆成两段：10–14.615 和 14.615–20 秒（按 6/7 字摊的时间；落点不对就改这两段的起止）',
    )
  })
})

describe('合段：mergeSegment', () => {
  it('只跟下一段并：文字相接、时间取两头、留下自己的 id', () => {
    const next = applied(mergeSegment(threeSegments(), 'b'))
    expect(next).toHaveLength(2)
    expect(next[0]).toMatchObject({ id: 'a', startTime: 0, endTime: 10 })
    expect(next[1]).toMatchObject({ id: 'b', startTime: 10, endTime: 30 })
    expect(next[1].text).toBe('监管部门提醒投资者注意风险监管部门提醒投资者注意风险')
  })

  it('并完 join 起来还是一个字不多一个字少——不替用户补标点也不裁空格', () => {
    const segments = [
      segment({ id: 'a', startTime: 0, endTime: 10, text: '第一句没有标点' }),
      segment({ id: 'b', startTime: 10, endTime: 20, text: ' 接着第二句' }),
    ]
    expect(applied(mergeSegment(segments, 'a'))[0].text).toBe('第一句没有标点 接着第二句')
  })

  it('最后一段没有下一段，拒并把方向说回来', () => {
    const result = mergeSegment(threeSegments(), 'c')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('最后一行')
  })

  it('中间本来有空档时并进来的是连空白一起，回执要点名', () => {
    const segments = [
      segment({ id: 'a', startTime: 0, endTime: 10 }),
      segment({ id: 'b', startTime: 14, endTime: 20 }),
    ]
    expect(summary(mergeSegment(segments, 'a'))).toContain('10–14 秒原本是空档')
  })

  it('贴着邻居时那句空档不出现', () => {
    expect(summary(mergeSegment(threeSegments(), 'b'))).toBe('并成一段：10–30 秒、26 字')
  })

  it('id 对不上时不假装并好了', () => {
    const result = mergeSegment(threeSegments(), 'zzz')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('没找到这一段')
  })
})

describe('删段：deleteSegment', () => {
  it('删中间那行，邻居一个数都不挪——不自动补位', () => {
    const next = applied(deleteSegment(threeSegments(), 'b'))
    expect(next.map((s) => s.id)).toEqual(['a', 'c'])
    expect(next.map((s) => [s.startTime, s.endTime])).toEqual([
      [0, 10],
      [20, 30],
    ])
  })

  it('删第一行和删最后一行都算删，剩下的还是按时间排', () => {
    expect(applied(deleteSegment(threeSegments(), 'a')).map((s) => s.id)).toEqual(['b', 'c'])
    expect(applied(deleteSegment(threeSegments(), 'c')).map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('只剩一段时拒，不交出一份空稿子', () => {
    const result = deleteSegment([segment({ id: 'a', startTime: 0, endTime: 10 })], 'a')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('这是最后一段')
  })

  it('删完露出的空档在回执里点名', () => {
    const segments = [
      segment({ id: 'a', startTime: 0, endTime: 10 }),
      segment({ id: 'b', startTime: 14, endTime: 20 }),
      segment({ id: 'c', startTime: 20, endTime: 30 }),
    ]
    expect(summary(deleteSegment(segments, 'b'))).toBe('删掉这一段，还剩 2 段；10–20 秒现在是空档')
  })

  /** 删中间一行必然在前后之间开一个口子（那行原本占着这些秒），只有删头尾不会 */
  it('删第一行或最后一行时不说空档', () => {
    expect(summary(deleteSegment(threeSegments(), 'a'))).toBe('删掉这一段，还剩 2 段')
    expect(summary(deleteSegment(threeSegments(), 'c'))).toBe('删掉这一段，还剩 2 段')
  })

  it('id 对不上时不假装删掉了', () => {
    const result = deleteSegment(threeSegments(), 'zzz')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('没找到这一段')
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

  /**
   * 播放器（find 第一个命中）、配音铺轴（把数组序当时间序）、导出这三处都不重排，
   * 所以拆/并/删之后「数组序＝时间序、相邻不重叠」必须仍然成立——这一条红了，
   * 症状是配音轨越到后面差越多，而不是这一行显示不对。
   */
  it('拆、并、删之后数组还是按时间排且不相隔重叠', () => {
    const ops = [
      applied(splitSegment(threeSegments(), 'b', CUT)),
      applied(mergeSegment(threeSegments(), 'b')),
      applied(deleteSegment(threeSegments(), 'b')),
    ]
    for (const segments of ops) {
      for (let i = 1; i < segments.length; i++) {
        expect(segments[i - 1].endTime).toBeLessThanOrEqual(segments[i].startTime)
        expect(segments[i].startTime).toBeLessThan(segments[i].endTime)
      }
    }
  })

  /** 拆出来的落点是摊出来的小数（14.615），SRT 那一行必须把毫秒位写全，不能四舍五入成 14,000 */
  it('拆完导出 SRT：多出来的一行插在中间，序号跟着重排', () => {
    const srt = exportTranscript(applied(splitSegment(threeSegments(), 'b', CUT)), 'srt')
    expect(srt).toContain('00:00:10,000 --> 00:00:14,615')
    expect(srt).toContain('00:00:14,615 --> 00:00:20,000')
    expect(srt.match(/^\d+$/gm)).toEqual(['1', '2', '3', '4'])
  })

  it('并完导出 SRT：那一行只剩一条，时间取两头', () => {
    const srt = exportTranscript(applied(mergeSegment(threeSegments(), 'b')), 'srt')
    expect(srt).toContain('00:00:10,000 --> 00:00:30,000')
    expect(srt.match(/^\d+$/gm)).toEqual(['1', '2'])
  })

  it('删掉一段后导出 SRT，剩下的行号还是连续的', () => {
    const srt = exportTranscript(applied(deleteSegment(threeSegments(), 'b')), 'srt')
    expect(srt).not.toContain('00:00:10,000 --> 00:00:20,000')
    expect(srt.match(/^\d+$/gm)).toEqual(['1', '2'])
  })
})
