/**
 * 中文转写结果的繁简体归一
 *
 * 为什么必须有：本机实测 small 档在中文素材上明显比 base 准（base 会把「我要保护大家」听成
 * 「不要保护大家」这种语义反转），但它会漂到繁体——前几段还是简体，后面整段转繁体，
 * 用 initial_prompt 三种写法都锁不住。云端 whisper-1 同样会出繁体。
 * 而下游全都按简体工作：常见误听表和中文词库是简体写的，导出的字幕给国内播出方也是简体。
 * 字幕里简繁混排对播出稿是硬伤，所以在引擎出口处统一成简体。
 */
import { Converter } from 'opencc-js/t2cn'

let converter: ((text: string) => string) | null = null

/**
 * 只对中文素材生效。
 * 日语用同一批汉字（線、発、会…），对日语素材做繁→简会把字改错，所以 ja/en/… 一律原样返回。
 * 「留空按中文处理」与渲染层的 hasLocalProofreadRules 保持同一口径：老 settings.json 没这个字段。
 */
export function isChineseTarget(language: string | undefined): boolean {
  return !language || language.startsWith('zh')
}

export function toSimplified(text: string, language: string | undefined): string {
  if (!isChineseTarget(language) || !text) return text
  // 字典建成 trie 要几毫秒（本机实测首次 4ms、之后每次不到 2ms），放在模块加载时等于让
  // 所有用户都为中文转换付一次钱，所以等真的转出中文才建
  if (!converter) converter = Converter({ from: 'tw', to: 'cn' })
  return converter(text)
}
