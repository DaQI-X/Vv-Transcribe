/**
 * 「新建API接入／编辑API接入」弹窗（#222 重写第⑥步，只转写这一档）。
 *
 * 第⑤步把那三格凭据改成「点了才摊开」，可它们摊开还是挂在方案列表下面——接口地址、API Key、
 * 模型、那颗勾选、再加一句「正在新建」的说明，五块东西挤在同一屏里，用户说「堆在一起特别乱」。
 * 这一步把它们整个挪进弹窗：面板上只剩列表和那颗入口，弹窗里只有三格、一颗勾选、底部两个按钮。
 *
 * 弹窗的「保存」**当场写磁盘**（新建走 createProfile，编辑走 settings:save 只带这一条的字段），
 * 所以右下角那颗「保存设置」从此管不到转写的凭据——它写的只剩全局段那几项（模式 / 档位 / 语言）。
 * 这一条和校对／配音那两档「新建 / 改名 / 删除 / 设为当前使用当场落盘」是同一个口径。
 *
 * 点遮罩**不关窗**：这里装的是用户刚敲进去的地址和密钥，误点一下外面就全没了，
 * 而密钥从不过 IPC、关掉就再也回显不出来。收场只有三条路，每条都说得清：「取消」、右上角 X、Esc。
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { ApiKeyField } from '@/components/settings/ApiKeyField'
import type { KeyStatus } from '@/utils/readiness'

interface AsrProfileDialogProps {
  mode: 'new' | 'edit'
  apiBase: string
  apiKey: string
  model: string
  keyStatus: KeyStatus
  encryptable: boolean
  keyCleared: boolean
  /** 那颗勾选要不要出现：新建而列表本来就空时不出现——第一条落盘自动是当前使用的，给一颗能取消的勾是骗人 */
  showCurrentCheck: boolean
  isCurrent: boolean
  busy: boolean
  onApiBaseChange: (value: string) => void
  onApiKeyChange: (value: string) => void
  onModelChange: (value: string) => void
  onClearKey: () => void
  onCurrentChange: (value: boolean) => void
  onSave: () => void
  onCancel: () => void
}

export function AsrProfileDialog({
  mode,
  apiBase,
  apiKey,
  model,
  keyStatus,
  encryptable,
  keyCleared,
  showCurrentCheck,
  isCurrent,
  busy,
  onApiBaseChange,
  onApiKeyChange,
  onModelChange,
  onClearKey,
  onCurrentChange,
  onSave,
  onCancel,
}: AsrProfileDialogProps) {
  const isNew = mode === 'new'
  // 落盘在路上时三条收场全按死：这时候关掉，用户以为没存，其实磁盘上刚写了一半
  const close = () => {
    if (!busy) onCancel()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return createPortal(
    // 挡住外层遮罩的点击：React 的冒泡走组件树、不走 DOM 树，这个弹窗是挂在设置窗口的遮罩里
    // 渲染的，不拦一下就是「点弹窗外面」把整个设置窗口关掉——里面刚敲的地址和密钥跟着一起没。
    <div className="settings-overlay" onClick={(e) => e.stopPropagation()}>
      <div
        className="settings-modal asr-profile-dialog"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-modal__header">
          <span className="settings-modal__title">{isNew ? '新建API接入' : '编辑API接入'}</span>
          <button className="settings-modal__close" onClick={close} title="关闭" disabled={busy}>
            <X size={16} />
          </button>
        </div>

        <div className="settings-modal__body">
          <span className="settings-form-hint" style={{ display: 'block', marginBottom: 16 }}>
            {isNew
              ? '填这三格建一条云端转写方案。这里点「保存」当场写盘，右下角那颗「保存设置」与弹窗无关。'
              : '只改这一套的凭据，点「保存」当场写盘，别的那几套不动。'}
          </span>

          <div className="settings-form-group">
            <label className="settings-form-label">API Base URL</label>
            <input
              className="settings-form-input"
              value={apiBase}
              onChange={(e) => onApiBaseChange(e.target.value)}
              placeholder="https://api.openai.com"
              disabled={busy}
            />
            <span className="settings-form-hint">网关的接口地址；列表那一行显示的域名就是它</span>
          </div>

          <div className="settings-form-group">
            <label className="settings-form-label">API Key</label>
            <ApiKeyField
              value={apiKey}
              status={keyStatus}
              encryptable={encryptable}
              cleared={keyCleared}
              disabled={busy}
              saveLabel="保存"
              emptyHint={
                isNew
                  ? '填一把，跟着「保存」一起存进这一条；不填＝这条不带密钥'
                  : '这一套还没有 Key：填一把，点「保存」才存进来'
              }
              typedHint={
                isNew
                  ? '这一套还没建出来，磁盘上没有可替换的 Key——这把跟着新建一起存'
                  : undefined
              }
              onChange={onApiKeyChange}
              onClear={onClearKey}
            />
          </div>

          <div className="settings-form-group">
            <label className="settings-form-label">模型</label>
            <input
              className="settings-form-input"
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              placeholder="whisper-1"
              disabled={busy}
            />
            <span className="settings-form-hint">
              转写接口要的模型名，建好后列表那一行显示的就是它
            </span>
          </div>

          {showCurrentCheck && (
            <div className="settings-form-group">
              <label className="settings-form-check">
                <input
                  type="checkbox"
                  checked={isCurrent}
                  disabled={busy}
                  onChange={(e) => onCurrentChange(e.target.checked)}
                />
                {isNew ? '建好就设为当前使用' : '当前使用'}
              </label>
              <span className="settings-form-hint">
                {isNew
                  ? isCurrent
                    ? '建出来就接管云端转写，原来那条被顶掉——下次转写按这套计价'
                    : '不勾＝还是原来那条在跑，这套先建着'
                  : isCurrent
                    ? '云端转写按这一套走。取消勾选再保存，这一档会暂时没有当前使用的方案'
                    : '勾上再保存，云端转写才按这一套走'}
              </span>
            </div>
          )}
        </div>

        <div className="settings-modal__footer">
          <button type="button" className="settings-modal__cancel-btn" onClick={close} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="settings-modal__save-btn"
            onClick={onSave}
            disabled={busy}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
