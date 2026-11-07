/**
 * 声音复刻弹窗（#330、#346；#347 从配音页左列挪进来；#349 补进度，并把这一趟改成「选完录音就往下走」）。
 *
 * 为什么是弹窗：复刻那一块摊开有六块东西（起名、选录音、两条规则、这一趟打到哪几条地址、
 * 单独指定地址、那颗按钮），配音页左列装不下——先是「开始配音」被挤扁，改成整列一起滚之后，
 * 滚到一半又有一行字被底边切成半截。而复刻本身是「拿自己一把嗓子换一把音色」的一次性动作，
 * 不是这一页的主线。挪进弹窗后左列高度不再被它撑起来。
 *
 * 只有当前那家真支持时才有人进来（父层按 `ttsVendorClonesVoices` 把关）：`clone: null` 的两家
 * 连入口都不给——摆一个点了注定失败的按钮，比不给按钮更糟。
 *
 * 「这一趟打到」那一行是这块的要害（#346）：复刻用的端点与配音那条不是同一条，而界面上原本
 * 只有配音地址可看，用户对着一个只转发配音路径的网关根本猜不出失败在哪。这里摆的是主进程算出来的
 * 那几条，旁边那颗「改地址」只作用于这一次、不落盘。
 *
 * 2026-11-07 用户实测之后改的四件事（原话是「上传完了没反应、不知道下一步要做什么，这个体验非常不好」）：
 * - 那颗按钮不再因为缺项而 `disabled`：缺项时点击被默默吞掉，界面上什么都不发生，
 *   store 里那两句判据因此一直是死代码。现在只有真在跑的时候才禁用。
 * - 「新音色 ID」那一格不再要用户自己想名字：选完录音由主进程按这一家的规则填一个建议值，想改再改。
 *   用户原本的理解一直是「选完录音，框里就该出现东西」，而这一格偏偏是全程唯一一件对方没要求、
 *   我们却把负担挪给用户的事——名字填错，换回的是 120 秒之后一句被拒。
 * - 两步按 1／2 编号摆出来，「下一步做什么」写进结构，不再靠一段说明文字。
 * - 成功后**不关窗**，把回执里那个 id 摆在这扇窗里；正在跑时摆进度。关掉不会取消——请求在主进程，
 *   `cloning` 还在，重新打开看得见。
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, AudioLines, CheckCircle2, Loader2, X } from 'lucide-react'
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
  const cloneResult = useVoiceStudioStore((s) => s.cloneResult)
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
  const vendorLabel = ttsVendorLabel(vendor)
  const showEndpointInput = editingEndpoint || cloneEndpoint !== ''
  const done = cloneResult !== ''

  /** 「下一步」只说一句；正在跑与跑完了各有自己那一块，不再重复念 */
  const nextStep =
    cloning || done
      ? ''
      : cloneFile === ''
        ? '先点「选一段录音」挑一个文件。'
        : '点右下角「开始复刻」，录音这会儿才发出去。'

  const submit = async () => {
    await runVoiceClone()
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
          <div className="voice-clone__step">
            <span className="voice-clone__step-no">1</span>
            <div className="voice-clone__step-body">
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
              <p className="voice-studio__hint">{`这一步只挑文件，还没有发出去。音频要求：${spec.audioRule}。`}</p>
            </div>
          </div>

          <div className="voice-clone__step">
            <span className="voice-clone__step-no">2</span>
            <label className="voice-studio__field">
              <span className="voice-studio__label">{spec.nameLabel}</span>
              <input
                className="settings-form-input"
                type="text"
                value={cloneName}
                placeholder={cloning ? '' : spec.nameExample}
                onChange={(e) => setCloneName(e.target.value)}
                disabled={cloning}
              />
              <p className="voice-studio__hint">{`第 1 步选完录音，这里自动填一个，想改就改。${spec.nameRule}。`}</p>
            </label>
          </div>

          {nextStep && <p className="voice-clone__next">{nextStep}</p>}

          {cloning && (
            <p className="voice-clone__pending">
              <Loader2 size={14} className="animate-spin" />
              <span>
                {`正在「${vendorLabel}」那边建这把音色，` +
                  (spec.twoStep ? '先把录音传上去换一个文件号，再拿它建音色。' : '录音跟着请求一起发过去。') +
                  '可能要几十秒，最长 2 分钟。关掉这扇窗不会取消它。'}
              </span>
            </p>
          )}

          {done && (
            <div className="voice-clone__done">
              <CheckCircle2 size={16} />
              <div>
                <span>
                  建好了，音色 id 是 <code>{cloneResult}</code>
                </span>
                <span className="voice-studio__hint">
                  已经填进配音页那格「音色」，直接用就行。
                </span>
              </div>
            </div>
          )}

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
            {`建好的音色留在「${vendorLabel}」的账号里，本应用删不掉，只能去对方控制台删。`}
          </p>
        </div>

        <div className="settings-modal__footer">
          <button className="settings-modal__cancel-btn" onClick={onClose}>
            {done ? '关闭' : '取消'}
          </button>
          {/* 不因为缺项而禁用：那等于把「你还差一步」这句话咽下去，用户只看到一个点不动的按钮 */}
          <button
            className="settings-modal__save-btn"
            onClick={() => void (done ? onClose() : submit())}
            disabled={cloning}
          >
            {cloning ? '复刻中…' : done ? '知道了' : '开始复刻'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
