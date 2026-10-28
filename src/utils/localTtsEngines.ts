/**
 * 本地配音的档位表（渲染层用的显示名与音色编号）
 *
 * value 必须与主进程 services/localTtsEngine.ts 的 LOCAL_TTS_ENGINES 逐个相等：那边是白名单，
 * 认不出的值会被 normalizeLocalTtsEngine 换回默认档。界面把 id 原样传过去，所以这里写错一个字符
 * 不会报错，只会「用户选了 Kokoro、实际跑的是 VITS」——加一档时两边一起加。
 *
 * 显示名按 #239 的口径：不替引擎定义「中文模型/英文模型」（VITS 也能念英文，只是念得别扭），
 * 只标推荐语种。
 *
/**
 * 这里**没有音色名**。引擎加载后 /health 只报数量（2026-10-28 本机实测：VITS 5 个），
 * sherpa-onnx 的 sid 对应的说话人叫什么，上游仓库里那份表我没核对过——
 * 所以界面上只能出现「音色 0 … 音色 N-1」这种编号，编不出也抄不来一串好听的名字。
 *
 * inAppDownload 抄的是主进程 services/ttsModelUpstream.ts 的 hasInAppModelDownload（那一档钉没钉
 * 上游指纹表，componentService 的 SPECS 按同一个位决定按需组件里那行的按钮）。主进程的状态接口
 * 里没有这一位，所以只能在这里跟着标；给 Kokoro 补上指纹表时，把这里改成 true。
 * 它只影响一句话：缺模型时能不能说「去按需组件下载」——答应了做不到比不答应更糟。
 */

/** 默认档：中文效果优先（拍板过的首发范围） */
export const LOCAL_TTS_DEFAULT_ENGINE = 'sherpa-onnx-vits-zh-ll'

export const LOCAL_TTS_ENGINE_OPTIONS: { value: string; label: string; inAppDownload: boolean }[] =
  [
    { value: 'sherpa-onnx-vits-zh-ll', label: 'VITS（推荐中文）', inAppDownload: true },
    { value: 'kokoro-multi-lang-v1_1', label: 'Kokoro（推荐英文）', inAppDownload: false },
  ]

export function localTtsEngineLabel(id: string): string {
  return LOCAL_TTS_ENGINE_OPTIONS.find((option) => option.value === id)?.label ?? id
}

export function hasInAppDownload(id: string): boolean {
  return LOCAL_TTS_ENGINE_OPTIONS.find((option) => option.value === id)?.inAppDownload === true
}

/**
 * 缺这一档模型时该说的那句话（设置页的提示、配音页的拦截、拦截 toast 共用一处口径）。
 * 只有真能在按需组件里点下载的档才指那条路：Kokoro 本版没有包，把用户领到一行灰按钮前面
 * 再让他自己发现下不了，比一开始就说明白更糟。
 */
export function missingModelHint(id: string): string {
  const label = localTtsEngineLabel(id)
  return hasInAppDownload(id)
    ? `${label}的模型还没下载，去「设置 → 关于与更新 → 按需组件」下载它`
    : `${label}这一版没有应用内下载包——把本地模型换回 VITS，或改用云端档`
}

/**
 * 本地音色（sid）的可选项。
 * speakers 是引擎加载后 /health 报的数量；模型还没进内存时它是 0，那时不能凭空造一串编号，
 * 就只给出「当前这一个 + 默认的 0」，并在旁边说清列表要等引擎起来才全。
 */
export function voiceSidOptions(speakers: number, current = ''): string[] {
  if (speakers > 0) return Array.from({ length: speakers }, (_, sid) => String(sid))
  const saved = /^\d+$/.test(current.trim()) ? current.trim() : ''
  return saved && saved !== '0' ? ['0', saved] : ['0']
}
