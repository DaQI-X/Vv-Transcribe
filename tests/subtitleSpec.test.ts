/**
 * 字幕校验器（#356）：L1 结构 + L2 排版 + 那份「两边必须一模一样」的守卫。
 *
 * 用例按三条纪律分组：
 * 1. **出处不许被省略**——三档内置 preset 每条规则都得有 cite 与 source，报错文本必须印出来，
 *    而且不许出现「不合规」「违规」那种把二手转述说成官方红线的措辞。
 * 2. **L1 只把「真会丢字幕」的报红**——写法不标准但照样上屏的是 warn，退出码不拦路。
 * 3. **界面与 CLI 是同一把尺**——同一份 segments 走「导出 → 解析 → 判定」与「直接判定」结论必须一字不差；
 *    这条守卫同时是 exportTranscript 与 subtitleParse 那份对齐的回归测试，所以素材特意选了
 *    亚秒落点、多行台词与 `<i>` 标记这三样最容易走偏的东西。
 */
import { describe, expect, it } from 'vitest'
import { exportTranscript } from '../src/utils/exportTranscript'
import type { TranscriptionSegment } from '../src/types/transcription'
import {
  BUILTIN_PRESET_IDS,
  DEFAULT_PRESET_ID,
  RULE_IDS,
  SCOPE_NOTE,
  builtinPreset,
  checkSegments,
  checkSubtitleText,
  renderReport,
  validatePreset,
  type CheckReport,
  type SubtitlePreset,
} from '../src/utils/subtitleSpec'

function preset(id: string): SubtitlePreset {
  const loaded = builtinPreset(id)
  if (!loaded.ok) throw new Error(`内置档位 ${id} 本该能装载：${loaded.errors.join('；')}`)
  return loaded.preset
}

/** 手写 SRT：每条给「时间行 + 台词」，序号按出现顺序自动补 */
function srt(...blocks: [string, string][]): string {
  return blocks.map(([timing, text], i) => `${i + 1}\n${timing}\n${text}\n`).join('\n')
}

/** 一份干净稿子：单行、不超 15 字、停留 2 秒、约 5 字每秒，相邻贴着但不重叠 */
const CLEAN = srt(
  ['00:00:01,000 --> 00:00:03,000', '监管部门提醒风险'],
  ['00:00:03,000 --> 00:00:05,000', '投资者注意甄别'],
)

/**
 * 一致守卫与措辞纪律共用的那份越线素材：亚秒落点（6.0004 秒导出时落成 `6,000`，那段于是从
 * 2.9996 秒变成 3.000 秒）、跨行台词、`<i>` 内联标记，以及一条明显超线的长台词——
 * 两条路只要有任何一处口径不一致，这里就红。
 */
const MESSY = (() => {
  const phrase = '监管部门提醒投资者注意风险甄别'
  const rows: [number, number, string][] = [
    [1.9994, 3, `<i>监管部门</i>${phrase.slice(4)}`],
    [3, 6, '第一行台词\n第二行台词\n第三行台词'],
    [6.0004, 9, `${phrase}${phrase}${phrase.slice(0, 8)}`],
    [9, 9.5, '半秒就下屏'],
  ]
  return rows.map(([startTime, endTime, text], i): TranscriptionSegment => ({
    id: `${i + 1}`,
    startTime,
    endTime,
    text,
    isEdited: false,
    isCorrected: false,
  }))
})()

/** 取内置那份再动指定的键：走的正是 `--preset` 那条装载校验，自制档位不许绕过它 */
function tweaked(id: string, mutate: (rules: SubtitlePreset['rules']) => void): SubtitlePreset {
  const copy = structuredClone(preset(id))
  mutate(copy.rules)
  const loaded = validatePreset(copy, '测试里的自制档位')
  if (!loaded.ok) throw new Error(`这份自制档位本该能装载：${loaded.errors.join('；')}`)
  return loaded.preset
}

function errorsOf(report: CheckReport): string[] {
  return report.findings.filter((finding) => finding.level === 'error').map((finding) => finding.message)
}

function allMessages(report: CheckReport): string {
  return report.findings.map((finding) => finding.message).join('；')
}

describe('内置三档与它们的出处', () => {
  it('三档都能装载，六条规则齐全且每条都写了 cite 与 source', () => {
    expect(BUILTIN_PRESET_IDS).toEqual(['vv-default', 'broadcast-cn', 'netflix-cjk'])
    for (const id of BUILTIN_PRESET_IDS) {
      const loaded = builtinPreset(id)
      expect(loaded.ok, `${id} 装载失败：${loaded.ok ? '' : loaded.errors.join('；')}`).toBe(true)
      if (!loaded.ok) continue
      for (const ruleId of RULE_IDS) {
        const spec = loaded.preset.rules[ruleId]
        expect(spec.cite.length, `${id}.${ruleId} 的 cite 是空的`).toBeGreaterThan(0)
        expect(spec.source.length, `${id}.${ruleId} 的 source 是空的`).toBeGreaterThan(0)
      }
    }
  })

  it('vv-default 的 L2 全是 info：初稿不拦路，只出一条汇总', () => {
    // 一条台词四十来字是转写初稿的常态，拿交付档判它必然满屏红，那会让「先出一版稿子」当场卡死
    const messy = srt(['00:00:01,000 --> 00:00:02,000', '这一句是初稿里很常见的那种长台词长得没有边际'])
    const report = checkSubtitleText(messy, { preset: preset(DEFAULT_PRESET_ID) })
    expect(report.exitCode).toBe(0)
    expect(report.summary.error).toBe(0)
    const layout = report.findings.filter((finding) => finding.layer === 'L2')
    expect(layout.length).toBeGreaterThan(0)
    for (const finding of layout) {
      expect(finding.level).toBe('info')
      expect(finding.message).toContain('越线')
    }
    // 一条规则最多一条汇总：info 的作用是报数，不是逐条刷屏
    const rules = layout.map((finding) => finding.rule)
    expect(new Set(rules).size).toBe(rules.length)
  })

  it('同一份素材换 broadcast-cn 就逐条报红，退出码 1', () => {
    const messy = srt(['00:00:01,000 --> 00:00:02,000', '这一句是初稿里很常见的那种长台词长得没有边际'])
    const report = checkSubtitleText(messy, { preset: preset('broadcast-cn') })
    expect(report.exitCode).toBe(1)
    expect(report.summary.error).toBeGreaterThan(0)
    for (const finding of report.findings.filter((f) => f.layer === 'L2')) expect(finding.level).toBe('error')
  })

  it('三档都默认关掉相邻间隙，并把为什么关掉写进报告', () => {
    for (const id of BUILTIN_PRESET_IDS) {
      const report = checkSubtitleText(CLEAN, { preset: preset(id) })
      const skipped = report.skipped.find((item) => item.rule === 'minGap')
      expect(skipped, `${id} 没列出 minGap 的关闭理由`).toBeDefined()
      expect(skipped!.reason).toContain('不保证留了间隙')
    }
  })
})

describe('档位装载校验：手改那份 JSON 不许绕过纪律', () => {
  const base = () => structuredClone(preset('broadcast-cn'))

  it('少写一条规则就报错，并点名缺哪条', () => {
    const raw = base()
    delete (raw.rules as Record<string, unknown>).readingSpeed
    const loaded = validatePreset(raw, '我的档位.json')
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.errors.join('；')).toContain('少了「readingSpeed」')
    expect(loaded.errors.join('；')).toContain('别整条删掉')
  })

  it('写了本应用不判的规则名也报错', () => {
    const raw = base()
    ;(raw.rules as Record<string, unknown>).lineLength = { max: 40, level: 'error', cite: 'x', source: 'y' }
    const loaded = validatePreset(raw, '我的档位.json')
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.errors.join('；')).toContain('lineLength')
  })

  it('缺 cite 或缺 source 都不许装载：出处是纪律，不是可选项', () => {
    for (const key of ['cite', 'source'] as const) {
      const raw = base()
      delete (raw.rules.charsPerLine as unknown as Record<string, unknown>)[key]
      const loaded = validatePreset(raw, '我的档位.json')
      expect(loaded.ok, `少了 ${key} 居然装载成功了`).toBe(false)
      if (loaded.ok) return
      expect(loaded.errors.join('；')).toContain(key)
    }
  })

  it('level 写错、数字写成文字、键名拼错，都要点名', () => {
    const wrongLevel = base()
    wrongLevel.rules.charsPerLine.level = 'fatal' as never
    expect(validatePreset(wrongLevel, 'x.json').ok).toBe(false)

    const stringNumber = base()
    ;(stringNumber.rules.charsPerLine as unknown as Record<string, unknown>).max = '15'
    const numberLoaded = validatePreset(stringNumber, 'x.json')
    expect(numberLoaded.ok).toBe(false)
    if (numberLoaded.ok) return
    expect(numberLoaded.errors.join('；')).toContain('要是一个数')

    const typo = base()
    ;(typo.rules.charsPerLine as unknown as Record<string, unknown>).maxChars = 15
    const typoLoaded = validatePreset(typo, 'x.json')
    expect(typoLoaded.ok).toBe(false)
    if (typoLoaded.ok) return
    expect(typoLoaded.errors.join('；')).toContain('不认识的键')
  })

  it('内置名字写错时，报错给出有哪三档以及怎么写路径', () => {
    const loaded = builtinPreset('broadcost-cn')
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.errors.join('；')).toContain('--preset ./')
    expect(loaded.errors.join('；')).toContain('broadcast-cn')
  })
})

describe('L1 结构层：只有真会丢字幕的才报红', () => {
  it('自家导出的那份干净稿子一条 L1 都不报', () => {
    const report = checkSubtitleText(CLEAN, { preset: preset('broadcast-cn') })
    expect(report.cueCount).toBe(2)
    expect(report.findings.filter((finding) => finding.layer === 'L1')).toEqual([])
  })

  it('序号不连续与缺序号都只警告：它们不影响上屏', () => {
    const jumped = checkSubtitleText(
      '1\n00:00:01,000 --> 00:00:03,000\n第一句\n\n7\n00:00:03,000 --> 00:00:05,000\n第二句\n',
      { preset: preset(DEFAULT_PRESET_ID) },
    )
    expect(jumped.cueCount).toBe(2)
    const counter = jumped.findings.filter((finding) => finding.rule === 'counter')
    expect(counter.length).toBe(1)
    expect(counter[0]!.level).toBe('warn')
    expect(counter[0]!.message).toContain('从 1 跳到 7')
    expect(jumped.exitCode).toBe(0)

    const noNumber = checkSubtitleText('00:00:01,000 --> 00:00:03,000\n没有序号\n', {
      preset: preset(DEFAULT_PRESET_ID),
    })
    expect(noNumber.cueCount).toBe(1)
    expect(noNumber.findings.find((finding) => finding.rule === 'counter')!.level).toBe('warn')
  })

  it('两条之间缺空行：报错，而且一条都不吞', () => {
    const report = checkSubtitleText(
      '1\n00:00:01,000 --> 00:00:03,000\n第一句\n2\n00:00:03,000 --> 00:00:05,000\n第二句\n',
      { preset: preset(DEFAULT_PRESET_ID) },
    )
    expect(report.cueCount).toBe(2)
    expect(errorsOf(report).join('；')).toContain('缺一个空行')
  })

  it('起止倒挂与零时长都报红：那一条播不出来', () => {
    const inverted = checkSubtitleText(srt(['00:00:05,000 --> 00:00:02,000', '止点在起点之前']), {
      preset: preset(DEFAULT_PRESET_ID),
    })
    expect(errorsOf(inverted).join('；')).toContain('止点比起点还早')
    const zero = checkSubtitleText(srt(['00:00:05,000 --> 00:00:05,000', '同一个时间点']), {
      preset: preset(DEFAULT_PRESET_ID),
    })
    expect(errorsOf(zero).join('；')).toContain('一帧都不会上屏')
    expect(zero.exitCode).toBe(1)
  })

  it('相邻重叠报红；正好贴着不报（那是自家编辑器的合法产物）', () => {
    const overlap = checkSubtitleText(
      srt(['00:00:01,000 --> 00:00:04,000', '前一条'], ['00:00:03,000 --> 00:00:05,000', '后一条']),
      { preset: preset(DEFAULT_PRESET_ID) },
    )
    expect(errorsOf(overlap).join('；')).toContain('叠了 1.000 秒')
    expect(overlap.exitCode).toBe(1)
    expect(errorsOf(checkSubtitleText(CLEAN, { preset: preset(DEFAULT_PRESET_ID) }))).toEqual([])
  })

  it('后一条的开始比前一条早报红：数组序不等于时间序', () => {
    const report = checkSubtitleText(
      srt(['00:00:08,000 --> 00:00:10,000', '先写的在后面'], ['00:00:01,000 --> 00:00:03,000', '后写的在前面']),
      { preset: preset(DEFAULT_PRESET_ID) },
    )
    expect(errorsOf(report).join('；')).toContain('文件顺序和时间顺序反了')
  })

  it('毫秒分隔符按格式分软硬：VTT 用逗号整条丢，SRT 用点只是写法偏', () => {
    const srtDot = checkSubtitleText(srt(['00:00:01.000 --> 00:00:03.000', 'SRT 里用了点']), {
      preset: preset(DEFAULT_PRESET_ID),
    })
    expect(srtDot.findings.find((finding) => finding.rule === 'timestamp')!.level).toBe('warn')
    expect(srtDot.exitCode).toBe(0)

    const vttComma = checkSubtitleText('WEBVTT\n\n00:00:01,000 --> 00:00:03,000\nVTT 里用了逗号\n', {
      preset: preset(DEFAULT_PRESET_ID),
    })
    expect(vttComma.format).toBe('vtt')
    expect(errorsOf(vttComma).join('；')).toContain('WebVTT 的时间戳只认点号')
    expect(vttComma.exitCode).toBe(1)
  })

  it('毫秒位数不足三位：VTT 报红，SRT 警告，而 `,5` 两边都按 500 毫秒读', () => {
    const srtShort = checkSubtitleText(srt(['00:00:01,5 --> 00:00:03,5', '两位毫秒']), {
      preset: preset(DEFAULT_PRESET_ID),
    })
    expect(srtShort.exitCode).toBe(0)
    expect(srtShort.findings.filter((f) => f.rule === 'timestamp').map((f) => f.level)).toEqual(['warn'])
    // 停留时长按 2 秒算才对：把 `,5` 读成 5 毫秒会顺带报出一条根本不存在的错
    expect(allMessages(srtShort)).not.toContain('只停留')

    const vttShort = checkSubtitleText('WEBVTT\n\n00:00:01.5 --> 00:00:03.5\n两位毫秒\n', {
      preset: preset(DEFAULT_PRESET_ID),
    })
    expect(vttShort.exitCode).toBe(1)
  })

  it('没写毫秒部分照样能播，只警告', () => {
    const report = checkSubtitleText(srt(['00:00:01 --> 00:00:03', '没有时间行的毫秒']), {
      preset: preset(DEFAULT_PRESET_ID),
    })
    expect(report.cueCount).toBe(1)
    expect(report.findings.filter((f) => f.rule === 'timestamp').map((f) => f.level)).toEqual(['warn'])
    expect(report.exitCode).toBe(0)
  })

  it('替换符、落单代理对、控制字符报红；私有区只警告', () => {
    const probes: [string, string, 'error' | 'warn'][] = [
      ['替换符', String.fromCharCode(0xfffd), 'error'],
      ['落单代理', String.fromCharCode(0xd83d), 'error'],
      ['控制字符', String.fromCharCode(0x01), 'error'],
      ['私有区', String.fromCharCode(0xe000), 'warn'],
    ]
    for (const [name, glyph, level] of probes) {
      const report = checkSubtitleText(srt(['00:00:01,000 --> 00:00:03,000', `这段里有${glyph}这个东西`]), {
        preset: preset(DEFAULT_PRESET_ID),
      })
      const hit = report.findings.find((finding) => finding.rule === 'chars')
      expect(hit, `${name} 那一条没报出来`).toBeDefined()
      expect(hit!.level, `${name} 报的级别不对`).toBe(level)
    }
    expect(checkSubtitleText(srt(['00:00:01,000 --> 00:00:03,000', `坏字节 ${String.fromCharCode(0xfffd)}`]), {
      preset: preset(DEFAULT_PRESET_ID),
    }).exitCode).toBe(1)
  })

  it('空台词只警告：自家产物里那是一段留白，内容没坏', () => {
    const report = checkSubtitleText('1\n00:00:01,000 --> 00:00:03,000\n\n', {
      preset: preset(DEFAULT_PRESET_ID),
    })
    const empty = report.findings.find((finding) => finding.rule === 'empty')
    expect(empty!.level).toBe('warn')
    expect(report.exitCode).toBe(0)
  })

  it('SRT 的时间行后面挂 VTT 的位置设置时报红：那是两套写法混在一份文件里', () => {
    const report = checkSubtitleText(srt(['00:00:01,000 --> 00:00:03,000 line:90%', '挂了位置设置']), {
      preset: preset(DEFAULT_PRESET_ID),
    })
    expect(errorsOf(report).join('；')).toContain('只有 VTT 才在那儿挂位置设置')
  })
})

describe('L2 排版层：阈值来自档位，出处跟着报错走', () => {
  it('一行 16 字在 broadcast-cn（上限 15）下逐条报红，且把依据念出来', () => {
    const report = checkSubtitleText(srt(['00:00:01,000 --> 00:00:03,000', '这句台词刚好十六个字超了那档上限']), {
      preset: preset('broadcast-cn'),
    })
    const hit = report.findings.find((finding) => finding.rule === 'charsPerLine')
    expect(hit!.level).toBe('error')
    expect(hit!.message).toContain('16 字')
    expect(hit!.message).toContain('本档上限 15 字')
    expect(hit!.message).toContain('依据')
    // 「不合规」那种说法会把二手转述讲成官方红线，这里一次都不许出现
    expect(allMessages(report)).not.toMatch(/不合规|违规/)
  })

  it('数字数是摘掉 `<i>` 之后的码点数：十四字加标记不算越线', () => {
    const report = checkSubtitleText(srt(['00:00:01,000 --> 00:00:03,000', '<i>这句十四字</i>刚好压线啊']), {
      preset: preset('broadcast-cn'),
    })
    expect(report.findings.filter((finding) => finding.rule === 'charsPerLine')).toEqual([])
  })

  it('停留时长的上下限都判，越线的读数不许看着像没越', () => {
    const tooShort = checkSubtitleText(srt(['00:00:01,000 --> 00:00:01,500', '半秒']), {
      preset: preset('broadcast-cn'),
    })
    expect(errorsOf(tooShort).join('；')).toContain('只停留 0.500 秒，本档下限 1 秒')
    const tooLong = checkSubtitleText(srt(['00:00:01,000 --> 00:00:09,000', '八秒']), {
      preset: preset('broadcast-cn'),
    })
    expect(errorsOf(tooLong).join('；')).toContain('停了 8.000 秒，本档上限 7 秒')
  })

  it('阅读速度按整条字数除以停留时长判', () => {
    const report = checkSubtitleText(srt(['00:00:01,000 --> 00:00:03,000', '整整二十个字的台词用来踩这条阅读速度的上限']), {
      preset: preset('broadcast-cn'),
    })
    const hit = report.findings.find((finding) => finding.rule === 'readingSpeed')
    expect(hit!.message).toContain('字每秒')
    expect(hit!.message).toContain('本档上限 9 字每秒')
  })

  it('读数往越线的方向收：27 字摊在 2.999 秒里报 9.01，不能报成一个看着没越线的 9.00', () => {
    const phrase = '监管部门提醒投资者注意风险甄别'
    const text = `${phrase}${phrase.slice(0, 12)}`
    const report = checkSubtitleText(srt(['00:00:01,000 --> 00:00:03,999', text]), {
      preset: preset('broadcast-cn'),
    })
    const hit = report.findings.find((finding) => finding.rule === 'readingSpeed')
    expect(Array.from(text).length).toBe(27)
    expect(hit!.message).toContain('9.01 字每秒，本档上限 9')
    expect(hit!.message).not.toContain('9.00 字每秒')
  })

  it('相邻间隙默认关掉；谁在档位里写开，贴着的那两条就被点名', () => {
    const strict = tweaked('broadcast-cn', (rules) => {
      rules.minGap.level = 'error'
    })
    const report = checkSubtitleText(CLEAN, { preset: strict })
    expect(report.summary.error).toBeGreaterThan(0)
    expect(errorsOf(report).join('；')).toContain('只隔 0.000 秒')
    expect(report.skipped.find((item) => item.rule === 'minGap')).toBeUndefined()
    // 同一份稿子在不判这条的默认档位里不该因此报错
    expect(errorsOf(checkSubtitleText(CLEAN, { preset: preset('broadcast-cn') }))).toEqual([])
  })

  it('帧格那条只在给了 --fps 时跑，跑出来也是提示不是红', () => {
    const withoutFps = checkSubtitleText(srt(['00:00:01,021 --> 00:00:03,000', '落点不在帧格上']), {
      preset: preset('broadcast-cn'),
    })
    const skipped = withoutFps.skipped.find((item) => item.rule === 'frameGrid')
    expect(skipped!.reason).toContain('没给 --fps')

    const withFps = checkSubtitleText(srt(['00:00:01,021 --> 00:00:03,000', '落点不在帧格上']), {
      preset: preset('broadcast-cn'),
      fps: 25,
    })
    expect(withFps.skipped.find((item) => item.rule === 'frameGrid')).toBeUndefined()
    const hit = withFps.findings.find((finding) => finding.rule === 'frameGrid')
    expect(hit!.level).toBe('info')
    expect(hit!.message).toContain('不在帧格上')
    expect(withFps.exitCode).toBe(0)

    // netflix 那份档位里帧格本来就是关的：它的两份转述没有这一条
    expect(
      checkSubtitleText(CLEAN, { preset: preset('netflix-cjk'), fps: 25 }).skipped.find(
        (item) => item.rule === 'frameGrid',
      )!.reason,
    ).toContain('off')
  })
})

describe('一致守卫：导出 → 解析 → 判定 与 直接判定 必须一字不差', () => {
  /** 两条路该差的只有坐标：文件侧有行号与原文片段，segments 侧没有这两样。判的是结论。 */
  function conclusions(report: CheckReport) {
    return {
      format: report.format,
      cueCount: report.cueCount,
      fps: report.fps,
      summary: report.summary,
      checked: report.checked,
      skipped: report.skipped,
      exitCode: report.exitCode,
      findings: report.findings.map((finding) => ({
        layer: finding.layer,
        level: finding.level,
        rule: finding.rule,
        cue: finding.cue ?? null,
        message: finding.message,
      })),
    }
  }

  for (const id of BUILTIN_PRESET_IDS) {
    for (const format of ['srt', 'vtt'] as const) {
      it(`${id} / ${format}：两条路给出同一份结论`, () => {
        const viaFile = checkSubtitleText(exportTranscript(MESSY, format), { preset: preset(id) })
        const viaSegments = checkSegments(MESSY, { preset: preset(id) }, format)
        expect(viaFile.cueCount).toBe(4)
        expect(conclusions(viaSegments)).toEqual(conclusions(viaFile))
      })
    }
  }

  it('这份素材不是空跑：换成 broadcast-cn 就是一片红', () => {
    const report = checkSubtitleText(exportTranscript(MESSY, 'srt'), { preset: preset('broadcast-cn') })
    const rules = new Set<string>(report.findings.map((finding) => finding.rule))
    for (const rule of ['linesPerCue', 'charsPerLine', 'cueDuration', 'readingSpeed']) {
      expect(rules.has(rule), `越线素材本该踩到 ${rule}`).toBe(true)
    }
    expect(report.exitCode).toBe(1)
  })

  it('亚秒落点先过导出那把尺：6.0004 落成 6,000 之后两条路都读出 3.000 秒', () => {
    const file = exportTranscript(MESSY, 'srt')
    const options = { preset: preset('broadcast-cn') }
    const viaFile = checkSubtitleText(file, options)
    const viaSegments = checkSegments(MESSY, options)
    expect(file).toContain('00:00:06,000 --> 00:00:09,000')
    // 内存里那一段是 2.9996 秒：不先落成文件上那个 6,000，这里会读出 2.999，两条路当场分叉
    const speeds = (report: CheckReport) =>
      report.findings
        .filter((finding) => finding.rule === 'readingSpeed')
        .map((finding) => finding.message)
        .join('；')
    expect(speeds(viaSegments)).toBe(speeds(viaFile))
    expect(speeds(viaFile)).toContain('摊在 3.000 秒里')
    expect(speeds(viaFile)).not.toContain('2.999')
  })

  it('同一份素材在 vv-default 下只给提示：界面上不该因此整屏红', () => {
    const report = checkSegments(MESSY, { preset: preset(DEFAULT_PRESET_ID) })
    expect(report.findings.length).toBeGreaterThan(0)
    expect(report.summary.error).toBe(0)
    expect(report.exitCode).toBe(0)
  })
})

describe('人看的那份输出：出处表与范围声明跟着报告走', () => {
  const report = checkSubtitleText(srt(['00:00:01,000 --> 00:00:09,000', '这句台词刚好十六个字超了那档上限']), {
    preset: preset('broadcast-cn'),
  })
  const text = renderReport(report, '交付.srt')

  it('抬头点名文件、格式、条数与档位', () => {
    expect(text).toContain('校验 交付.srt')
    expect(text).toContain('SRT，1 条字幕')
    expect(text).toContain(`档位：${report.preset.title}（broadcast-cn）`)
  })

  it('越线的每条都印依据，末尾那张出处表把 cite 与 source 全文列出来', () => {
    expect(text).toContain(`依据：${report.preset.rules.charsPerLine.cite}`)
    for (const ruleId of RULE_IDS) {
      const spec = report.preset.rules[ruleId]
      if (spec.level === 'off') continue
      expect(text, `${ruleId} 的 cite 没进出处表`).toContain(spec.cite)
      expect(text, `${ruleId} 的 source 没进出处表`).toContain(spec.source)
    }
    expect(text).toContain(`这一档为什么这么取：${report.preset.why}`)
  })

  it('判过的与关掉的那条分别列出，关掉的要说清为什么', () => {
    expect(text).toContain('判了：')
    expect(text).toContain('这一档把 level 写成了 off')
  })

  it('文件侧的报错带原文与行号，那是 segments 那条路给不出的坐标', () => {
    expect(text).toContain('原文（第 2 行）：00:00:01,000 --> 00:00:09,000')
  })

  it('结尾必有一段范围声明：全绿不等于能交', () => {
    expect(text).toContain(SCOPE_NOTE)
    expect(SCOPE_NOTE).toContain('去标点用半角空格断句')
    expect(SCOPE_NOTE).toContain('本工具不判')
  })

  it('三档 × 两种格式的全部输出里没有「不合规」那一类措辞', () => {
    for (const id of BUILTIN_PRESET_IDS) {
      const chosen = preset(id)
      const outputs = [
        renderReport(checkSubtitleText(exportTranscript(MESSY, 'srt'), { preset: chosen }), 'a.srt'),
        renderReport(checkSubtitleText(exportTranscript(MESSY, 'vtt'), { preset: chosen }), 'a.vtt'),
        renderReport(checkSegments(MESSY, { preset: chosen }), '界面里那份'),
      ]
      for (const output of outputs) {
        expect(output, `${id} 的输出里出现了官方红线那种说法`).not.toMatch(/不合规|违规|不合格/)
      }
    }
  })
})