/**
 * 校对方式选择弹窗
 * 只在配了校对模型时出现；没配 Key 时按钮直接走本地校对，不再拦一道「请先配置」
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Cpu, Sparkles, X } from 'lucide-react'

export type ProofreadMode = 'local' | 'ai'

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
}

export function ProofreadModeDialog({ onPick, onClose }: ProofreadModeDialogProps) {
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
            return (
              <button
                key={option.mode}
                className="proofread-option"
                onClick={() => onPick(option.mode)}
              >
                <span className="proofread-option__icon">
                  <Icon size={16} />
                </span>
                <span className="proofread-option__text">
                  <span className="proofread-option__title">
                    {option.title}
                    <span className="proofread-option__tag">{option.tag}</span>
                  </span>
                  <span className="proofread-option__desc">{option.description}</span>
                </span>
              </button>
            )
          })}
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
