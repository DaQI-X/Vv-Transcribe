/**
 * 三档「云端方案」那张字段表（#222 重写第⑧步，列表与弹窗都从它渲染）。
 *
 * 第⑥步之前，「这一档有哪几格、每格叫什么、下面那句说明是什么」写死在面板的 JSX 里，
 * 转写换成「列表 + 弹窗」时又在两个组件里各抄了一份。这一步校对／配音接同一套 UI，
 * 再抄第三份就是「改一处要改两处」——所以收到这一处，组件只管按表画。
 *
 * 键名用的是跨 IPC 那套扁平名（asrApiBase / aiProvider / ttsModel …），与主进程
 * `settingsSchema.CAPABILITY_FIELDS` 一一对应：「这一档进方案的到底是哪几项」只有那一张表说了算，
 * 这里补的只是界面才需要的东西（标题、占位、说明、下拉的连带预填）。
 * 所以给某一档加字段时，两张表都要动，而少动那张的后果是「方案里有这项、界面上看不见」——
 * 看不见就等于改不了，比报错更难发现。
 */
import type { ProfileCapability, ProfileView } from '@/types/settingsProfile'

/** 三档能力对用户的叫法（toast 与下拉都要说清切的是哪一档） */
export const CAPABILITY_NOUN: Record<ProfileCapability, string> = {
  asr: '转写',
  ai: '校对',
  tts: '配音',
}

export interface ProfileFieldOption {
  value: string
  label: string
}

export interface ProfileFieldSpec {
  /** 跨 IPC 的扁平键名 */
  key: string
  label: string
  /** key＝密钥那格（走 ApiKeyField，值不落进 fields）；select＝下拉 */
  kind: 'text' | 'key' | 'select'
  placeholder?: string
  hint?: string
  options?: ProfileFieldOption[]
  /** 选中某项时连带填入的其他格：换服务商＝换一家网关，地址与默认模型跟着换 */
  fills?: Record<string, Record<string, string>>
  /**
   * 下拉在磁盘上没这一项时该显示哪个选项。
   * 只有「一份配置读出空串、而它的真实含义是某一档」时才用得上（配音厂商就是这种）：
   * 不给默认值，`<select>` 拿一个选项列表里没有的 value 去渲染，浏览器会选空——
   * 界面上一格空白，用户以为没选，主进程那边按默认档发请求。
   */
  fallback?: string
}

export interface ProfileCapSpec {
  /** 列表那一栏的标题 */
  listLabel: string
  /** 这一档活儿的叫法，句子里说的是「谁会被拦下」 */
  activity: string
  /** 行标题取哪一格（模型名） */
  titleKey: string
  /** 域名那一格（接口地址） */
  baseKey: string
  /** 弹窗里从上到下的格子，密钥那格也在里面占一位 */
  fields: ProfileFieldSpec[]
  introNew: string
  introEdit: string
  /** 列表一条都没有那句 */
  emptyHint: string
  /** 删除二次确认里那句「这几样一起没掉」，按这一档真有哪几格写 */
  credSummary: string
  /** 列表下方那句：右下角那颗「保存设置」在这一档还管什么 */
  panelNote: string
  /** 这一条还没有 Key 时的说法（新建与编辑不是一回事：新建那一条磁盘上根本没有可替换的 Key） */
  keyHintNew: string
  keyHintEdit: string
}

const KEY_HINT_NEW = '填一把，跟着「保存」一起存进这一条；不填＝这条不带密钥'

/**
 * 服务商只是「这套地址和 Key 是哪家」的书签，主进程取配置时不看它，
 * 界面上按它预填地址与默认模型（换网关时这两样必须跟着换，留着旧地址等于换个名字骗自己）。
 */
const AI_PROVIDER_PRESETS: Record<string, { aiApiBase: string; aiModel: string }> = {
  openai: { aiApiBase: 'https://api.openai.com', aiModel: 'gpt-4o-mini' },
  deepseek: { aiApiBase: 'https://api.deepseek.com', aiModel: 'deepseek-chat' },
  qwen: { aiApiBase: 'https://dashscope.aliyuncs.com/compatible-mode', aiModel: 'qwen-plus' },
}

/**
 * 配音厂商在界面上的样子（1.1.1，#224）。
 *
 * 这份表和主进程 `ttsVendor.ts` 的 `VENDOR_SHAPES` 说的是同一件事的两半：那一份决定请求怎么发，
 * 这一份决定界面怎么说。万一不同步，症状是「提示写得松、请求仍被正确拦下」，
 * 而不是放一个坏请求出去——拦与不拦的权力始终在 `ttsConfigProblem` 那边。
 * 名字与 `TTS_VENDOR_NAMES` 对齐（用户不认 `minimax` 这种 id），加一家两处都要动。
 *
 * `TTS_VENDOR_PRESETS` 里特意没有 openai 那一项：兼容接口是「一族」而不是一个厂商，很多人手上
 * 是自建网关或海外中转，点一下就把地址冲成 api.openai.com，等于把刚能用的那套弄坏。
 * 音色那两格举例只作提示用，不是清单——两家的系统音色表都写在对方文档里，应用不替你抄一份。
 */
const TTS_VENDOR_UI: Record<
  string,
  { label: string; voiceRequired: boolean; voiceExample: string }
> = {
  openai: { label: 'OpenAI 兼容接口', voiceRequired: false, voiceExample: 'alloy' },
  minimax: { label: 'MiniMax', voiceRequired: true, voiceExample: 'male-qn-qingse' },
  dashscope: { label: '阿里云百炼（CosyVoice）', voiceRequired: true, voiceExample: 'longanyang' },
}

/**
 * 磁盘上没这一项、或值认不出 → 按 OpenAI 兼容显示（与主进程 `normalizeTtsVendor` 同口径：
 * 判严只会让界面凭空换一家网关，或者一格下拉显示空白）。
 */
export function ttsVendorOf(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return TTS_VENDOR_UI[value] ? value : 'openai'
}

/** 这一家在界面上的说法（列表行、配音页横幅都要点名网关，光看模型名认不出是谁家） */
export function ttsVendorLabel(raw: unknown): string {
  return TTS_VENDOR_UI[ttsVendorOf(raw)].label
}

/** 这一家收不收音色：收的话「留空＝不发这一项」那句话就是谎话，得换成必填口径 */
export function ttsVendorNeedsVoice(raw: unknown): boolean {
  return TTS_VENDOR_UI[ttsVendorOf(raw)].voiceRequired
}

/** 音色那一格的举例值（只做占位提示，不是可选清单——两家的系统音色表都写在对方文档里） */
export function ttsVoiceExample(raw: unknown): string {
  return TTS_VENDOR_UI[ttsVendorOf(raw)].voiceExample
}

/**
 * 选中一家时连带填入的地址与模型（地址只填到域名根为止，后面的路径由主进程按厂商接）。
 * 模型名取自各家文档的当前示例：MiniMax 是 speech-2.8-hd 这一族，百炼是 cosyvoice-v3 这一族。
 */
const TTS_VENDOR_PRESETS: Record<string, { ttsApiBase: string; ttsModel: string }> = {
  minimax: { ttsApiBase: 'https://api.minimax.cn', ttsModel: 'speech-2.8-hd' },
  dashscope: { ttsApiBase: 'https://dashscope.aliyuncs.com', ttsModel: 'cosyvoice-v3-flash' },
}

export const PROFILE_CAP_SPEC: Record<ProfileCapability, ProfileCapSpec> = {
  asr: {
    listLabel: '云端转写方案',
    activity: '云端转写',
    titleKey: 'asrModel',
    baseKey: 'asrApiBase',
    fields: [
      {
        key: 'asrApiBase',
        label: 'API Base URL',
        kind: 'text',
        placeholder: 'https://api.openai.com',
        hint: '网关的接口地址；列表那一行显示的域名就是它',
      },
      { key: 'asrApiKey', label: 'API Key', kind: 'key' },
      {
        key: 'asrModel',
        label: '模型',
        kind: 'text',
        placeholder: 'whisper-1',
        hint: '转写接口要的模型名，建好后列表那一行显示的就是它',
      },
    ],
    introNew:
      '填这三格建一条云端转写方案。这里点「保存」当场写盘，右下角那颗「保存设置」与弹窗无关。',
    introEdit: '只改这一套的凭据，点「保存」当场写盘，别的那几套不动。',
    emptyHint:
      '一条都还没有：点下面「新建API接入」，填好三格点弹窗里的「保存」。第一条落盘就是当前使用的那一套。',
    credSummary: '地址、模型',
    panelNote:
      '弹窗里的「保存」当场写盘，「删除」也是当场、撤不回来；右下角那颗「保存设置」只管上面的模式与语言。',
    keyHintNew: KEY_HINT_NEW,
    keyHintEdit: '这一套还没有 Key：填一把，点「保存」才存进来',
  },

  ai: {
    listLabel: '云端校对方案',
    activity: 'AI 校对',
    titleKey: 'aiModel',
    baseKey: 'aiApiBase',
    fields: [
      {
        key: 'aiProvider',
        label: '服务商',
        kind: 'select',
        hint: '选一家会自动填入下面的接口地址和默认模型，改动了还能自己改回去',
        options: [
          { value: 'openai', label: 'OpenAI' },
          { value: 'deepseek', label: 'DeepSeek' },
          { value: 'qwen', label: '通义千问' },
          { value: 'custom', label: '自定义兼容接口' },
        ],
        fills: AI_PROVIDER_PRESETS,
      },
      {
        key: 'aiApiBase',
        label: 'API Base URL',
        kind: 'text',
        placeholder: 'https://api.openai.com',
        hint: 'OpenAI / DeepSeek / 通义千问兼容地址；列表那一行显示的域名就是它',
      },
      { key: 'aiApiKey', label: 'API Key', kind: 'key' },
      {
        key: 'aiModel',
        label: '模型',
        kind: 'text',
        placeholder: 'gpt-4o-mini',
        hint: '校对走的对话模型；列表那一行显示的就是它',
      },
    ],
    introNew:
      '填这四格建一条 AI 校对方案：这里点「保存」当场写盘。这一页没有别的保存按钮，右下角那颗在这档不会出现。',
    introEdit: '只改这一套的凭据，点「保存」当场写盘，别的那几套不动。',
    emptyHint:
      '一条都还没有：点下面「新建API接入」，填好服务商、接口地址、Key 和模型，点弹窗里的「保存」。第一条落盘就是当前使用的那一套。',
    credSummary: '服务商、地址、模型',
    panelNote:
      '弹窗里的「保存」当场写盘，「删除」也是当场、撤不回来；这一档的服务商、地址、Key、模型都住在弹窗里，所以这一页不设「保存设置」——没有面板字段可存。',
    keyHintNew: KEY_HINT_NEW,
    keyHintEdit: '这一套还没有 Key：填一把，点「保存」才存进来',
  },

  tts: {
    listLabel: '云端配音方案',
    activity: '云端配音',
    titleKey: 'ttsModel',
    baseKey: 'ttsApiBase',
    fields: [
      {
        key: 'ttsProvider',
        label: '厂商',
        kind: 'select',
        // 1.1.0 及更早建出来的方案磁盘上没有这一项，读出来是空串——那一档请求就是按 OpenAI 兼容发的，
        // 所以这一格必须显示成它，而不是留一格空白让用户以为「没选」
        fallback: 'openai',
        hint:
          '决定这次配音的请求长什么样。选 MiniMax／百炼会自动填入下面的接口地址和模型名（还能改回去）；选 OpenAI 兼容不动你已填的地址——那一档是一族接口，不是一个厂商。',
        options: [
          { value: 'openai', label: 'OpenAI 兼容接口' },
          { value: 'minimax', label: 'MiniMax' },
          { value: 'dashscope', label: '阿里云百炼（CosyVoice）' },
        ],
        fills: TTS_VENDOR_PRESETS,
      },
      {
        key: 'ttsApiBase',
        label: 'API Base URL',
        kind: 'text',
        // 占位举例跟着下拉的默认那一项（OpenAI 兼容）：另两家一选中就自动填上真地址，用不着举例
        placeholder: 'https://api.openai.com',
        hint:
          '只填到域名根为止，不用带版本号：后面的路径按上面的「厂商」接（OpenAI 兼容接 /v1/audio/speech，MiniMax 接 /v1/t2a_v2，百炼接 /api/v1/services/audio/tts/SpeechSynthesizer）。留空＝沿用「校对配置」的地址，只有 OpenAI 兼容那一档能这么省。',
      },
      { key: 'ttsApiKey', label: 'API Key', kind: 'key' },
      {
        key: 'ttsModel',
        label: '配音模型',
        kind: 'text',
        placeholder: 'tts-1',
        hint:
          '这一家音频接口的模型 id，和校对模型是两回事——把校对模型填在这里会得到一句「模型不存在」。各家型号以对方文档为准（MiniMax 形如 speech-2.8-hd，百炼形如 cosyvoice-v3-flash）。留空时配音不会启动。',
      },
      // 音色不在这一档（1.1.0）：一条方案＝厂商 + 地址 + Key + 模型这组凭据，而「这个模型能念哪些音色」
      // 由服务商说了算、各家字段还不一样，绑进方案就成了「你以为这套自带了 alloy」。它在配音页那一格。
    ],
    introNew:
      '填这四格建一条云端配音方案：先选厂商，接口地址与模型会自动填成这一家的常用值。这里点「保存」当场写盘，右下角那颗「保存设置」与弹窗无关。',
    introEdit: '只改这一套的凭据，点「保存」当场写盘，别的那几套不动。',
    emptyHint:
      '一条都还没有：点下面「新建API接入」，选好厂商、填好接口地址、Key 和配音模型，点弹窗里的「保存」。第一条落盘就是当前使用的那一套。',
    credSummary: '厂商、地址、配音模型',
    panelNote:
      '弹窗里的「保存」当场写盘，「删除」也是当场、撤不回来；右下角那颗「保存设置」只管上面的配音引擎。',
    keyHintNew: '填一把，跟着「保存」一起存进这一条；不填＝配音沿用「校对配置」里那把 Key',
    keyHintEdit: '留空＝沿用「校对配置」里已保存的那把 Key；填一把只给这一套用',
  },
}

/** 这一档密钥那格的扁平键名（跨 IPC 的三态补丁要用） */
export function keyFieldOf(cap: ProfileCapability): string {
  return PROFILE_CAP_SPEC[cap].fields.find((field) => field.kind === 'key')!.key
}

/** 域名那一格：接口地址是用户手填的，不能指望它能被 URL 解析（填了 `api.x.com` 也算合法） */
export function profileRowHost(cap: ProfileCapability, profile: ProfileView): string {
  const raw = (profile.values[PROFILE_CAP_SPEC[cap].baseKey] ?? '').trim()
  if (!raw) return '接口地址未填'
  return raw.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')
}

/** 行标题：模型名优先，没有模型才退回方案名（第一条建出来时模型可能还空着） */
export function profileRowTitle(cap: ProfileCapability, profile?: ProfileView, fallback = ''): string {
  return (profile?.values[PROFILE_CAP_SPEC[cap].titleKey] ?? '').trim() || profile?.name || fallback
}

/**
 * 把一条方案的字段读进弹窗草稿的 `fields`（密钥不在 `values` 里，跨 IPC 只带状态）。
 * 按表取而不是整份 spread：主进程那张表以后加一项、这里没加，界面上就少一格，
 * 而 spread 会把没人认领的键一路带到保存补丁里。
 */
export function fieldsOf(cap: ProfileCapability, values: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const field of PROFILE_CAP_SPEC[cap].fields) {
    if (field.kind === 'key') continue
    picked[field.key] = (values[field.key] ?? '').trim() || field.fallback || ''
  }
  return picked
}
