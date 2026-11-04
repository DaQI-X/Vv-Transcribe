/**
 * 一挡能力的「方案」下拉（#222 第④步）：校对方式弹窗和字幕配音页共用这一个控件。
 * 转写首页原来也挂着一条，#222 重写第③步把它撤了——那一档的凭据只剩三项，「用哪一套」
 * 改成在设置的转写 Tab 里勾「当前使用」，首页不再留第二个入口。
 *
 * 它做的是**「设为当前使用」**，不是「这一次用哪套」：「云端还是本地」这种本轮任务怎么选的问题
 * 在第⑧步之后是全段值、不在任何一条方案里，而这一格从头到尾就没给选那一档（它决定花不花钱、
 * 要不要拉起本机进程）。做成当场覆盖等于把那扇关着的门从侧面推开（配音页那条尤其明显）。
 * 所以落盘、成功/失败话术全在 useProfileStore 一个动作里，这里只决定长什么样、什么时候不许按。
 *
 * 只有一套、或这一次列表没读出来时整块不出现：判断收在 switchableProfiles 一处，
 * 页面要拿它决定旁边那句话（配音页那条档位横幅）时也调同一个函数。
 * 这里不负责读列表——读挂在页面的 useProfiles 上：下拉在不出现时是压根不挂载的，
 * 让挂载决定读不读就成了先有鸡还是先有蛋（不读就一直看不见）。
 */
import type { CSSProperties } from 'react'
import { CAPABILITY_NOUN, profileRowTitle } from '@/utils/profileSpec'
import { switchableProfiles, useProfileStore } from '@/stores/useProfileStore'
import type { ProfileCapability } from '@/types/settingsProfile'

interface ProfileSwitchSelectProps {
  capability: ProfileCapability
  /** 页面在忙什么只有页面知道：正在跑的那一批用的是开跑时读好的那套，这时候不许再切 */
  disabled?: boolean
  /**
   * 配音那一条要顺带清空单次参数（云端模型与音色跟着方案走）并重读设置，
   * 所以它交进来的是自己那条链路；不给就走 store 里那个通用切换。
   */
  switchTo?: (profileId: string) => void | Promise<void>
  /** 两页容器各自的类名不同，外观由调用方给；不传就按设置页那套通用类 */
  className?: string
  labelClassName?: string
  style?: CSSProperties
}

export function ProfileSwitchSelect({
  capability,
  disabled = false,
  switchTo,
  className,
  labelClassName,
  style,
}: ProfileSwitchSelectProps) {
  const profiles = useProfileStore((s) => s.slice[capability].profiles)
  const profileId = useProfileStore((s) => s.slice[capability].profileId)
  const switching = useProfileStore((s) => s.switching[capability])
  const setProfile = useProfileStore((s) => s.setProfile)

  const options = switchableProfiles(profiles)
  if (!options) return null
  const noun = CAPABILITY_NOUN[capability]

  return (
    <label className={className ?? 'settings-form-group'} style={style}>
      <span className={labelClassName ?? 'settings-form-label'}>{noun}方案</span>
      <select
        className="settings-form-select"
        value={profileId}
        disabled={disabled || switching}
        onChange={(e) => {
          const picked = e.target.value
          if (switchTo) void switchTo(picked)
          else void setProfile(capability, picked)
        }}
      >
        {/* 「当前使用」为空是磁盘上合法的一档（#222 重写第②步起三档都允许）。没有它就没有
            和 `value=""` 对得上的项，浏览器会把第一项显示成选中——用户看到的是「tts-1 在用」，
            而这一档其实谁的凭据都没在用，点「开始配音」还会被拦下。
            disabled 让它只占位不可选：这一格做不出「把当前使用清掉」这件事，那动作在设置的编辑弹窗里。 */}
        {!profileId && (
          <option value="" disabled>
            没有当前使用的方案
          </option>
        )}
        {options.map((profile) => (
          // 念的是设置页那一行同一个名字（模型名优先，没模型才退方案名）：
          // 方案名建那条时按当时的模型落定、之后不跟着改，照 `name` 列就成了
          // 「设置里那一行写着 whisper-1，这里却写着 whisper-large-v3」的两个入口两种话
          <option key={profile.id} value={profile.id}>
            {profileRowTitle(capability, profile)}
          </option>
        ))}
      </select>
    </label>
  )
}
