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
  /**
   * 同一句话在不同厂商下不是同一件事实时才用（配音模型：三家必填、豆包不收）。
   * 与 `placeholderFrom` 同一个约束：只说界面，不写值。
   *
   * 返回 undefined＝「这一家没有特别要交代的」，弹窗据此落回上面那句静态 `hint`
   * （转写的 API Key 就是这种：只有讯飞那档要提醒「它不是 AppID 也不是 APISecret」）。
   */
  hintFrom?: (fields: Record<string, string>) => string | undefined
  options?: ProfileFieldOption[]
  /**
   * 这一格在什么条件下才出现。收的是整份 draft.fields，所以判据可以跟着「厂商」那一格走。
   *
   * 用它的理由是「看不见＝改不了」的反面：**这一家根本没有这一项**时，摆一格出来只会让人
   * 往一个没人读的格子里填值（填了还不落盘，因为请求形状里压根没有这一项）。
   * 判据与主进程那两张 `*_VENDOR_RESOURCE_ID` 表同源，`tests/*Vendor.test.ts` 各有对账。
   */
  visibleWhen?: (fields: Record<string, string>) => boolean
  /** 选中某项时连带填入的其他格：换服务商就是换一家网关，地址与默认模型跟着换 */
  fills?: Record<string, Record<string, string>>
  /**
   * 选中某项时连带**清空**的其他格（含密文那几格，弹窗按 `secretFieldsOf` 认出来）。
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
  /**
   * 密文那格（`kind: 'key'`）自己的「这一套还没有」说法，新建与编辑各一句。
   * 不给就用这一档那一份（`keyHintNew` / `keyHintEdit`）。只有第二把密文才用得上——
   * 讯飞那格 APISecret 说「这一套还没有 Key」是句错话，它不是 Key，用途也完全不同
   * （只用来算 HMAC，一个字节都不发出去）。
   */
  secretHintNew?: string
  secretHintEdit?: string
}

export interface ProfileCapSpec {
  /** 列表那一栏的标题 */
  listLabel: string
  /** 这一档活儿的叫法，句子里说的是「谁会被拦下」 */
  activity: string
  /** 行标题取哪一格（模型名） */
  titleKey: string
  /**
   * 行标题按厂商改取哪一格。只有「这一家压根没有模型那一格」时才用得上（讯飞，1.1.2 #343）：
   * 不换的话每一条讯飞方案的行标题都落回方案名「默认」，三条方案在列表上一模一样，
   * 用户认不出自己点的是哪一条。AppID 是这一家里唯一还能区分彼此、又不是密钥的那一格。
   */
  titleKeyFrom?: (fields: Record<string, string>) => string
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
    /** 这一家不收空模型（与主进程 VENDOR_SHAPES.modelRequired 同一份，见 tests/ttsVendor.test.ts 的对账） */
    modelRequired: boolean
    voiceExample: string
    /** 「测试连接」在界面没带音色时补的那一个，空串＝这一家一个有出处的值都没有、那颗按钮不硬测（与主进程 VENDOR_SHAPES 同一份，见 tests/ttsVendor.test.ts 的对账） */
    probeVoice: string
    apiBaseExample: string
    modelExample: string
    /** 厂商提供的系统音色列表页 URL；空串＝这一家没有公开清单，界面上不挂链接 */
    voiceListUrl: string
    /** 「资源编号」那格的灰字举例；空串＝这一家没有这一项，那一格整个不出现 */
    resourceIdExample: string
  }
> = {
  openai: {
    label: 'OpenAI 兼容接口',
    voiceRequired: false,
    modelRequired: true,
    voiceExample: 'alloy',
    probeVoice: '',
    apiBaseExample: 'https://api.openai.com',
    modelExample: 'tts-1',
    voiceListUrl: '',
    resourceIdExample: '',
  },
  minimax: {
    label: 'MiniMax',
    voiceRequired: true,
    modelRequired: true,
    voiceExample: 'male-qn-qingse',
    probeVoice: 'male-qn-qingse',
    apiBaseExample: 'https://api.minimax.cn',
    modelExample: 'speech-2.8-hd',
    voiceListUrl: 'https://platform.minimax.cn/docs/faq/system-voice-id',
    resourceIdExample: '',
  },
  dashscope: {
    label: '阿里云百炼（CosyVoice）',
    voiceRequired: true,
    modelRequired: true,
    voiceExample: 'longanyang',
    // 这个举例值没发过一次真请求（本机没有百炼的 Key），所以自检不能拿它当默认值——
    // 界面上那句话因此要说「这一页测不了这一家」，而不是替用户点一次注定被拒的合成
    probeVoice: '',
    apiBaseExample: 'https://dashscope.aliyuncs.com',
    modelExample: 'cosyvoice-v3-flash',
    voiceListUrl: 'https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list',
    resourceIdExample: '',
  },
  // 豆包这一档同样**没本机实测过**（手上没有豆包语音的 Key），按 #224 拍板先照原厂规范设计、后验。
  // probeVoice 用的是官方 2.0 音色表里的 vivi 2.0（`zh_female_vv_uranus_bigtts`），
  // 它和 resourceIdExample 那个 `seed-tts-2.0` 得成对：拿 1.0 的音色配 2.0 的资源号，
  // 对方回的是一句同时提到音色和资源号的「mismatched」，用户看不出自己哪一格错了
  volc: {
    label: '豆包（火山引擎）',
    voiceRequired: true,
    // 唯一不收模型的一家：原厂写 `req_params.model`「仅当 speaker 为复刻音色时需指定」，
    // 给系统音色发过去回的是 45000001 InvalidModel
    modelRequired: false,
    voiceExample: 'zh_female_vv_uranus_bigtts',
    probeVoice: 'zh_female_vv_uranus_bigtts',
    apiBaseExample: 'https://openspeech.bytedance.com',
    // 灰字写的是「复刻音色才填」那一条，而不是替系统音色猜一个 model 名
    modelExample: 'seed-tts-2.0-standard',
    voiceListUrl: 'https://www.volcengine.com/docs/6561/1257544',
    resourceIdExample: 'seed-tts-2.0',
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

/** 这一家不收空模型：豆包那一家反过来——它的「配音模型」只给复刻音色用，说「留空就不启动」是谎话 */
export function ttsVendorNeedsModel(raw: unknown): boolean {
  return TTS_VENDOR_UI[ttsVendorOf(raw)].modelRequired
}

/** 「资源编号」那一格画不画（与主进程 `TTS_VENDOR_RESOURCE_ID` 同源，tests/ttsVendor.test.ts 对账） */
export function ttsVendorWantsResourceId(raw: unknown): boolean {
  return TTS_VENDOR_UI[ttsVendorOf(raw)].resourceIdExample !== ''
}

/** 资源编号那格的灰字举例，也就是这一家留空时发出去的那个值 */
export function ttsResourceIdExample(raw: unknown): string {
  return TTS_VENDOR_UI[ttsVendorOf(raw)].resourceIdExample
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

/** 厂商提供的系统音色列表页 URL；空串＝这一家没有公开清单 */
export function ttsVoiceListUrl(raw: unknown): string {
  return TTS_VENDOR_UI[ttsVendorOf(raw)].voiceListUrl
}

/**
 * 转写厂商在界面上的样子（1.1.1，#224 转写侧）。和配音那一份一样，这一张只管「界面怎么说、
 * 灰字举什么例」，请求形状由主进程 `asr/asrVendor.ts` 说了算；两边不同步的症状仍是
 * 「提示写得松、请求照样被正确拦下」，而不是发坏请求。
 *
 * 豆包与阿里百炼的转写**本版都不接**，两家卡在同一个地方：它们不收本机音频，
 * 要先有一个公网可访问的音频 URL，再走「提交任务 → 轮询任务 → 下载结果 JSON」那条异步链路
 * （豆包在架那一版的 `audio.url` 是必填项，文档里已经没有把音频塞进请求体的写法）。
 * 而官方给「本机文件换临时 URL」的那条通道自己写着「请勿用于生产环境」（48 小时过期、上传凭证
 * 100 QPS 不可扩容）。与其在下拉里挂一个「选了大概率失败」的选项，不如先不列它——
 * 这一格不许说做不到的小事。豆包的**配音**照旧收（它那条链路一次 POST 就给音频），
 * 所以下拉里在配音那一档看得到豆包、在这一档看不到，不是漏了。
 *
 * 讯飞（1.1.2，#343）是这三家里唯一收下的「异步」一家：它上传的是**裸音频字节**，
 * 不需要先把本机文件换成一个公网 URL，所以「上传换订单号 → 轮询取结果」这条链路本机能走完。
 * 代价是两处：它单独一个适配文件（`asr/iflytekAsr.ts`，签名每趟现算），界面上多两格凭据
 * （AppID + APISecret）而少一格模型。**这一家本机没有凭据、一次真请求都没发过**，
 * 所以下拉里选得到它，但任何文案都不许说它验证过。
 */
const ASR_VENDOR_UI: Record<
  string,
  {
    label: string
    apiBaseExample: string
    modelExample: string
    /** 这一家收不收「模型」那一格：讯飞那条链路没有模型参数，摆一格等于让人往没人读的地方填值 */
    wantsModel: boolean
    /** 这一家还要 AppID + APISecret 两格：它的签名要三样凭据，少一样就是 100009 */
    wantsAppCredentials: boolean
    /**
     * 「转写语言」那一格对这一家有没有用。讯飞只收 `autodialect` / `autominor`，
     * Whisper 那套短码（zh/en/ja）发过去是一条 100020「语言验证失败」，所以适配层钉死了
     * `autodialect`——界面上必须说清这一格对它无效，否则用户会把一次方言识别失败算到语言头上。
     */
    languageApplies: boolean
    /**
     * 这一家走「上传换订单号 → 轮询取结果」那条异步链路（与主进程 `asrVendorUsesOrderFlow` 同一份，
     * `tests/asrVendor.test.ts` 里对账）。界面上要按它分叉两句话：自检不是「点完就出结论」
     * （最长等 3 分钟），真转写时进度条会停在「已提交，等对方出结果」那一段。
     */
    orderFlow: boolean
  }
> = {
  openai: {
    label: 'OpenAI 兼容接口',
    apiBaseExample: 'https://api.openai.com',
    modelExample: 'whisper-1',
    wantsModel: true,
    wantsAppCredentials: false,
    languageApplies: true,
    orderFlow: false,
  },
  minimax: {
    label: 'MiniMax',
    apiBaseExample: 'https://api.minimax.cn',
    modelExample: 'asr-1.0',
    wantsModel: true,
    wantsAppCredentials: false,
    languageApplies: true,
    orderFlow: false,
  },
  // 1.1.2（#343）新接的一家，也是这三家里唯一「上传换订单号再轮询」的异步接口。
  // **本机没有这一家的凭据，一次真请求都没发过**：形状全部抄自原厂文档，所以这里一个
  // 「实测能用」的默认值都不给，界面上也不许说这一家验证过。
  iflytek: {
    label: '讯飞（录音文件转写大模型版）',
    apiBaseExample: 'https://office-api-ist-dx.iflyaisol.com',
    modelExample: '',
    wantsModel: false,
    wantsAppCredentials: true,
    languageApplies: false,
    orderFlow: true,
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

/** 「模型」那一格画不画（与主进程 `ASR_VENDOR_DEFAULT_MODEL` 里空串那几家同源） */
export function asrVendorWantsModel(raw: unknown): boolean {
  return ASR_VENDOR_UI[asrVendorOf(raw)].wantsModel
}

/** AppID 与 APISecret 那两格画不画（与主进程 `asrVendorUsesOrderFlow` 同源，tests/asrVendor.test.ts 对账） */
export function asrVendorWantsAppCredentials(raw: unknown): boolean {
  return ASR_VENDOR_UI[asrVendorOf(raw)].wantsAppCredentials
}

/** 面板上「转写语言」那格要不要说「对这一家无效」 */
export function asrVendorLanguageApplies(raw: unknown): boolean {
  return ASR_VENDOR_UI[asrVendorOf(raw)].languageApplies
}

/**
 * 这一家是不是「提交后要等」的那条异步链路。界面上两处要按它分叉：自检那句
 * （不是点完就出结论，最长等 3 分钟）与真转写时进度条那一段的说明。
 */
export function asrVendorIsAsync(raw: unknown): boolean {
  return ASR_VENDOR_UI[asrVendorOf(raw)].orderFlow
}

export const PROFILE_CAP_SPEC: Record<ProfileCapability, ProfileCapSpec> = {
  asr: {
    listLabel: '云端转写方案',
    activity: '云端转写',
    titleKey: 'asrModel',
    titleKeyFrom: (fields) => (asrVendorWantsModel(fields.asrVendor) ? 'asrModel' : 'asrAppId'),
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
          '决定这次转写的请求长什么样。换一家的下面几格（接口地址、凭据、模型）会一起清空，不替你猜值——灰字只是举例。这一版可选 OpenAI 兼容、MiniMax 与讯飞。讯飞是「上传音频换订单号、再轮询取结果」的异步接口，收 5 小时以内的长音频，但要三样凭据（AppID / APIKey / APISecret）且没有模型那一格。豆包和阿里云百炼的转写都没收，它们只吃「公网可访问的音频地址」，本机文件换不到一个能递给对方的地址（官方那条换临时地址的通道自己写着「请勿用于生产环境」）。豆包的配音是收的，在配音那一档里。校对里那家「通义千问」管的是文字，转写接不上。',
        options: [
          { value: 'openai', label: 'OpenAI 兼容接口' },
          { value: 'minimax', label: 'MiniMax' },
          { value: 'iflytek', label: '讯飞（录音文件转写大模型版）' },
        ],
        clears: ['asrApiBase', 'asrApiKey', 'asrModel', 'asrAppId', 'asrApiSecret'],
      },
      {
        key: 'asrApiBase',
        label: 'API Base URL',
        kind: 'text',
        placeholderFrom: (fields) => asrApiBaseExample(fields.asrVendor),
        // 「留空按 OpenAI 的官方地址发」这句对讯飞是假话：那一档留空时主进程**不会**拿别家的地址
        // 替它发（那等于把用户的音频 POST 到一个他没选过的服务商去），而是直接判云端不可用
        hintFrom: (fields) =>
          asrVendorWantsAppCredentials(fields.asrVendor)
            ? '这一家的接口地址，填到域名根为止就行（后面的 /v2/upload 与 /v2/getResult 由应用自己接）；照对方文档粘完整端点也认，打的就是你填的这一条。这一格不能留空：留空时应用不会拿别家的地址替它发，云端转写直接不可用、落回本地引擎。列表那一行显示的域名就是它。'
            : '网关的接口地址，填到域名根为止就行（后面的路径按上面的「厂商」接）；照对方文档粘完整端点也认，打的就是你填的这一条。列表那一行显示的域名就是它。留空时按 OpenAI 的官方地址发——只有 OpenAI 兼容那一档能这么省，换成 MiniMax 时空着多半就是 404/401。',
      },
      {
        key: 'asrAppId',
        label: 'AppID',
        kind: 'text',
        // 只有讯飞的签名要它：另两家请求里没有这一层，摆一格等于让人往没人读的地方填值
        visibleWhen: (fields) => asrVendorWantsAppCredentials(fields.asrVendor),
        hint:
          '讯飞开放平台那个应用的 APPID（形如 12345678）。它不是密钥——签名与请求参数里都要带上它，所以按明文存。要和下面两把是「同一个应用」的，串着用得到的是一句 100009「签名校验不通过」。',
      },
      {
        key: 'asrApiKey',
        label: 'API Key',
        kind: 'key',
        hintFrom: (fields) =>
          asrVendorWantsAppCredentials(fields.asrVendor)
            ? '讯飞控制台里那把 APIKey——它在请求参数里叫 accessKeyId。它不是 AppID，也不是下面那把 APISecret，三样填串了得到的都是同一句签名不通过。'
            : undefined,
      },
      {
        key: 'asrApiSecret',
        label: 'APISecret',
        kind: 'key',
        visibleWhen: (fields) => asrVendorWantsAppCredentials(fields.asrVendor),
        secretHintNew: '填一把，跟着「保存」一起存进这一条；不填＝这条没有 APISecret，讯飞的转写跑不起来',
        secretHintEdit: '这一套还没有 APISecret：填一把，点「保存」才存进来',
        hint:
          '讯飞控制台里那把 APISecret，只用来算这一趟请求的签名，一个字节都不会发出去（所以它和 API Key 一样加密存）。少了它，对方回的是 100009「签名校验不通过」。',
      },
      {
        key: 'asrModel',
        label: '模型',
        kind: 'text',
        // 讯飞那条链路没有模型这一层：它的请求参数表里压根没有这个字段
        visibleWhen: (fields) => asrVendorWantsModel(fields.asrVendor),
        placeholderFrom: (fields) => asrModelExample(fields.asrVendor),
        hint:
          '转写接口要的模型名，建好后列表那一行显示的就是它。各家型号以对方文档为准（OpenAI 兼容形如 whisper-1，MiniMax 是 asr-1.0）；留空时按这一家的默认档发。',
      },
    ],
    introNew:
      '建一条云端转写方案：先选厂商，再按对方文档填接口地址、Key 和模型（选厂商会把这几格清空，不替你猜值；选了讯飞会多出 AppID 与 APISecret 两格、少掉模型那一格）。这里点「保存」当场写盘，右下角那颗「保存设置」与弹窗无关。',
    introEdit: '只改这一套的凭据，点「保存」当场写盘，别的那几套不动。',
    emptyHint:
      '一条都还没有：点下面「新建API接入」，选好厂商、填好接口地址、Key 和模型，点弹窗里的「保存」。第一条落盘就是当前使用的那一套。',
    credSummary: '厂商、地址、模型（讯飞那一档是 AppID）',
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
          '决定这次配音的请求长什么样。换一家的下面几格（接口地址、API Key、配音模型，豆包还多一格资源编号）会一起清空，不替你猜值——这一家的地址和模型名只有对方文档说了算，猜错的地址要等请求失败才说话，空格子当场就拦得住。灰字只是举例。',
        options: [
          { value: 'openai', label: 'OpenAI 兼容接口' },
          { value: 'minimax', label: 'MiniMax' },
          { value: 'dashscope', label: '阿里云百炼（CosyVoice）' },
          { value: 'volc', label: '豆包（火山引擎）' },
        ],
        clears: ['ttsApiBase', 'ttsApiKey', 'ttsModel', 'ttsResourceId'],
      },
      {
        key: 'ttsApiBase',
        label: 'API Base URL',
        kind: 'text',
        // 举例跟着上面的厂商：四家的网关根各不相同，挂一个 api.openai.com 在 MiniMax 那一档下面
        // 就是让界面说一句和下拉相反的话
        placeholderFrom: (fields) => ttsApiBaseExample(fields.ttsProvider),
        hint:
          '填到域名根为止就行，不用带版本号：后面的路径按上面的「厂商」接（OpenAI 兼容接 /v1/audio/speech，MiniMax 接 /v1/t2a_v2，百炼接 /api/v1/services/audio/tts/SpeechSynthesizer，豆包接 /api/v3/tts/unidirectional）；照对方文档粘整条端点也认，此时打的就是你填的这一条。留空＝沿用「校对配置」的地址，只有 OpenAI 兼容那一档能这么省。',
      },
      { key: 'ttsApiKey', label: 'API Key', kind: 'key' },
      {
        key: 'ttsModel',
        label: '配音模型',
        kind: 'text',
        placeholderFrom: (fields) => ttsModelExample(fields.ttsProvider),
        // 这一句在豆包那一档是假话：它的 req_params.model 只给复刻音色用，系统音色留空才是对的
        hintFrom: (fields) =>
          ttsVendorNeedsModel(fields.ttsProvider)
            ? '这一家音频接口的模型 id，和校对模型是两回事——把校对模型填在这里会得到一句「模型不存在」。各家型号以对方文档为准（MiniMax 形如 speech-2.8-hd，百炼形如 cosyvoice-v3-flash）。留空时配音不会启动。'
            : '豆包只有「声音复刻」的音色才需要模型名，用系统音色时留空即可——填了反而可能被回一句 InvalidModel。复刻音色形如 seed-tts-2.0-standard。',
      },
      {
        key: 'ttsResourceId',
        label: '资源编号',
        kind: 'text',
        // 只有豆包收这一项（X-Api-Resource-Id）：另三家请求里没有这一层，摆一格等于让人往没人读的地方填值
        visibleWhen: (fields) => ttsVendorWantsResourceId(fields.ttsProvider),
        placeholderFrom: (fields) => ttsResourceIdExample(fields.ttsProvider),
        hintFrom: (fields) =>
          `豆包用它选「哪一版配音服务」，得和配音页那个音色同一版才对得上。留空按 ${ttsResourceIdExample(fields.ttsProvider)} 发；系统音色配 seed-tts-2.0，复刻音色配 seed-icl-2.0。`,
      },
      // 音色不在这一档（1.1.0）：一条方案＝厂商 + 地址 + Key + 模型这组凭据，而「这个模型能念哪些音色」
      // 由服务商说了算、各家字段还不一样，绑进方案就成了「你以为这套自带了 alloy」。它在配音页那一格。
    ],
    introNew:
      '建一条云端配音方案：先选厂商，再按对方文档填接口地址、Key 和配音模型（选厂商会把这几格清空，不替你猜值；选了豆包会多出一格资源编号，且配音模型那格可以留空）。这里点「保存」当场写盘，右下角那颗「保存设置」与弹窗无关。',
    introEdit: '只改这一套的凭据，点「保存」当场写盘，别的那几套不动。',
    emptyHint:
      '一条都还没有：点下面「新建API接入」，选好厂商、填好接口地址、Key 和配音模型，点弹窗里的「保存」。第一条落盘就是当前使用的那一套。',
    credSummary: '厂商、地址、配音模型（豆包还有资源编号）',
    panelNote:
      '弹窗里的「保存」当场写盘，「删除」也是当场、撤不回来；右下角那颗「保存设置」只管上面的配音引擎。',
    keyHintNew: '填一把，跟着「保存」一起存进这一条；不填＝配音沿用「校对配置」里那把 Key',
    keyHintEdit: '留空＝沿用「校对配置」里已保存的那把 Key；填一把只给这一套用',
  },
}

/** 这一档密钥那格的扁平键名（跨 IPC 的三态补丁要用）。有两把密文的那一档指的是第一把（API Key） */
export function keyFieldOf(cap: ProfileCapability): string {
  return PROFILE_CAP_SPEC[cap].fields.find((field) => field.kind === 'key')!.key
}

/**
 * 这一档**所有**密文那几格的扁平键名。
 * 转写那一档此刻有两把（讯飞的 API Key + APISecret），校对与配音各一把。
 * 弹窗的草稿、保存时的三态补丁都按这张单子走——只认第一把的话，第二格填了也存不下去，
 * 而界面上它明明收得下字。
 */
export function secretFieldsOf(cap: ProfileCapability): string[] {
  return PROFILE_CAP_SPEC[cap].fields.filter((field) => field.kind === 'key').map((field) => field.key)
}

/**
 * 某一格密文在磁盘上的状态。
 *
 * 第一把走 `profile.keyStatus`、其余走 `profile.secretStatus[键名]`——这个不对称是主进程那边
 * 有意留的（`keyStatus` 三档都在读，改成一张表等于让校对与配音凭空多一层），所以收在这一处，
 * 组件里就不必各自判断「这一格是第几把」。
 */
export function secretStatusOf(
  cap: ProfileCapability,
  profile: ProfileView,
  fieldKey: string
): ProfileView['keyStatus'] {
  return fieldKey === keyFieldOf(cap)
    ? profile.keyStatus
    : profile.secretStatus?.[fieldKey] ?? 'none'
}

/** 某一格密文在界面上的叫法（toast 与删除确认要点名是哪一把，不能一律说「API Key」） */
export function secretLabelOf(cap: ProfileCapability, fieldKey: string): string {
  return PROFILE_CAP_SPEC[cap].fields.find((field) => field.key === fieldKey)?.label ?? fieldKey
}

/** 这一条方案真存了哪几把密文，按界面上的叫法念 */
export function savedSecretLabels(cap: ProfileCapability, profile?: ProfileView): string[] {
  if (!profile) return []
  return PROFILE_CAP_SPEC[cap].fields
    .filter((field) => field.kind === 'key')
    .filter((field) => secretStatusOf(cap, profile, field.key) !== 'none')
    .map((field) => field.label)
}

/** 域名那一格：接口地址是用户手填的，不能指望它能被 URL 解析（填了 `api.x.com` 也算合法） */
export function profileRowHost(cap: ProfileCapability, profile: ProfileView): string {
  const raw = (profile.values[PROFILE_CAP_SPEC[cap].baseKey] ?? '').trim()
  if (!raw) return '接口地址未填'
  return raw.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')
}

/**
 * 这一条的行标题该取哪一格。
 *
 * 默认是模型名，可讯飞那一档压根没有模型格（`visibleWhen` 把那一格藏了），照默认取会得到空串、
 * 一路退回方案名「默认」——三条方案在列表上长得一模一样。所以字段表允许按厂商改口（`titleKeyFrom`）。
 * 单独导出是因为「列表没读出来」时界面上还得念用户刚在弹窗里敲的那个值，
 * 那时手上只有 `draft.fields`、没有 `ProfileView`。
 */
export function titleKeyOf(cap: ProfileCapability, values: Record<string, string>): string {
  const spec = PROFILE_CAP_SPEC[cap]
  return spec.titleKeyFrom?.(values ?? {}) ?? spec.titleKey
}

/** 行标题：模型名优先，没有模型才退回方案名（第一条建出来时模型可能还空着） */
export function profileRowTitle(cap: ProfileCapability, profile?: ProfileView, fallback = ''): string {
  return (profile?.values[titleKeyOf(cap, profile?.values ?? {})] ?? '').trim() || profile?.name || fallback
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
