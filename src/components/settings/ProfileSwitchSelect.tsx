/**
 * 一挡能力的「方案」下拉（#222 第④步）：转写首页、转写结果页的校对那一格、字幕配音页共用这一个控件。
 *
 * 它做的是**「设为当前使用」**，不是「这一次用哪套」：一条方案里带着云端还是本地这一档，
 * 那一档决定花不花钱、要不要拉起本机进程，是用户保存过的长期选择，不该从单次任务旁边把门推开
 * （配音页那条尤其明显：把引擎做成当场覆盖，就等于绕过了「这一档要不要花钱」这道关）。
 * 所以落盘、成功/失败话术全在 useProfileStore 一个动作里，这里只决定长什么样、什么时候不许按。
 *
 * 只有一套、或这一次列表没读出来时整块不出现：判断收在 switchableProfiles 一处，
 * 页面要拿它决定旁边那句话（配音页那条档位横幅）时也调同一个函数。
 * 这里不负责读列表——读挂在页面的 useProfiles 上：下拉在不出现时是压根不挂载的，
 * 让挂载决定读不读就成了先有鸡还是先有蛋（不读就一直看不见）。
 */
import type { CSSProperties } from 'react'
import { CAPABILITY_NOUN } from './ProfileBar'
import { switchableProfiles, useProfileStore } from '@/stores/useProfileStore'
import type { ProfileCapability } from '@/types/settingsProfile'

interface ProfileSwitchSelectProps {
  capability: ProfileCapability
  /** 页面在忙什么只有页面知道：正在跑的那一批用的是开跑时读好的那套，这时候不许再切 */
  disabled?: boolean
  /**
   * 「名字」这一格怎么摆。配音页跟它旁边那些字段排成一列，所以竖排（标签在上）；
   * 首页和转写结果页那一行只有 38px 的位置，就横排（标签在左）。
   * 横排时标签那点下边距要抹掉，否则它在一条线上看着偏高。
   */
  layout?: 'stacked' | 'inline'
  /** 悬停在这格上时说什么：转写结果页那一行放不下第二行小字，口径只能挂在 tooltip 上 */
  title?: string
  /**
   * 配音那一条要顺带清空单次参数（模型、音色、本地引擎都跟着方案走）并重读设置，
   * 所以它交进来的是自己那条链路；不给就走 store 里那个通用切换。
   */
  switchTo?: (profileId: string) => void | Promise<void>
  /** 三页容器各自的类名不同，外观由调用方给；不传就按设置页那套通用类 */
  className?: string
  labelClassName?: string
  style?: CSSProperties
}

export function ProfileSwitchSelect({
  capability,
  disabled = false,
  layout = 'stacked',
  title,
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
  const inline = layout === 'inline'

  return (
    <label
      className={className ?? 'settings-form-group'}
      style={
        inline
          ? { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 0, ...style }
          : style
      }
    >
      <span
        className={labelClassName ?? 'settings-form-label'}
        style={inline ? { marginBottom: 0, whiteSpace: 'nowrap' } : undefined}
      >
        {noun}方案
      </span>
      <select
        className="settings-form-select"
        style={inline ? { width: 'auto', flex: '0 1 auto', minWidth: 120 } : undefined}
        value={profileId}
        title={title}
        disabled={disabled || switching}
        onChange={(e) => {
          const picked = e.target.value
          if (switchTo) void switchTo(picked)
          else void setProfile(capability, picked)
        }}
      >
        {options.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
    </label>
  )
}
