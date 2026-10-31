/**
 * 校对方式选择弹窗
 * 只在配了校对模型时出现；没配 Key 时按钮直接走本地校对，不再拦一道「请先配置」
 *
 * 两套以上校对配置时，弹窗里再多一格「校对方案」下拉（#222 第④步）：这里正是「这一步用哪套」
 * 被问出口的时刻。它做的是「设为当前使用」，跟转写首页、配音页那两条同一个动作同一句话，
 * 不是「只有这一次用这套」——所以话术要写清切完是从下一次起效。
 * 结果页表头那一行放不下它：1400 宽的窗口里可用 806px，四个按钮加标题组已经用掉 673px，
 * 再塞一格下拉就把表头挤成两行了（实测表头 77 → 115px）。
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Cpu, Sparkles, X } from 'lucide-react'
import { ProfileSwitchSelect } from '@/components/settings/ProfileSwitchSelect'
import { switchableProfiles, useProfileStore } from '@/stores/useProfileStore'

export type ProofreadMode = 'local' | 'ai'

const AI_PROFILE_HINT =
  'AI 校对用的是当前这套校对配置（服务商、接口地址、Key、模型）。这里切的是「当前使用」那一套，切完从下一次校对起效；本地校对走词库和误听表，不吃这套配置'

const OPTIONS: Array<{
  mode: ProofreadMode
  icon: typeof Cpu
  title: string
  tag: string
  description: string
}> = [
  {
    mode: 'local',
    icon: Cpu,
    title: '本地校对',
    tag: '无需配置',
    description: '不联网、不消耗 Token。按常见同音误听表逐段修正并附词库释义；已上传参考稿时同时标出差异。',
  },
  {
    mode: 'ai',
    icon: Sparkles,
    title: 'AI 校对',
    tag: '少量 Token 消耗',
    description: '调用你在设置里配置的模型结合上下文逐句校对，速度取决于网络。',
  },
]

interface ProofreadModeDialogProps {
  onPick: (mode: ProofreadMode) => void
  onClose: () => void
  /**
   * 本地校对走的是中文误听表 + 中文词库，非中文素材不成立。
   * 这时把原因传进来：选项置灰并写明为什么，而不是悄悄少一个按钮让用户猜。
   */
  localUnavailableReason?: string
}

export function ProofreadModeDialog({ onPick, onClose, localUnavailableReason }: ProofreadModeDialogProps) {
  // 列表是结果页挂载时读好的（useProfiles），这里只取来判那一格长不长得成——
  // 分隔线和旁边那句话要跟下拉一起出现、一起消失，否则只有一套时弹窗里多空一道横线和一句没人问的话。
  const aiProfiles = useProfileStore((s) => s.slice.ai.profiles)
  const showProfileSwitch = !!switchableProfiles(aiProfiles)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal__header">
          <span className="settings-modal__title">选择校对方式</span>
          <button className="settings-modal__close" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="settings-modal__body">
          {OPTIONS.map((option) => {
            const Icon = option.icon
            const disabled = option.mode === 'local' && !!localUnavailableReason
            return (
              <button
                key={option.mode}
                className={`proofread-option ${disabled ? 'proofread-option--disabled' : ''}`}
                onClick={() => onPick(option.mode)}
                disabled={disabled}
                title={disabled ? localUnavailableReason : undefined}
              >
                <span className="proofread-option__icon">
                  <Icon size={16} />
                </span>
                <span className="proofread-option__text">
                  <span className="proofread-option__title">
                    {option.title}
                    <span className="proofread-option__tag">{disabled ? '仅支持中文' : option.tag}</span>
                  </span>
                  <span className="proofread-option__desc">
                    {disabled ? localUnavailableReason : option.description}
                  </span>
                </span>
              </button>
            )
          })}

          {/* 只有一套校对配置时整块不出现（含那道分隔线），弹窗跟原来一模一样 */}
          {showProfileSwitch && (
            <div className="proofread-dialog__profile">
              <ProfileSwitchSelect capability="ai" style={{ marginBottom: 0 }} />
              <span className="settings-form-hint">{AI_PROFILE_HINT}</span>
            </div>
          )}
        </div>

        <div className="settings-modal__footer proofread-dialog__footer">
          <span className="proofread-dialog__tip">校对只给出建议，改动仍由你逐条确认。</span>
          <button className="settings-modal__cancel-btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
