/**
 * 多套配置（#222）的前端数据结构。
 * 与 electron/preload/index.d.ts 的同名类型对齐：跨 IPC 的边界只有那一份声明，
 * 组件里各写一份会各自漂移。
 */

/** 三档能力：转写 / 校对 / 字幕配音，各自一套方案列表 */
export type ProfileCapability = 'asr' | 'ai' | 'tts'

/**
 * 一条方案的脱敏形状。`values` 用的键名是界面上那套扁平名（asrApiBase / ttsLocalEngine / …），
 * 和 getSettings 的脱敏视图同一套，所以「切到另一套方案」
 * 就是把这一份盖到表单身上，渲染层不需要再存一份字段对照表。
 * 转写这一档此刻是厂商 / 地址 / Key / 模型，讯飞那一档另加 AppID：模式、本地档位、转写语言
 * 是全局段，跟着 `settings:get` 那份视图走，不在任何一条方案里。
 * 密文（apiKey、讯飞那把 apiSecret）的键名也不在 `values` 里：表单里那两格永远从空开始
 * （留空＝不修改），跨 IPC 只带状态位。
 */
export interface ProfileView {
  id: string
  name: string
  values: Record<string, string>
  keyStatus: 'none' | 'encrypted' | 'plaintext' | 'unreadable'
  /**
   * apiKey 之外那几把密文的状态，键名同样是扁平名（此刻只有 `asrApiSecret`）。
   * 没有第二把密文的那几档是空对象。为什么不并进 keyStatus：那一位三档都在读，
   * 改成一张表等于让校对与配音凭空多一层。
   */
  secretStatus: Record<string, 'none' | 'encrypted' | 'plaintext' | 'unreadable'>
}

/**
 * 新建一条方案的入参（与 electron/preload/index.d.ts 的同名类型对齐）。
 * `values` 是界面此刻表单上的凭据——点「新建一套」要的是「把这几项存成一条方案」，
 * 所以以它为准；`fromProfileId` 只决定没给的那些字段照谁复制。
 */
export interface ProfileCreatePayload {
  name?: string
  /** 省略＝照该档当前那条复制；给 id＝照那条；空串＝一条全空白（连 Key 都不带） */
  fromProfileId?: string
  values?: Record<string, string>
  /** 建完设为当前使用；该档原本一条都没有时不用给，第一条自动是它 */
  setDefault?: boolean
}

/**
 * 三档的方案列表 + 每档当前用哪条 + 上限。
 * 整个返回值为 null＝连列表都没读出来，界面不许按「一条都没有」显示，
 * 那句话会把用户已有的方案说成不存在。
 */
export interface ProfilesView {
  profiles: Record<ProfileCapability, ProfileView[]>
  defaultProfileId: Record<ProfileCapability, string>
  maxProfiles: number
  storageProblem: string | null
}

/** 增删改的回执：error 非 null＝这次没写进磁盘；profiles 是磁盘此刻的样子（可能为 null） */
export interface ProfilesResult {
  profiles: ProfilesView | null
  error: string | null
}
