/**
 * 声音复刻弹窗（#330、#346；#347 从配音页左列挪进来）。
 *
 * 为什么是弹窗：复刻那一块摊开有六块东西（起名、选录音、两条规则、这一趟打到哪几条地址、
 * 单独指定地址、那颗按钮），配音页左列装不下——先是「开始配音」被挤扁，改成整列一起滚之后，
 * 滚到一半又有一行字被底边切成半截。而复刻本身是「拿自己一把嗓子换一把音色」的一次性动作，
 * 不是这一页的主线，用完就关掉。挪进弹窗后左列高度不再被它撑起来。
 *
 * 只有当前那家真支持时才有人进来（父层按 `ttsVendorClonesVoices` 把关）：`clone: null` 的两家
 * 连入口都不给——摆一个点了注定失败的按钮，比不给按钮更糟。
 *
 * 「这一趟打到」那一行是这块的要害（#346）：复刻用的端点与配音那条不是同一条，而界面上原本
 * 只有配音地址可看，用户对着一个只转发配音路径的网关根本猜不出失败在哪。这里摆的是主进程算出来的
 * 那几条，旁边那颗「改地址」只作用于这一次、不落盘。
 *
 * 成功后关掉这扇窗：回执里的音色 id 已经填进配音页那格「音色」（`runVoiceClone` 做的），
 * 窗里再摆一份是第二个出处。关掉也不会取消正在跑的复刻——请求在主进程，`cloning` 还在，
 * 重新打开看得见进度。
 *
 * 点遮罩不关窗：这里装着用户刚起的名字和刚选的录音路径，误点一下外面就全没了。
 * 收场只有三条路：「取消」、右上角 X、Esc。
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, AudioLines, X } from 'lucide-react'
import { useVoiceStudioStore } from '@/stores/useVoiceStudioStore'
import { ttsCloneSpec, ttsVendorLabel } from '@/utils/profileSpec'

interface VoiceCloneDialogProps {
  vendor: string
  onClose: () => void
}

export function VoiceCloneDialog({ vendor, onClose }: VoiceCloneDialogProps) {
  const [editingEndpoint, setEditingEndpoint] = useState(false)
  const spec = ttsCloneSpec(vendor)
  const cloneFile = useVoiceStudioStore((s) => s.cloneFile)
  const cloneName = useVoiceStudioStore((s) => s.cloneName)
  const cloning = useVoiceStudioStore((s) => s.cloning)
  const cloneError = useVoiceStudioStore((s) => s.cloneError)
  const cloneEndpoint = useVoiceStudioStore((s) => s.cloneEndpoint)
  const cloneTargets = useVoiceStudioStore((s) => s.cloneTargets)
  const setCloneName = useVoiceStudioStore((s) => s.setCloneName)
  const setCloneEndpoint = useVoiceStudioStore((s) => s.setCloneEndpoint)
  const pickCloneAudio = useVoiceStudioStore((s) => s.pickCloneAudio)
  const runVoiceClone = useVoiceStudioStore((s) => s.runVoiceClone)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!spec) return null

  /** 只显示文件名：完整路径是主进程读的，摆在界面上除了长没别的作用 */
  const fileName = cloneFile.split(/[\\/]/).pop() || cloneFile
  const ready = cloneFile !== '' && cloneName.trim() !== '' && !cloning
  const vendorLabel = ttsVendorLabel(vendor)
  const showEndpointInput = editingEndpoint || cloneEndpoint !== ''

  const submit = async () => {
    if (await runVoiceClone()) onClose()
  }

  return createPortal(
    <div className="settings-overlay" onClick={(e) => e.stopPropagation()}>
      <div className="settings-modal voice-clone-dialog">
        <div className="settings-modal__header">
          <span className="settings-modal__title">声音复刻</span>
          <button className="settings-modal__close" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="settings-modal__body">
          <div className="voice-studio__clone-row">
            <label className="voice-studio__field">
              <span className="voice-studio__label">{spec.nameLabel}</span>
              <input
                className="settings-form-input"
                type="text"
                value={cloneName}
                placeholder={spec.nameExample}
                onChange={(e) => setCloneName(e.target.value)}
                disabled={cloning}
              />
            </label>

            <div className="voice-studio__clone-pick">
              <button
                className="settings-modal__cancel-btn"
                onClick={() => void pickCloneAudio()}
                disabled={cloning}
              >
                <AudioLines size={14} />
                {cloneFile ? '换一个文件' : '选一段录音'}
              </button>
              {cloneFile && <code title={cloneFile}>{fileName}</code>}
            </div>
          </div>

          <p className="voice-studio__hint">
            {`${spec.nameLabel}：${spec.nameRule}。`}
            {`音频：${spec.audioRule}。`}
            {/* 这句不能省：这一家本机确实没发过一次真复刻请求，界面上一句「验证过」都是谎话 */}
            {'这条链路照原厂规范写，本机没发过一次真复刻请求，所以被拒时这里摆的是接口原话。'}
          </p>

          <div className="voice-studio__clone-endpoints">
            <span className="voice-studio__label">这一趟打到</span>
            {cloneTargets.length === 0 ? (
              <span className="voice-studio__hint">还没推导出地址，去配音配置里填上接口地址</span>
            ) : (
              cloneTargets.map((url) => <code key={url}>{url}</code>)
            )}
            <button className="voice-studio__link" onClick={() => setEditingEndpoint((value) => !value)}>
              {showEndpointInput ? '收起' : cloneEndpoint ? '改地址' : '地址不对？改一个'}
            </button>
          </div>

          {showEndpointInput && (
            <>
              <input
                className="settings-form-input"
                type="text"
                value={cloneEndpoint}
                placeholder="复刻接口地址，留空＝用上面那条"
                onChange={(e) => setCloneEndpoint(e.target.value)}
                disabled={cloning}
              />
              <p className="voice-studio__hint">
                默认拿配音方案那一格的域名根去接复刻路径。网关只转发配音那条、或那一格留空时，这里单独填一个；只作用于这一次，不写回设置。
              </p>
            </>
          )}

          {cloneError && (
            <p className="voice-studio__clone-error">
              <AlertTriangle size={13} />
              {cloneError}
            </p>
          )}

          <p className="voice-studio__hint">
            {`建好的 id 会填回配音页那格「音色」，不写回设置；音色本身留在「${vendorLabel}」的账号里，本应用删不掉，只能去对方控制台删。`}
            {cloning ? '复刻进行中，关掉这扇窗不会取消它。' : ''}
          </p>
        </div>

        <div className="settings-modal__footer">
          <button className="settings-modal__cancel-btn" onClick={onClose}>
            取消
          </button>
          <button className="settings-modal__save-btn" onClick={() => void submit()} disabled={!ready}>
            {cloning ? (spec.twoStep ? '上传录音并复刻中…' : '复刻中…') : '开始复刻'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
