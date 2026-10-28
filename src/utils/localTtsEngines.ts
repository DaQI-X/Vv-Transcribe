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
 * 这里**没有音色名**。引擎加载后 /health 只报数量（2026-10-28 本机实测：VITS 5 个），
 * sherpa-onnx 的 sid 对应的说话人叫什么，上游仓库里那份表我没核对过——
 * 所以界面上只能出现「音色 1 … 音色 N」这种编号（编号从 1 起，底下的 sid 仍是 0-based），
 * 编不出也抄不来一串好听的名字。
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
 * 下拉里跟在档位名后面的那半句。两档缺件的出路不一样，不能共用一句：
 * VITS 缺了是「去按需组件下载」，Kokoro 缺了在本版是「这一版根本没发它的包」（指纹表已排 1.0.7）。
 * 把它们写成同一句「模型还没下载」，等于把用户领到一行点不动的按钮前面再让他自己发现。
 * 传进来的还是 undefined（组件状态没读回来）时不出字——那是「还没查到」，不是「查到了缺」。
 */
export function modelPresenceTag(id: string, present: boolean | undefined): string {
  if (present !== false) return ''
  return hasInAppDownload(id) ? '（模型还没下载）' : '（本版没有下载包）'
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
 * 本地音色（sid）的可选项。返回值仍是 0-based 的 sid（引擎收的就是这个），
 * 界面上的**显示**走 voiceSidLabel —— sherpa 从 0 数起，用户从 1 数起，这一层偏移只在这儿做一次。
 *
 * speakers 是「这一档有几个说话人」：引擎把模型读进内存后 /health 会报，没读进来时由主进程按
 * 那份钉死 sha256 的模型表回一个实测值。真还不知道时（Kokoro 那一档）它是 0，那时不能凭空造一串
 * 编号，就只给出「当前这一个 + 默认的 0」。
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
