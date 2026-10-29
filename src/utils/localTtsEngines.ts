/**
 * 本地配音的档位表（渲染层用的显示名与音色编号）
 *
 * value 必须与主进程 services/localTtsEngine.ts 的 LOCAL_TTS_ENGINES 逐个相等：那边是白名单，
 * 认不出的值会被 normalizeLocalTtsEngine 换回默认档。界面把 id 原样传过去，所以这里写错一个字符
 * 不会报错，只会「用户选了 Kokoro、实际跑的是 VITS」——加一档时两边一起加。
 *
 * 显示名按 #264 的口径：括号里只写这两档能核实的差别——模型体积（VITS 135,454,939 B / Kokoro 426,573,262 B）
 * 和音色数（5 / 103）。不写「推荐中文 / 推荐英文」：那既替引擎定义了它没声明的语种边界（VITS 也能念英文，
 * 只是念得别扭），也不是用户选档时真正要权衡的东西。
 *
 * 这里**没有音色名**。引擎加载后 /health 只报数量（本机实测：VITS 5 个、Kokoro 103 个），
 * sherpa-onnx 的 sid 对应的说话人叫什么，上游仓库里那份表我没核对过——
 * 所以界面上只能出现「音色 1 … 音色 N」这种编号（编号从 1 起，底下的 sid 仍是 0-based），
 * 编不出也抄不来一串好听的名字。
 *
 * inAppDownload 抄的是主进程 services/ttsModelUpstream.ts 的 hasInAppModelDownload（那一档钉没钉
 * 上游指纹表，componentService 的 SPECS 按同一个位决定按需组件里那行的按钮）。主进程的状态接口
 * 里没有这一位，所以只能在这里跟着标；两档都钉了表之后这里全是 true，新增一档时别忘了同步——
 * 给一档标了 true 而表里没有，等于把用户领到一行按下去必失败的按钮前面。
 *
 * caveat 是这一档**用得起来才知道的坑**，只有一句的位置：配音页与设置页的那行提示。
 * Kokoro 那条是 2026-10-29 本机实测的：它的英文走词表逐词查，词表（lexicon-us-en.txt，17.8 万条）
 * 没有的词被直接跳过、不出声也不报错——一段 90 词的真实英文旁白里跳了 3 个（subtitles、SRT、VTT）。
 * 说清这件事是「先试听一句再整段」这条流程存在的理由，不写就等于让用户对着一条缺词的音轨找原因。
 */

/** 默认档：中文效果优先（拍板过的首发范围） */
export const LOCAL_TTS_DEFAULT_ENGINE = 'sherpa-onnx-vits-zh-ll'

export const LOCAL_TTS_ENGINE_OPTIONS: {
  value: string
  label: string
  inAppDownload: boolean
  caveat: string
}[] = [
  { value: 'sherpa-onnx-vits-zh-ll', label: 'VITS（体积小，音色支持少）', inAppDownload: true, caveat: '' },
  {
    value: 'kokoro-multi-lang-v1_1',
    label: 'Kokoro（体积大，音色支持多）',
    inAppDownload: true,
    caveat:
      'Kokoro 的英文按词表念：词表里没有的词（品牌名、缩写、部分复数形式）会被跳过，不出声也不报错。整段配音前先在页面里试听一句。',
  },
]

export function localTtsEngineLabel(id: string): string {
  return LOCAL_TTS_ENGINE_OPTIONS.find((option) => option.value === id)?.label ?? id
}

export function hasInAppDownload(id: string): boolean {
  return LOCAL_TTS_ENGINE_OPTIONS.find((option) => option.value === id)?.inAppDownload === true
}

/** 这一档要提前告诉用户的那句坑；没坑的档位返回空串，调用处按「空就不出字」处理 */
export function localTtsEngineCaveat(id: string): string {
  return LOCAL_TTS_ENGINE_OPTIONS.find((option) => option.value === id)?.caveat ?? ''
}

/**
 * 下拉里跟在档位名后面的那半句。缺件时的出路按 inAppDownload 分叉：
 * 钉了指纹表的档是「去按需组件下载」，没钉的档在本版是「这一版根本没发它的包」。
 * 把它们写成同一句「模型还没下载」，等于把用户领到一行点不动的按钮前面再让他自己发现。
 * 传进来的还是 undefined（组件状态没读回来）时不出字——那是「还没查到」，不是「查到了缺」。
 */
export function modelPresenceTag(id: string, present: boolean | undefined): string {
  if (present !== false) return ''
  return hasInAppDownload(id) ? '（模型还没下载）' : '（本版没有下载包）'
}

/**
 * 缺这一档模型时该说的那句话（设置页的提示、配音页的拦截、拦截 toast 共用一处口径）。
 * 只有真能在按需组件里点下载的档才指那条路：没包的档把用户领到一行灰按钮前面
 * 再让他自己发现下不了，比一开始就说明白更糟。
 * 指的是行名：档位 label 与那一栏显示的标题是同一个字符串（主进程 COMPONENT_ROW_TITLES.models[].row），
 * 所以「去按需组件」要说得出口——用户点进去能在三行里认出哪一行是他选的档。
 */
export function missingModelHint(id: string): string {
  const label = localTtsEngineLabel(id)
  return hasInAppDownload(id)
    ? `「${label}」的模型还没下载——去「设置 → 关于与更新 → 按需组件」，在那一行点下载`
    : `「${label}」这一版没有应用内下载包——把本地模型换回 ${localTtsEngineLabel(LOCAL_TTS_DEFAULT_ENGINE)}，或改用云端档`
}

/**
 * 「设置 → 关于与更新 → 按需组件」里引擎那一行的标题。
 * 与主进程 electron/main/services/localTtsEngine.ts 的 COMPONENT_ROW_TITLES.engineBinary 同一个字符串：
 * 文案要点名「下哪一行」，点的就得是那一栏真显示出来的名字（改行名时两处一起改）。
 */
export const ENGINE_BINARY_ROW_NAME = '本地配音引擎'

/**
 * 引擎二进制不在场时该说的那句话（设置页的提示与配音页的拦截 toast 共用一处口径）。
 *
 * 模型那一位看的是代码里钉没钉上游指纹，引擎这一位看的是本版清单里有没有它——两个来源不同，
 * 但「答应了做不到」是同一种错：清单 404 的那一版，按需组件里引擎那行是收着按钮的，
 * 把人领过去只能让他自己发现下不了。所以 false 时不给下载入口，给的是换回云端档这条出路；
 * null（这一轮还没读过清单）才说「去检查清单」，且不替它答应下得到。
 */
export function missingBinaryHint(inManifest: boolean | null): string {
  if (inManifest === false) {
    return '这台机器上还没有引擎二进制，而这一版没有它的下载包——要现在就配音，请改用「云端接口」那一档'
  }
  if (inManifest === true) {
    return `这台机器上还没有引擎二进制，配音跑不起来——去「设置 → 关于与更新 → 按需组件」的「${ENGINE_BINARY_ROW_NAME}」那一行下载`
  }
  return `这台机器上还没有引擎二进制，配音跑不起来——去「设置 → 关于与更新 → 按需组件」点「检查清单」，再看「${ENGINE_BINARY_ROW_NAME}」那一行（本版有没有包，那一行会写明）`
}

/**
 * 「这一版到底有没有引擎的下载包」那半句括号里的补充，跟着清单会话缓存走三档。
 * 用在还没谈「缺不缺」的地方（配音引擎那一栏的说明）：那里用户只是在看两条路各要准备什么，
 * 但「去按需组件下载」这一句照样不能替他答应下得到。
 */
export function binaryManifestTag(inManifest: boolean | null): string {
  if (inManifest === false) return `这一版没有它的下载包，要现在就配音请用「云端接口」那一档`
  if (inManifest === true) return '这一版有它的下载包'
  return '本版有没有它的下载包，点那一栏的「检查清单」才知道'
}

/**
 * 本地音色（sid）的可选项。返回值仍是 0-based 的 sid（引擎收的就是这个），
 * 界面上的**显示**走 voiceSidLabel —— sherpa 从 0 数起，用户从 1 数起，这一层偏移只在这儿做一次。
 *
 * speakers 是「这一档有几个说话人」：引擎把模型读进内存后 /health 会报，没读进来时由主进程按
 * 那份钉死 sha256 的模型表回一个实测值（VITS 5、Kokoro 103，都是本机跑出来的）。
 * 万一某档回 0（那是「还不知道」，不是「只有一个」），不能凭空造一串编号，
 * 就只给出「当前这一个 + 默认的 0」。
 */
export function voiceSidOptions(speakers: number, current = ''): string[] {
  if (speakers > 0) return Array.from({ length: speakers }, (_, sid) => String(sid))
  const saved = /^\d+$/.test(current.trim()) ? current.trim() : ''
  return saved && saved !== '0' ? ['0', saved] : ['0']
}

/** sid 在界面上的那一行叫什么：sid 0 就是「音色 1」 */
export function voiceSidLabel(sid: string): string {
  return `音色 ${(Number(sid) || 0) + 1}`
}
