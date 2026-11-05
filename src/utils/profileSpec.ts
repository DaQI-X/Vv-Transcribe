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
        key: 'ttsApiBase',
        label: 'API Base URL',
        kind: 'text',
        placeholder: '留空＝沿用「校对配置」的地址',
        hint:
          '填了就用这条地址，请求打在它后面接 /v1/audio/speech。配音和校对可以是两家不同的网关——校对那家不一定有音频接口，这里留空只是省事。',
      },
      { key: 'ttsApiKey', label: 'API Key', kind: 'key' },
      {
        key: 'ttsModel',
        label: '配音模型',
        kind: 'text',
        placeholder: 'tts-1',
        hint:
          '音频接口的模型 id，和校对模型是两回事——把校对模型填在这里会得到一句「模型不存在」。留空时配音不会启动。',
      },
      // 音色不在这一档（1.1.0）：一条方案＝地址 + Key + 模型这组凭据，而「这个模型能念哪些音色」
      // 由服务商说了算、各家字段还不一样，绑进方案就成了「你以为这套自带了 alloy」。它在配音页那一格。
    ],
    introNew:
      '填这三格建一条云端配音方案。这里点「保存」当场写盘，右下角那颗「保存设置」与弹窗无关。',
    introEdit: '只改这一套的凭据，点「保存」当场写盘，别的那几套不动。',
    emptyHint:
      '一条都还没有：点下面「新建API接入」，填好接口地址、Key 和配音模型，点弹窗里的「保存」。第一条落盘就是当前使用的那一套。',
    credSummary: '地址、配音模型',
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
    picked[field.key] = values[field.key] ?? ''
  }
  return picked
}
