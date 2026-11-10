/**
 * 字幕规矩判定（#356）：`vv check`、MCP 那把校验 tool 与（将来）界面共用的一份真相。
 *
 * 三层里只做两层：
 * - **L1 结构层**——本文件硬编码：能不能解析、序号、时间戳写法、倒挂/零时长、相邻重叠、控制字符与乱码。
 *   分级判据只有一条：**会不会有一条字幕上不了屏**。会丢的报 error（退出码 1），只是写法不标准但照样显示的报 warn。
 *   不分这两档的话，大量能正常播放的外来稿子会被整片拒掉，用户怀疑的是工具而不是文件。
 * - **L2 排版层**——阈值住 preset 数据文件（`src/data/subtitle-presets/*.json`），不是代码常量：
 *   每屏行数、每行字数、停留时长、阅读速度、相邻间隙、帧格。每条阈值必须带 `cite`（短，进报错文本）
 *   和 `source`（长，进末尾的出处表）。报错**不许写成「不合规」**，只写成「超本档上限 X —— 依据〈cite〉」：
 *   有的出处根本没给数字、二手转述之间还互相冲突，只有把来路印出来这句话才站得住。
 * - **L3 语言层不判**：译制稿那四条（去标点用半角空格断句、数字转汉字、重复三遍只上三次、删句头语气词）
 *   要的是改稿，与本应用「不自动改稿」「忠实转写」两条底线正面冲突，且需要 NLP。
 *
 * 两处故意不判，别当 bug 补回来：
 * 1. **相邻间隙 ≥0.08 秒**：界面那侧的不变量只保证「数组序＝时间序、相邻不重叠」（timelineEdit.ts），
 *    不保证留了间隙。判它会把自家合法产物报成红。三档 preset 里 `minGap` 都写 `off`，谁要谁自己开。
 * 2. **「出现/消失误差 ≤3 帧」**：那是对着原片量的；SRT 文件里既没有帧率也没有参考音轨，离线判不了。
 *    只有显式给了 `--fps`，才跑得起来那一条「落点不在这一部片子的帧格上」，而且它只出提示。
 *
 * 这一份不 import electron、不碰 DOM、不读文件：界面与 CLI 判的是同一个函数，两边不许出现两个数。
 */
import broadcastCnPreset from '../data/subtitle-presets/broadcast-cn.json'
import netflixCjkPreset from '../data/subtitle-presets/netflix-cjk.json'
import vvDefaultPreset from '../data/subtitle-presets/vv-default.json'
import {
  cuesFromSegments,
  parseSubtitle,
  type ParseIssue,
  type SubtitleCue,
  type SubtitleFormat,
} from './subtitleParse'
import { charCount } from './timelineEdit'

/** 一条规矩的四级开关：off＝不跑（进 skipped），info＝只出一条汇总，warn/error＝逐条 */
export const RULE_LEVELS = ['error', 'warn', 'info', 'off'] as const
export type RuleLevel = (typeof RULE_LEVELS)[number]
export type FindingLevel = Exclude<RuleLevel, 'off'>

/** preset 里必须写全的六条；少一条就报错——「没判」和「判过」不许在报告里长得一样 */
export const RULE_IDS = [
  'linesPerCue',
  'charsPerLine',
  'cueDuration',
  'readingSpeed',
  'minGap',
  'frameGrid',
] as const
export type RuleId = (typeof RULE_IDS)[number]

const RULE_LABEL: Record<RuleId, string> = {
  linesPerCue: '每屏行数',
  charsPerLine: '每行字数',
  cueDuration: '停留时长',
  readingSpeed: '阅读速度',
  minGap: '相邻间隙',
  frameGrid: '帧格对齐',
}

/** 每条允许的数值旋钮；不在这里面的键（拼错的 `maxChars`）一律拒，免得它静默不生效 */
const RULE_KNOBS: Record<RuleId, readonly string[]> = {
  linesPerCue: ['max'],
  charsPerLine: ['max'],
  cueDuration: ['min', 'max'],
  readingSpeed: ['maxCharsPerSecond'],
  minGap: ['min'],
  frameGrid: [],
}
const COMMON_KEYS = ['level', 'cite', 'source', 'counting']

export interface RuleSpec {
  level: RuleLevel
  cite: string
  source: string
  counting?: string
  max?: number
  min?: number
  maxCharsPerSecond?: number
}

export interface SubtitlePreset {
  schema: number
  id: string
  title: string
  why: string
  rules: Record<RuleId, RuleSpec>
}

export interface Finding {
  layer: 'L1' | 'L2'
  level: FindingLevel
  /** L2 用 RuleId；L1 用细粒度 id，好让测试与 --json 按项计数 */
  rule:
    | RuleId
    | 'parse'
    | 'timestamp'
    | 'counter'
    | 'timing'
    | 'order'
    | 'overlap'
    | 'chars'
    | 'empty'
  /** L2 的尾部已拼上「—— 依据〈cite〉」 */
  message: string
  /** 第几条（1 基，按出现顺序）；一条 finding 涉及多条时省略，改在 message 里举例 */
  cue?: number
  /** 文件里的行号（1 基）；直接判定那条路没有文件，省略 */
  line?: number
  /** 文件上那一行原文，或越线的那一行台词：报错要能念回来 */
  detail?: string
}

export interface SkippedRule {
  rule: string
  label: string
  reason: string
}

export interface CheckReport {
  format: SubtitleFormat
  cueCount: number
  /** 归一化后的整份档位，含每条的 cite/source：--json 的消费方（agent）要能自己查依据 */
  preset: SubtitlePreset
  fps: number | null
  findings: Finding[]
  summary: { error: number; warn: number; info: number }
  checked: string[]
  skipped: SkippedRule[]
  /** 门槛只看「有没有 error」：warn/info 都不拦路 */
  exitCode: 0 | 1
}

export interface CheckOptions {
  preset: SubtitlePreset
  fps?: number | null
}

/** segments 的最小形状：与 TranscriptionSegment 一致，但不把渲染层的类型拖进 node 侧 */
export interface SegmentLike {
  startTime: number
  endTime: number
  text: string
}

// ——— 档位装载 ————————————————————————————————————————————————————

export type PresetResult = { ok: true; preset: SubtitlePreset } | { ok: false; errors: string[] }

const BUILTIN: Record<string, unknown> = {
  'vv-default': vvDefaultPreset,
  'broadcast-cn': broadcastCnPreset,
  'netflix-cjk': netflixCjkPreset,
}

/** 随包那三档的 id；`--preset <名字>` 只认这些，其余按文件路径读 */
export const BUILTIN_PRESET_IDS = Object.keys(BUILTIN)

export const DEFAULT_PRESET_ID = 'vv-default'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 校验一份 preset，并把不认识的键挡在外面。
 *
 * `cite`/`source` 必填：这是「报错文本要把出处印出来」「不许说成官方要求」唯一的机制保证。
 * 手改的那份少写出处就装载不了，而不是生成一条没有依据的红——后者会把二手转述伪装成规范原文。
 */
export function validatePreset(raw: unknown, where: string): PresetResult {
  const errors: string[] = []
  if (!isRecord(raw)) {
    return { ok: false, errors: [`${where}：档位要的是一个对象（形如 { "schema": 1, "rules": { ... } }）`] }
  }

  const id = readText(raw.id)
  const title = readText(raw.title)
  const why = readText(raw.why)
  if (!id) errors.push(`${where}：缺 id（报告与 --json 都靠它点名用的哪一档）`)
  if (!title) errors.push(`${where}：缺 title（报告第一行念的是它）`)
  if (!why) errors.push(`${where}：缺 why（这档为什么这么取值，得跟数字一起留下）`)
  const schema = readNumber(raw.schema)
  if (schema !== 1) {
    errors.push(`${where}：schema 要写 1，这里${raw.schema === undefined ? '没写' : `写的是 ${String(raw.schema)}`}`)
  }
  if (!isRecord(raw.rules)) errors.push(`${where}：缺 rules 对象（六条规矩全在里面）`)
  if (errors.length > 0) return { ok: false, errors }

  const rawRules = raw.rules as Record<string, unknown>
  for (const key of Object.keys(rawRules)) {
    if (!(RULE_IDS as readonly string[]).includes(key)) {
      errors.push(`${where}：rules 里的「${key}」这一条本应用不判。能写的只有：${RULE_IDS.join('、')}。`)
    }
  }
  for (const ruleId of RULE_IDS) {
    if (!Object.prototype.hasOwnProperty.call(rawRules, ruleId)) {
      errors.push(
        `${where}：rules 里少了「${ruleId}」（${RULE_LABEL[ruleId]}）。六条都得写——不想判某条就把它的 level 写成 off，` +
          `别整条删掉：删掉等于让「没判」和「判过」在报告里长得一样。`,
      )
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  const rules = {} as Record<RuleId, RuleSpec>
  for (const ruleId of RULE_IDS) {
    const entry = rawRules[ruleId]
    if (!isRecord(entry)) {
      errors.push(`${where}：rules.${ruleId} 要的是一个对象（level / cite / source 加上数值旋钮）`)
      continue
    }
    const known = [...COMMON_KEYS, ...RULE_KNOBS[ruleId]]
    for (const key of Object.keys(entry)) {
      if (!known.includes(key)) {
        errors.push(`${where}：rules.${ruleId} 里有不认识的键「${key}」（这条只认：${known.join('、')}）`)
      }
    }
    if (typeof entry.level !== 'string' || !(RULE_LEVELS as readonly string[]).includes(entry.level)) {
      errors.push(
        `${where}：rules.${ruleId}.level 要写 error、warn、info 或 off，这里写的是 ${String(entry.level)}`,
      )
      continue
    }
    const cite = readText(entry.cite)
    const source = readText(entry.source)
    if (!cite) errors.push(`${where}：rules.${ruleId} 缺 cite——报错文本里那个短出处，不许省`)
    if (!source) errors.push(`${where}：rules.${ruleId} 缺 source——这条阈值的来路，不许省`)
    let counting: string | undefined
    if (entry.counting !== undefined) {
      counting = readText(entry.counting) ?? undefined
      if (!counting) errors.push(`${where}：rules.${ruleId}.counting 是一句「怎么数字」的说明，得是文字`)
    }

    const spec: RuleSpec = { level: entry.level as RuleLevel, cite: cite ?? '', source: source ?? '' }
    if (counting) spec.counting = counting
    for (const knob of RULE_KNOBS[ruleId]) {
      const value = readNumber(entry[knob])
      if (value === null) {
        errors.push(`${where}：rules.${ruleId}.${knob} 要是一个数，这里写的是 ${String(entry[knob])}`)
        continue
      }
      // minGap 的 min 允许 0（「只要不许重叠」那种档位）；其余边界写 0 等于把这条关掉，那该由 level: off 来说
      const allowZero = ruleId === 'minGap'
      if (allowZero ? value < 0 : value <= 0) {
        errors.push(`${where}：rules.${ruleId}.${knob} 要${allowZero ? '不小于 0' : '大于 0'}，这里是 ${value}`)
        continue
      }
      if ((ruleId === 'linesPerCue' || ruleId === 'charsPerLine') && !Number.isInteger(value)) {
        errors.push(`${where}：rules.${ruleId}.${knob} 要写整数（行数与字数没有半个），这里是 ${value}`)
        continue
      }
      if (knob === 'max' || knob === 'min') spec[knob] = value
      else spec.maxCharsPerSecond = value
    }
    if (ruleId === 'cueDuration' && spec.min !== undefined && spec.max !== undefined && spec.min >= spec.max) {
      errors.push(`${where}：rules.cueDuration 的下限（${spec.min} 秒）必须小于上限（${spec.max} 秒）`)
    }
    rules[ruleId] = spec
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, preset: { schema: 1, id: id!, title: title!, why: why!, rules } }
}

/** 随包档位也走一遍校验：随包文件写坏了要在这里响，而不是等到用户在用 */
export function builtinPreset(id: string): PresetResult {
  const raw = BUILTIN[id]
  if (raw === undefined) {
    return {
      ok: false,
      errors: [
        `没有内置档位「${id}」。内置的有：${BUILTIN_PRESET_IDS.join('、')}。` +
          `要用自己那份就写路径：--preset ./我的档位.json`,
      ],
    }
  }
  return validatePreset(raw, `内置档位 ${id}`)
}

/** 三档必须都在、每条的出处字段一个都不能少（tests/subtitleSpec.test.ts 钉这条） */
export function builtinPresets(): SubtitlePreset[] {
  return BUILTIN_PRESET_IDS.map((id) => {
    const loaded = builtinPreset(id)
    if (!loaded.ok) throw new Error(loaded.errors.join('；'))
    return loaded.preset
  })
}

// ——— L1 结构层 ————————————————————————————————————————————————————

/** 替换符：读文件时那段字节没被认出来，屏幕上是个方框或问号（多半根本不是 UTF-8） */
const REPLACEMENT_CHAR = /\uFFFD/
/** 落单代理项：半个 emoji。文本再往下走会一路被丢成 ?，所以它算「上不了屏」 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
/** C0/C1 控制字符；\t 与换行留着（台词里制表符不算坏，换行已经被切成行） */
const CONTROL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/
/** 私有区：那是某个软件的图标字体，别的软件打开只有空白或方框 */
const PRIVATE_USE = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u

/** 阈值边界上不许出现「0.999 秒，下限 1 秒」这种看着自相矛盾的读数：往下越线截尾，往上越线进一 */
function shown(n: number, digits: number, direction: 'down' | 'up'): string {
  const factor = 10 ** digits
  const adjusted = direction === 'down' ? Math.floor(n * factor) / factor : Math.ceil(n * factor) / factor
  return adjusted.toFixed(digits)
}

function truncate(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/** 「第 3、7、12 条」——超过三处只举前三条并点名总数，一份坏文件不该刷 500 行同样的话 */
function sampleHits(indexes: number[]): string {
  const head = indexes.slice(0, 3).map((n) => `第 ${n} 条`).join('、')
  return indexes.length > 3 ? `${head}（共 ${indexes.length} 条）` : head
}

function pushAggregate(
  findings: Finding[],
  level: FindingLevel,
  rule: Finding['rule'],
  cues: SubtitleCue[],
  indexes: number[],
  message: string,
): void {
  if (indexes.length === 0) return
  const first = cues.find((cue) => cue.index === indexes[0])
  const finding: Finding = { layer: 'L1', level, rule, message: `${sampleHits(indexes)}${message}` }
  if (first && first.line > 0) {
    finding.line = first.line
    if (first.timing) finding.detail = truncate(first.timing)
  }
  findings.push(finding)
}

/** 一处一条的 L1：这些天生只可能零星出现，全列不算刷屏 */
function pushPerCue(
  findings: Finding[],
  level: FindingLevel,
  rule: Finding['rule'],
  cue: SubtitleCue,
  message: string,
): void {
  const finding: Finding = { layer: 'L1', level, rule, cue: cue.index, message }
  if (cue.line > 0) {
    finding.line = cue.line
    if (cue.timing) finding.detail = truncate(cue.timing)
  }
  findings.push(finding)
}

function checkStructure(
  cues: SubtitleCue[],
  issues: ParseIssue[],
  format: SubtitleFormat,
  findings: Finding[],
): void {
  // 解析器说「这一块我没认出来」的一律 error：那是整块上不了屏的坏法
  for (const issue of issues) {
    const finding: Finding = { layer: 'L1', level: 'error', rule: 'parse', message: issue.message }
    if (issue.line !== null) finding.line = issue.line
    if (issue.snippet) finding.detail = truncate(issue.snippet)
    findings.push(finding)
  }

  // 时间戳写法分软硬：WebVTT 的语法只认点号加三位毫秒，写错的条浏览器整条丢（error）；
  // SRT 没有正式规范，逗号写成了点照样播，只是跨软件时最容易掉时间（warn）。
  const commaInVtt: number[] = []
  const dotInSrt: number[] = []
  const digitsOff: number[] = []
  const noMillis: number[] = []
  for (const cue of cues) {
    for (const time of [cue.start, cue.end]) {
      if (time.delimiter === null) {
        noMillis.push(cue.index)
        continue
      }
      if (format === 'srt' && time.delimiter === '.') dotInSrt.push(cue.index)
      if (format === 'vtt' && time.delimiter === ',') commaInVtt.push(cue.index)
      if (time.fractionDigits !== 3) digitsOff.push(cue.index)
    }
  }
  pushAggregate(findings, 'error', 'timestamp', cues, commaInVtt, ' 的毫秒用逗号分开——WebVTT 的时间戳只认点号，这几条在浏览器里整条丢掉')
  pushAggregate(findings, 'warn', 'timestamp', cues, dotInSrt, ' 把毫秒写在了小数点后面（写成 `00:00:01.999` 而不是逗号）——本应用与多数软件写逗号，这几条跨软件时最容易被当成坏时间')
  pushAggregate(
    findings,
    format === 'vtt' ? 'error' : 'warn',
    'timestamp',
    cues,
    digitsOff,
    ' 的毫秒位数不是三位（`1,2` 这种）——补齐的那几位按零算，`1,2` 是 200 毫秒不是 20 毫秒',
  )
  pushAggregate(findings, 'warn', 'timestamp', cues, noMillis, ' 没时间戳的毫秒部分（`00:00:01 --> 00:00:03`）——照样能播，但这条的边界最多少给一秒')

  // 序号：SRT 的写法是每条一个自增数字。VTT 不需要，所以不判。
  if (format === 'srt') {
    const noNumber: number[] = []
    const jumps: string[] = []
    const jumpedAt: number[] = []
    let previous: number | null = null
    for (const cue of cues) {
      if (cue.number === null) {
        noNumber.push(cue.index)
        continue
      }
      if (previous !== null && cue.number !== previous + 1) {
        jumps.push(`第 ${cue.index} 条从 ${previous} 跳到 ${cue.number}`)
        jumpedAt.push(cue.index)
      }
      previous = cue.number
    }
    // 这两条都是 warn：缺序号或跳号在 libass 那一类渲染器里照样逐条上屏，只有少数按序号排序的对账工具会在意
    pushAggregate(findings, 'warn', 'counter', cues, noNumber, ' 没有时间行之前的序号——SRT 的写法是每条一个自增数字，个别按序号配对的软件会把这两条并成一条')
    if (jumps.length > 0) {
      pushAggregate(findings, 'warn', 'counter', cues, jumpedAt, ` 的序号不连续（${jumps.slice(0, 3).join('；')}${jumps.length > 3 ? `；共 ${jumps.length} 处` : ''}）`)
    }
  }

  // 落点本身：倒挂与零时长都是「这一条播不出来」，所以 error
  for (const cue of cues) {
    const duration = cue.end.value - cue.start.value
    if (duration < 0) {
      pushPerCue(
        findings,
        'error',
        'timing',
        cue,
        `第 ${cue.index} 条的止点比起点还早（差了 ${shown(Math.abs(duration), 3, 'up')} 秒）——这一条谁都播不出来，而且后面每条的先后也不可信`,
      )
    } else if (duration === 0) {
      pushPerCue(
        findings,
        'error',
        'timing',
        cue,
        `第 ${cue.index} 条的起点与止点是同一个时间——零时长的字幕一帧都不会上屏`,
      )
    }
  }

  // 相邻两条：「数组序＝时间序、相邻不重叠」是播放器、配音铺轴与导出三处共同的前提，破了要当场点名
  for (let i = 1; i < cues.length; i++) {
    const prev = cues[i - 1]!
    const cur = cues[i]!
    if (cur.start.value < prev.start.value) {
      pushPerCue(
        findings,
        'error',
        'order',
        cur,
        `第 ${cur.index} 条的开始（${shown(cur.start.value, 3, 'up')} 秒）比第 ${prev.index} 条的开始（${shown(prev.start.value, 3, 'down')} 秒）还早——文件顺序和时间顺序反了；播放器按文件顺序显示，画面会来回跳`,
      )
    } else if (cur.start.value < prev.end.value) {
      pushPerCue(
        findings,
        'error',
        'overlap',
        cur,
        `第 ${prev.index} 条要到 ${shown(prev.end.value, 3, 'up')} 秒才结束，第 ${cur.index} 条在 ${shown(cur.start.value, 3, 'down')} 秒就出现了（叠了 ${shown(prev.end.value - cur.start.value, 3, 'up')} 秒）——两屏同时上字，或者后一条把前一条顶掉`,
      )
    }
  }

  const glyphKinds: { re: RegExp; level: FindingLevel; name: string; tail: string }[] = [
    {
      re: REPLACEMENT_CHAR,
      level: 'error',
      name: '替换符 ',
      tail: '——文件在那一处有一段没被认出来的字节，多半它根本不是 UTF-8；这几条上屏是方框或问号',
    },
    {
      re: LONE_SURROGATE,
      level: 'error',
      name: '半个 emoji（落单代理项）',
      tail: '——这种码位再往下走会被丢成 ?，屏幕上是残缺的字',
    },
    {
      re: CONTROL_CHAR,
      level: 'error',
      name: '控制字符',
      tail: '——台词里不该有 C0/C1 控制码；播放器把它当显示异常，有的直接截断这一行',
    },
    {
      re: PRIVATE_USE,
      level: 'warn',
      name: '私有区码位',
      tail: '——那是某个软件的图标字体，换个软件打开只剩空白；它不影响其余字幕上屏，所以只警告',
    },
  ]
  for (const kind of glyphKinds) {
    const hits: number[] = []
    for (const cue of cues) {
      if (cue.lines.some((line) => kind.re.test(line))) hits.push(cue.index)
    }
    pushAggregate(findings, kind.level, 'chars', cues, hits, ` 的台词里有${kind.name}${kind.tail}`)
  }

  const blank: number[] = []
  for (const cue of cues) {
    if (cue.lines.length === 0) blank.push(cue.index)
  }
  // 空台词不拦路：自家产物里它可能是一段故意留白的空档，内容没坏
  pushAggregate(findings, 'warn', 'empty', cues, blank, ' 没有时间行下面的台词——那一处是一段空档，不占屏但交付时会被问')
}

// ——— L2 排版层（阈值与出处都来自档位）——————————————————————————————————

interface Violation {
  cue?: number
  line?: number
  detail?: string
  message: string
}

/** 关掉某条的理由不能只写「没判」，要说清为什么这条值得关掉 */
const OFF_REASON: Record<RuleId, string> = {
  linesPerCue: '这一档把 level 写成了 off。',
  charsPerLine: '这一档把 level 写成了 off。',
  cueDuration: '这一档把 level 写成了 off。',
  readingSpeed: '这一档把 level 写成了 off。',
  minGap:
    '这一档把 level 写成了 off：应用的轴只保证「数组序＝时间序、相邻不重叠」，不保证留了间隙，判它会把自家合法产物报成红。',
  frameGrid:
    '这一档把 level 写成了 off：帧格那条是广电规范 9.3 引出来的，Netflix 口径没有对应条文；要判它还得显式给 --fps。',
}

/** 跨行不加额外字符：CPS 数的是上屏字符，那个换行本身不上屏 */
function totalChars(cue: SubtitleCue): number {
  return cue.lines.reduce((sum, line) => sum + charCount(line), 0)
}

function layoutViolations(
  ruleId: RuleId,
  spec: RuleSpec,
  cues: SubtitleCue[],
  fps: number | null,
): Violation[] {
  switch (ruleId) {
    case 'linesPerCue': {
      const max = spec.max ?? 0
      const hits: Violation[] = []
      for (const cue of cues) {
        if (cue.lines.length > max) {
          hits.push({
            cue: cue.index,
            line: cue.line || undefined,
            detail: cue.timing || undefined,
            message: `第 ${cue.index} 条上屏 ${cue.lines.length} 行，本档上限 ${max} 行`,
          })
        }
      }
      return hits
    }
    case 'charsPerLine': {
      const max = spec.max ?? 0
      const hits: Violation[] = []
      for (const cue of cues) {
        cue.lines.forEach((line, position) => {
          const count = charCount(line)
          if (count <= max) return
          hits.push({
            cue: cue.index,
            line: cue.line || undefined,
            detail: line,
            message: `第 ${cue.index} 条第 ${position + 1} 行 ${count} 字，本档上限 ${max} 字`,
          })
        })
      }
      return hits
    }
    case 'cueDuration': {
      const min = spec.min ?? 0
      const max = spec.max ?? Number.POSITIVE_INFINITY
      const hits: Violation[] = []
      for (const cue of cues) {
        const duration = cue.end.value - cue.start.value
        // 倒挂与零时长归 L1 报红，这里不重复念一遍
        if (duration <= 0) continue
        if (duration < min) {
          hits.push({
            cue: cue.index,
            line: cue.line || undefined,
            detail: cue.timing || undefined,
            message: `第 ${cue.index} 条只停留 ${shown(duration, 3, 'down')} 秒，本档下限 ${min} 秒`,
          })
        } else if (duration > max) {
          hits.push({
            cue: cue.index,
            line: cue.line || undefined,
            detail: cue.timing || undefined,
            message: `第 ${cue.index} 条停了 ${shown(duration, 3, 'up')} 秒，本档上限 ${max} 秒`,
          })
        }
      }
      return hits
    }
    case 'readingSpeed': {
      const max = spec.maxCharsPerSecond ?? 0
      const hits: Violation[] = []
      for (const cue of cues) {
        const duration = cue.end.value - cue.start.value
        const chars = totalChars(cue)
        if (duration <= 0 || chars === 0) continue
        const speed = chars / duration
        if (speed > max) {
          hits.push({
            cue: cue.index,
            line: cue.line || undefined,
            detail: cue.timing || undefined,
            message: `第 ${cue.index} 条 ${chars} 字摊在 ${shown(duration, 3, 'down')} 秒里是 ${shown(speed, 2, 'up')} 字每秒，本档上限 ${max} 字每秒`,
          })
        }
      }
      return hits
    }
    case 'minGap': {
      const min = spec.min ?? 0
      const hits: Violation[] = []
      for (let i = 1; i < cues.length; i++) {
        const prev = cues[i - 1]!
        const cur = cues[i]!
        const gap = cur.start.value - prev.end.value
        // 负数就是重叠，那是 L1 已经报红的那一件事，这里不再叠一条
        if (gap < 0) continue
        if (gap < min) {
          hits.push({
            cue: cur.index,
            line: cur.line || undefined,
            detail: cur.timing || undefined,
            message: `第 ${prev.index} 条结束到第 ${cur.index} 条开始只隔 ${shown(gap, 3, 'up')} 秒，本档要求不小于 ${min} 秒`,
          })
        }
      }
      return hits
    }
    case 'frameGrid': {
      if (fps === null) return []
      // 这条没有容差旋钮可写：离线最多偏离半帧，而规范给的容差本来就是三帧，所以半帧这条判不出「越线」。
      // 报的只能是「有多少落点不在这部片子的帧格上、最远差多少毫秒」——烧字幕时它们会被挪到最近的帧上。
      let off = 0
      let worstMs = 0
      for (const cue of cues) {
        for (const value of [cue.start.value, cue.end.value]) {
          const frames = value * fps
          const deviationMs = (Math.abs(frames - Math.round(frames)) / fps) * 1000
          if (deviationMs <= 1e-6) continue
          off += 1
          if (deviationMs > worstMs) worstMs = deviationMs
        }
      }
      if (off === 0) return []
      return [
        {
          message: `${fps} fps 下有 ${off} 个落点不在帧格上，最远差 ${shown(worstMs, 1, 'up')} 毫秒（烧进画面时这些落点会被挪到最近的帧上，挪动不超过半帧）`,
        },
      ]
    }
    default:
      return []
  }
}

function emitLayout(
  findings: Finding[],
  ruleId: RuleId,
  spec: RuleSpec,
  level: FindingLevel,
  violations: Violation[],
): void {
  if (violations.length === 0) return
  if (level === 'info') {
    // info 就是一条汇总：这正是 vv-default 那种「只报数、不拦路」的档位的实现方式
    const examples = violations.slice(0, 3).map((violation) => violation.message).join('；')
    const more = violations.length > 3 ? `；其余 ${violations.length - 3} 处同类` : ''
    findings.push({
      layer: 'L2',
      level: 'info',
      rule: ruleId,
      message: `${RULE_LABEL[ruleId]}：${violations.length} 处越线（${examples}${more}）——这一档按提示计，不拦路。依据：${spec.cite}`,
    })
    return
  }
  for (const violation of violations) {
    const finding: Finding = {
      layer: 'L2',
      level,
      rule: ruleId,
      message: `${violation.message} —— 依据：${spec.cite}`,
    }
    if (violation.cue !== undefined) finding.cue = violation.cue
    if (violation.line !== undefined) finding.line = violation.line
    if (violation.detail) finding.detail = truncate(violation.detail)
    findings.push(finding)
  }
}

function checkLayout(
  cues: SubtitleCue[],
  preset: SubtitlePreset,
  fps: number | null,
  findings: Finding[],
  checked: string[],
  skipped: SkippedRule[],
): void {
  for (const ruleId of RULE_IDS) {
    const spec = preset.rules[ruleId]
    const level: RuleLevel = spec.level
    if (level === 'off') {
      skipped.push({ rule: ruleId, label: RULE_LABEL[ruleId], reason: OFF_REASON[ruleId] })
      continue
    }
    if (ruleId === 'frameGrid' && fps === null) {
      skipped.push({
        rule: ruleId,
        label: RULE_LABEL[ruleId],
        reason:
          '没给 --fps：字幕文件里没有帧率，这条跑不起来（规范那句「误差不大于三帧」是对着原片量的，离线判不了）',
      })
      continue
    }
    checked.push(RULE_LABEL[ruleId])
    emitLayout(findings, ruleId, spec, level, layoutViolations(ruleId, spec, cues, fps))
  }
}

// ——— 入口 ————————————————————————————————————————————————————————

function judge(
  cues: SubtitleCue[],
  issues: ParseIssue[],
  format: SubtitleFormat,
  options: CheckOptions,
): CheckReport {
  const fps = options.fps ?? null
  const findings: Finding[] = []
  const checked: string[] = []
  const skipped: SkippedRule[] = []
  checkStructure(cues, issues, format, findings)
  checkLayout(cues, options.preset, fps, findings, checked, skipped)
  const summary = { error: 0, warn: 0, info: 0 }
  for (const finding of findings) summary[finding.level] += 1
  return {
    format,
    cueCount: cues.length,
    preset: options.preset,
    fps,
    findings,
    summary,
    checked,
    skipped,
    exitCode: summary.error > 0 ? 1 : 0,
  }
}

/** 判一份文件原文（`vv check`、MCP 那把 tool 走这里） */
export function checkSubtitleText(text: string, options: CheckOptions): CheckReport {
  const parsed = parseSubtitle(text)
  return judge(parsed.cues, parsed.issues, parsed.format, options)
}

/** 判界面里那份 segments：时间点先过一遍导出那把尺，两条路的结论必须一字不差 */
export function checkSegments(
  segments: SegmentLike[],
  options: CheckOptions,
  format: SubtitleFormat = 'srt',
): CheckReport {
  return judge(cuesFromSegments(segments, format), [], format, options)
}

// ——— 给人看的排版 ——————————————————————————————————————————————————

const LEVEL_MARK: Record<FindingLevel, string> = { error: '错误', warn: '警告', info: '提示' }

const LAYER_TITLE: Record<'L1' | 'L2', string> = {
  L1: '结构层（这一层不看档位，文件自己就能判）',
  L2: '排版层（阈值与出处来自档位）',
}

/** L3 不判这件事要跟着报告走：一份「全绿」的输出容易被读成「这稿子能交」 */
export const SCOPE_NOTE =
  '这里只判「文件自己就能判」的两层。译制稿那四条文字改写——去标点用半角空格断句、数字转汉字、重复三遍只上三次、删句头语气词——属 L3，本工具不判：判它要的是改稿，而这个应用的两条底线是不自动改稿、忠实转写。'

function knobText(ruleId: RuleId, spec: RuleSpec): string {
  switch (ruleId) {
    case 'linesPerCue':
      return `上限 ${spec.max} 行`
    case 'charsPerLine':
      return `上限 ${spec.max} 字`
    case 'cueDuration':
      return `${spec.min}–${spec.max} 秒`
    case 'readingSpeed':
      return `上限 ${spec.maxCharsPerSecond} 字每秒`
    case 'minGap':
      return `不小于 ${spec.min} 秒`
    case 'frameGrid':
      return '按 --fps 判落点'
    default:
      return ''
  }
}

/** 人看的那份输出：先结论、再逐条、再「哪些没判」、最后每条阈值的来路 */
export function renderReport(report: CheckReport, file?: string): string {
  const out: string[] = []
  out.push(
    `${file ? `校验 ${file}` : '校验'}：${report.format === 'srt' ? 'SRT' : 'WebVTT'}，${report.cueCount} 条字幕`,
  )
  out.push(
    `档位：${report.preset.title}（${report.preset.id}）${report.fps === null ? '' : ` · 帧率 ${report.fps} fps`}`,
  )

  if (report.findings.length === 0) out.push('判过的项目没有一条越线。')
  for (const layer of ['L1', 'L2'] as const) {
    const group = report.findings.filter((finding) => finding.layer === layer)
    if (group.length === 0) continue
    out.push('', `〔${LAYER_TITLE[layer]}〕`)
    for (const finding of group) {
      out.push(`  ${LEVEL_MARK[finding.level]}｜${finding.message}`)
      if (finding.detail) {
        out.push(`      原文${finding.line === undefined ? '' : `（第 ${finding.line} 行）`}：${finding.detail}`)
      }
    }
  }

  out.push(
    '',
    `合计：错误 ${report.summary.error} 条 · 警告 ${report.summary.warn} 条 · 提示 ${report.summary.info} 条`,
    report.summary.error > 0 ? '有错误，这一趟拦路（退出码 1）。' : '没有错误：警告与提示都不拦路（退出码 0）。',
  )

  if (report.checked.length > 0) out.push(`判了：${report.checked.join('、')}`)
  if (report.skipped.length > 0) {
    out.push('未判：')
    for (const item of report.skipped) out.push(`  · ${item.label} —— ${item.reason}`)
  }

  const cited = RULE_IDS.filter((ruleId) => report.preset.rules[ruleId].level !== 'off')
  out.push('', '这一档每条阈值的来路（报错里的「依据」就是这张表，它不是官方红线）：')
  for (const ruleId of cited) {
    const spec = report.preset.rules[ruleId]
    out.push(`  · ${RULE_LABEL[ruleId]} ${knobText(ruleId, spec)} —— ${spec.cite}`)
    out.push(`      ${spec.source}`)
    if (spec.counting) out.push(`      数法：${spec.counting}`)
  }
  out.push(`  这一档为什么这么取：${report.preset.why}`)
  out.push('', SCOPE_NOTE)
  return out.join('\n')
}