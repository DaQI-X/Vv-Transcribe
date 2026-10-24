/**
 * 转写语言清单
 * value 就是 Whisper 的语言码：本地引擎（faster-whisper）和云端
 * （OpenAI /audio/transcriptions 的 language 字段）都直接吃这套码，中间不做映射。
 *
 * 只列实测能出字幕的语种，并且不给「自动检测」：自动检测对带口音、夹杂外语的素材经常选错
 * 语种，错了会整段输出成翻译文本，那种结果比错字更难被发现。
 */
export const ASR_LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'zh', label: '中文（普通话）' },
  { value: 'en', label: '英语 English' },
  { value: 'ja', label: '日语 日本語' },
  { value: 'ko', label: '韩语 한국어' },
  { value: 'th', label: '泰语 ไทย' },
  { value: 'vi', label: '越南语 Tiếng Việt' },
  { value: 'id', label: '印尼语 Bahasa Indonesia' },
  { value: 'fr', label: '法语 Français' },
  { value: 'de', label: '德语 Deutsch' },
  { value: 'es', label: '西班牙语 Español' },
  { value: 'ru', label: '俄语 Русский' },
  { value: 'ar', label: '阿拉伯语 العربية' },
]

/**
 * 本地校对靠的是「常见误听表 + 中文词库」，两者只对中文成立。
 * 留空按中文处理：老用户的 settings.json 里没有这个字段，默认就是中文。
 */
export function hasLocalProofreadRules(language: string | null | undefined): boolean {
  return !language || language === 'zh'
}

export function languageLabel(language: string | null | undefined): string {
  if (!language) return '中文（普通话）'
  return ASR_LANGUAGE_OPTIONS.find((opt) => opt.value === language)?.label ?? language
}
