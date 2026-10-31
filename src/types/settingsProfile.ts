/**
 * 多套配置（#222）的前端数据结构。
 * 与 electron/preload/index.d.ts 的同名类型对齐：跨 IPC 的边界只有那一份声明，
 * 组件里各写一份会各自漂移。
 */

/** 三档能力：转写 / 校对 / 字幕配音，各自一套方案列表 */
export type ProfileCapability = 'asr' | 'ai' | 'tts'

/**
 * 一条方案的脱敏形状。`values` 用的键名是界面上那 17 个扁平名（asrProvider /
 * ttsLocalEngine / …），和 getSettings 的脱敏视图同一套，所以「切到另一套方案」
 * 就是把这一份盖到表单身上，渲染层不需要再存一份字段对照表。
 * 密钥的键名也不在里面：表单里那一格永远从空开始（留空＝不修改）。
 */
export interface ProfileView {
  id: string
  name: string
  values: Record<string, string>
  keyStatus: 'none' | 'encrypted' | 'plaintext' | 'unreadable'
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
