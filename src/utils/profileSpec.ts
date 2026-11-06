/**
 * 三档「云端方案」那张字段表（#222 重写第⑧步，列表与弹窗都从它渲染）。
 *
 * 第⑥步之前，「这一档有哪几格、每格叫什么、下面那句说明是什么」写死在面板的 JSX 里，
 * 转写换成「列表 + 弹窗」时又在两个组件里各抄了一份。这一步校对／配音接同一套 UI，
 * 再抄第三份就是「改一处要改两处」——所以收到这一处，组件只管按表画。
 *
 * 键名用的是跨 IPC 那套扁平名（asrApiBase / aiProvider / ttsModel …），与主进程
 * `settingsSchema.CAPABILITY_FIELDS` 一一对应：「这一档进方案的到底是哪几项」只有那一张表说了算，
 * 这里补的只是界面才需要的东西（标题、占位、说明、下拉连带填什么或清空什么）。
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
  /**
   * 灰字举例跟着别的格换算时才用（配音那两格跟着「厂商」变）。
   * 只影响 placeholder，永远不往 draft 里写值——预填的问题是它会被当成用户填的存下去。
   */
  placeholderFrom?: (fields: Record<string, string>) => string
  hint?: string
  options?: ProfileFieldOption[]
  /** 选中某项时连带填入的其他格：换服务商就是换一家网关，地址与默认模型跟着换 */
  fills?: Record<string, Record<string, string>>
  /**
   * 选中某项时连带**清空**的其他格（含密钥那格，弹窗按 `keyFieldOf` 认出来）。
   * 和 `fills` 是相反的决定：这一家的地址、Key、模型名只有对方文档说了算，
   * 我们填进去的每一个值都可能被用户当成「已经配好了」直接点保存，
   * 而猜错的地址比空格子难发现——空格子会被当场拦下，猜错的地址要跑到失败才说话。
   */
  clears?: string[]
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
 * 后面那四个 `*Example` 只做灰字举例与句子里的「形如」，**永不写进方案**（1.1.1 拍板：换厂商时
 * 地址/Key/模型清空而不是预填）。三样都以对方文档为当前口径，我们的作用是把形状念出来，
 * 不是替各家保一份最新清单——清单会过期，用户照着过期清单填出来的东西照样失败，但责任看起来在我们。
 */
const TTS_VENDOR_UI: Record<
  string,
  {
    label: string
    voiceRequired: boolean
    voiceExample: string
    /** 「测试连接」在界面没带音色时补的那一个，空串＝这一家没有实测过的值可补（与主进程 VENDOR_SHAPES 同一份，见 tests/ttsVendor.test.ts 的对账） */
    probeVoice: string
    apiBaseExample: string
    modelExample: string
  }
> = {
  openai: {
    label: 'OpenAI 兼容接口',
    voiceRequired: false,
    voiceExample: 'alloy',
    probeVoice: '',
    apiBaseExample: 'https://api.openai.com',
    modelExample: 'tts-1',
  },
  minimax: {
    label: 'MiniMax',
    voiceRequired: true,
    voiceExample: 'male-qn-qingse',
    probeVoice: 'male-qn-qingse',
    apiBaseExample: 'https://api.minimax.cn',
    modelExample: 'speech-2.8-hd',
  },
  dashscope: {
    label: '阿里云百炼（CosyVoice）',
    voiceRequired: true,
    voiceExample: 'longanyang',
    // 这个举例值没发过一次真请求（本机没有百炼的 Key），所以自检不能拿它当默认值——
    // 界面上那句话因此要说「这一页测不了这一家」，而不是替用户点一次注定被拒的合成
    probeVoice: '',
    apiBaseExample: 'https://dashscope.aliyuncs.com',
    modelExample: 'cosyvoice-v3-flash',
  },
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

/**
 * 「测试连接」在界面没带音色时能补的那一个（与主进程 `ttsVendorProbeVoice` 同一份值，
 * tests/ttsVendor.test.ts 里对账）。空串＝这一家没有实测过的音色可补，那句提示要说
 * 「这一页测不了这一家，去配音页试听」，不能写成「自检会用某某音色合成」——那是谎话。
 */
export function ttsVendorProbeVoice(raw: unknown): string {
  return TTS_VENDOR_UI[ttsVendorOf(raw)].probeVoice
}

/** 音色那一格的举例值（只做占位提示，不是可选清单——两家的系统音色表都写在对方文档里） */
export function ttsVoiceExample(raw: unknown): string {
  return TTS_VENDOR_UI[ttsVendorOf(raw)].voiceExample
}

/** 地址那格的灰字举例：跟着「厂商」那一格变，所以选中 MiniMax 时不会再挂着 api.openai.com */
export function ttsApiBaseExample(raw: unknown): string {
  return TTS_VENDOR_UI[ttsVendorOf(raw)].apiBaseExample
}

/** 配音模型那格的灰字举例（同上，只说形状，落盘的值仍以用户填的为准） */
export function ttsModelExample(raw: unknown): string {
  return TTS_VENDOR_UI[ttsVendorOf(raw)].modelExample
}

/**
 * 转写厂商在界面上的样子（1.1.1，#224 转写侧）。和配音那一份一样，这一张只管「界面怎么说、
 * 灰字举什么例」，请求形状由主进程 `asr/asrVendor.ts` 说了算；两边不同步的症状仍是
 * 「提示写得松、请求照样被正确拦下」，而不是发坏请求。
 *
 * 只有两家：阿里百炼的录音文件识别**本版没接**。它不收本机音频，要先有一个公网可访问的音频 URL，
 * 再走「提交任务 → 轮询任务 → 下载结果 JSON」那条异步链路，而官方给「本机文件换临时 URL」的
 * 那条通道自己写着「请勿用于生产环境」（48 小时过期、上传凭证 100 QPS 不可扩容）。
 * 与其在下拉里挂一个「选了大概率失败」的选项，不如先不列它——这一格不许说做不到的小事。
 */
const ASR_VENDOR_UI: Record<
  string,
  { label: string; apiBaseExample: string; modelExample: string }
> = {
  openai: {
    label: 'OpenAI 兼容接口',
    apiBaseExample: 'https://api.openai.com',
    modelExample: 'whisper-1',
  },
  minimax: {
    label: 'MiniMax',
    apiBaseExample: 'https://api.minimax.cn',
    modelExample: 'asr-1.0',
  },
}

/** 认不出的一律按 OpenAI 兼容显示（与主进程 `normalizeAsrVendor` 同口径） */
export function asrVendorOf(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return ASR_VENDOR_UI[value] ? value : 'openai'
}

/** 这一家在界面上的说法（列表行与转写页横幅都要点名网关，光看模型名认不出是谁家） */
export function asrVendorLabel(raw: unknown): string {
  return ASR_VENDOR_UI[asrVendorOf(raw)].label
}

export function asrApiBaseExample(raw: unknown): string {
  return ASR_VENDOR_UI[asrVendorOf(raw)].apiBaseExample
}

export function asrModelExample(raw: unknown): string {
  return ASR_VENDOR_UI[asrVendorOf(raw)].modelExample
}

export const PROFILE_CAP_SPEC: Record<ProfileCapability, ProfileCapSpec> = {
  asr: {
    listLabel: '云端转写方案',
    activity: '云端转写',
    titleKey: 'asrModel',
    baseKey: 'asrApiBase',
    fields: [
      {
        key: 'asrVendor',
        label: '厂商',
        kind: 'select',
        // 1.1.1 之前建出来的方案磁盘上没有这一项，读出来是空串；不显示成 OpenAI 兼容那一档，
        // 界面就是一格空白，而主进程那边正按它发请求
        fallback: 'openai',
        hint:
          '决定这次转写的请求长什么样。换一家的下面三格（接口地址、API Key、模型）会一起清空，不替你猜值——灰字只是举例。这一版可选的是 OpenAI 兼容与 MiniMax；阿里云百炼的转写没收（它只吃公网音频地址，还要走任务轮询），校对里那家「通义千问」管的是文字，转写接不上。',
        options: [
          { value: 'openai', label: 'OpenAI 兼容接口' },
          { value: 'minimax', label: 'MiniMax' },
        ],
        clears: ['asrApiBase', 'asrApiKey', 'asrModel'],
      },
      {
        key: 'asrApiBase',
        label: 'API Base URL',
        kind: 'text',
        placeholderFrom: (fields) => asrApiBaseExample(fields.asrVendor),
        hint:
          '网关的接口地址，填到域名根为止就行（后面的路径按上面的「厂商」接）；照对方文档粘完整端点也认，打的就是你填的这一条。列表那一行显示的域名就是它。留空时按 OpenAI 的官方地址发——只有 OpenAI 兼容那一档能这么省，换成 MiniMax 时空着多半就是 404/401。',
      },
      { key: 'asrApiKey', label: 'API Key', kind: 'key' },
      {
        key: 'asrModel',
        label: '模型',
        kind: 'text',
        placeholderFrom: (fields) => asrModelExample(fields.asrVendor),
        hint:
          '转写接口要的模型名，建好后列表那一行显示的就是它。各家型号以对方文档为准（OpenAI 兼容形如 whisper-1，MiniMax 是 asr-1.0）；留空时按这一家的默认档发。',
      },
    ],
    introNew:
      '填这四格建一条云端转写方案：先选厂商，再按对方文档填地址、Key 和模型（选厂商会把这三格清空，不替你猜值）。这里点「保存」当场写盘，右下角那颗「保存设置」与弹窗无关。',
    introEdit: '只改这一套的凭据，点「保存」当场写盘，别的那几套不动。',
    emptyHint:
      '一条都还没有：点下面「新建API接入」，选好厂商、填好接口地址、Key 和模型，点弹窗里的「保存」。第一条落盘就是当前使用的那一套。',
    credSummary: '厂商、地址、模型',
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
          '决定这次配音的请求长什么样。换一家的下面三格（接口地址、API Key、配音模型）会一起清空，不替你猜值——这一家的地址和模型名只有对方文档说了算，猜错的地址要等请求失败才说话，空格子当场就拦得住。灰字只是举例。',
        options: [
          { value: 'openai', label: 'OpenAI 兼容接口' },
          { value: 'minimax', label: 'MiniMax' },
          { value: 'dashscope', label: '阿里云百炼（CosyVoice）' },
        ],
        clears: ['ttsApiBase', 'ttsApiKey', 'ttsModel'],
      },
      {
        key: 'ttsApiBase',
        label: 'API Base URL',
        kind: 'text',
        // 举例跟着上面的厂商：三家的网关根各不相同，挂一个 api.openai.com 在 MiniMax 那一档下面
        // 就是让界面说一句和下拉相反的话
        placeholderFrom: (fields) => ttsApiBaseExample(fields.ttsProvider),
        hint:
          '填到域名根为止就行，不用带版本号：后面的路径按上面的「厂商」接（OpenAI 兼容接 /v1/audio/speech，MiniMax 接 /v1/t2a_v2，百炼接 /api/v1/services/audio/tts/SpeechSynthesizer）；照对方文档粘整条端点也认，此时打的就是你填的这一条。留空＝沿用「校对配置」的地址，只有 OpenAI 兼容那一档能这么省。',
      },
      { key: 'ttsApiKey', label: 'API Key', kind: 'key' },
      {
        key: 'ttsModel',
        label: '配音模型',
        kind: 'text',
        placeholderFrom: (fields) => ttsModelExample(fields.ttsProvider),
        hint:
          '这一家音频接口的模型 id，和校对模型是两回事——把校对模型填在这里会得到一句「模型不存在」。各家型号以对方文档为准（MiniMax 形如 speech-2.8-hd，百炼形如 cosyvoice-v3-flash）。留空时配音不会启动。',
      },
      // 音色不在这一档（1.1.0）：一条方案＝厂商 + 地址 + Key + 模型这组凭据，而「这个模型能念哪些音色」
      // 由服务商说了算、各家字段还不一样，绑进方案就成了「你以为这套自带了 alloy」。它在配音页那一格。
    ],
    introNew:
      '填这四格建一条云端配音方案：先选厂商，再按对方文档填地址、Key 和配音模型（选厂商会把这三格清空，不替你猜值）。这里点「保存」当场写盘，右下角那颗「保存设置」与弹窗无关。',
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
