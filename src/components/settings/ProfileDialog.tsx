/**
 * 「新建API接入／编辑API接入」弹窗（#222 重写第⑥步做在转写上，第⑧步收成三档共用）。
 *
 * 第⑤步把那几格凭据改成「点了才摊开」，可它们摊开还是挂在方案列表下面——接口地址、API Key、
 * 模型、那颗勾选、再加一句「正在新建」的说明，五块东西挤在同一屏里，用户说「堆在一起特别乱」。
 * 第⑥步把它们整个挪进弹窗：面板上只剩列表和那颗入口。第⑧步校对／配音接同一套时，
 * 「这一档有哪几格」已经收在 `PROFILE_CAP_SPEC` 里，这个组件按表画，不再为某一档写特例。
 *
 * 弹窗的「保存」**当场写磁盘**（新建走 createProfile，编辑走 settings:save 只带这一条的字段），
 * 所以右下角那颗「保存设置」从此管不到任何一档的凭据——它写的只剩全局段那几项
 * （转写的模式／档位／语言，配音的引擎／本地模型，以及换本地模型时一并复位的默认音色编号；
 * 校对一档本来就没有全局字段）。
 * 这和「新建 / 删除 / 设为当前使用当场落盘」是同一个口径。
 *
 * 点遮罩**不关窗**：这里装的是用户刚敲进去的地址和密钥，误点一下外面就全没了，
 * 而密钥从不过 IPC、关掉就再也回显不出来。收场只有三条路，每条都说得清：「取消」、右上角 X、Esc。
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { ApiKeyField } from '@/components/settings/ApiKeyField'
import { PROFILE_CAP_SPEC, secretFieldsOf, type ProfileFieldSpec } from '@/utils/profileSpec'
import type { ProfileCapability } from '@/types/settingsProfile'
import type { KeyStatus } from '@/utils/readiness'

/** 弹窗里一格密文的状态。三档共用这一份形状，讯飞那一档有两格（API Key + APISecret） */
export interface DraftSecret {
  /** 这一格里刚敲的字。空＝不改（编辑）／这一条不带密文（新建） */
  value: string
  /** 磁盘上那一份的状态；新建时恒为 'none'（还没建出来，磁盘上没有可替换的东西） */
  status: KeyStatus
  /** 点过「清除」：保存时这一格发 null，把磁盘上那一份抹掉 */
  cleared: boolean
}

/**
 * 弹窗里那份还没落盘的草稿。
 *
 * 它自己带 `secrets`，不共用面板上那份：弹窗可以在同一时刻为**另一条**
 * （或一条还没存在的方案）填密钥，共用就会把 A 套的密钥状态说到 B 套头上。
 * `profileId` 是编辑那一条的 id，新建时为空串——列表上那颗按钮靠它认出自己。
 */
export interface ProfileDraft {
  capability: ProfileCapability
  mode: 'new' | 'edit'
  profileId: string
  /** 除密文以外的格子，键用跨 IPC 的扁平名 */
  fields: Record<string, string>
  /** 密文那几格，键同样是扁平名（`secretFieldsOf` 那张单子） */
  secrets: Record<string, DraftSecret>
  /** 那颗「当前使用」勾选：新建时决定 createProfile 的 setDefault，编辑时决定指针挪不挪 */
  isCurrent: boolean
}

interface ProfileDialogProps {
  draft: ProfileDraft
  encryptable: boolean
  /** 那颗勾选要不要出现：新建而列表本来就空时不出现——第一条落盘自动是当前使用的，给一颗能取消的勾是骗人 */
  showCurrentCheck: boolean
  busy: boolean
  onFieldChange: (key: string, value: string) => void
  onSecretChange: (key: string, value: string) => void
  onClearSecret: (key: string) => void
  onCurrentChange: (value: boolean) => void
  onSave: () => void
  onCancel: () => void
}

export function ProfileDialog({
  draft,
  encryptable,
  showCurrentCheck,
  busy,
  onFieldChange,
  onSecretChange,
  onClearSecret,
  onCurrentChange,
  onSave,
  onCancel,
}: ProfileDialogProps) {
  const spec = PROFILE_CAP_SPEC[draft.capability]
  const isNew = draft.mode === 'new'
  // 落盘在路上时三条收场全按死：这时候关掉，用户以为没存，其实磁盘上刚写了一半
  const close = () => {
    if (!busy) onCancel()
  }

  /**
   * 改一格。下拉带着 `fills` 时连带盖掉其他格：换服务商就是换一家网关，
   * 地址与默认模型留着上一家的，存下去那条就指向一个不存在的组合。
   *
   * 带着 `clears` 时反过来——把那几格**清空**（配音的「厂商」走这条，1.1.1 拍板）。
   * 理由不是审美：我们替用户填的地址和模型名一旦过时，界面上它就长得像用户自己填的，
   * 点保存就落盘，而错误的地址要等请求失败才说话（空格子当场会被拦下）。
   * 密文那几格也在 clears 里，但它们不能走 `onFieldChange`（值不在 fields 里），
   * 也不能走 `onClearSecret`（那是「把磁盘上这一把抹掉」的明确动作，不该由换厂商替用户做）：
   * 只把手上还没存的那串字清掉，磁盘上已存的还是「留空＝不改」那套口径。
   */
  const changeField = (field: ProfileFieldSpec, value: string) => {
    onFieldChange(field.key, value)
    const fills = field.fills?.[value]
    if (fills) {
      for (const [key, filled] of Object.entries(fills)) onFieldChange(key, filled)
    }
    const secretKeys = new Set(secretFieldsOf(draft.capability))
    for (const key of field.clears ?? []) {
      if (secretKeys.has(key)) onSecretChange(key, '')
      else onFieldChange(key, '')
    }
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
        className="settings-modal profile-dialog"
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
            {isNew ? spec.introNew : spec.introEdit}
          </span>

          {spec.fields.map((field) => {
            // 这一格在这一家根本不存在（资源编号只有豆包收）时不画：摆一格出来只会让人往一个
            // 没人读的地方填值，而填了的东西照样落盘——下次换成别家，那一格还挂着个来路不明的值
            if (field.visibleWhen && !field.visibleWhen(draft.fields)) return null
            // 同一句话在不同厂商下不是同一件事实（配音模型的必填性），判据在表里，这里只管念
            const hint = field.hintFrom?.(draft.fields) ?? field.hint
            if (field.kind === 'key') {
              // 一格里可能有多把密文（讯飞那档 APIKey + APISecret），按 `field.key` 各取一份草稿：
              // 共用一份就会把 A 把的状态说到 B 把头上（「磁盘上已存」其实说的是另一格）。
              const secret = draft.secrets[field.key] ?? { value: '', status: 'none', cleared: false }
              return (
                <div className="settings-form-group" key={field.key}>
                  <label className="settings-form-label">{field.label}</label>
                  <ApiKeyField
                    value={secret.value}
                    status={secret.status}
                    encryptable={encryptable}
                    cleared={secret.cleared}
                    disabled={busy}
                    saveLabel="保存"
                    emptyHint={
                      isNew
                        ? (field.secretHintNew ?? spec.keyHintNew)
                        : (field.secretHintEdit ?? spec.keyHintEdit)
                    }
                    typedHint={
                      isNew
                        ? '这一套还没建出来，磁盘上没有可替换的 Key——这把跟着新建一起存'
                        : undefined
                    }
                    onChange={(value) => onSecretChange(field.key, value)}
                    onClear={() => onClearSecret(field.key)}
                  />
                  {hint && <span className="settings-form-hint">{hint}</span>}
                </div>
              )
            }
            if (field.kind === 'select') {
              return (
                <div className="settings-form-group" key={field.key}>
                  <label className="settings-form-label">{field.label}</label>
                  <select
                    className="settings-form-select"
                    value={draft.fields[field.key] ?? ''}
                    disabled={busy}
                    onChange={(e) => changeField(field, e.target.value)}
                  >
                    {(field.options ?? []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {hint && <span className="settings-form-hint">{hint}</span>}
                </div>
              )
            }
            return (
              <div className="settings-form-group" key={field.key}>
                <label className="settings-form-label">{field.label}</label>
                <input
                  className="settings-form-input"
                  value={draft.fields[field.key] ?? ''}
                  disabled={busy}
                  placeholder={field.placeholderFrom?.(draft.fields) ?? field.placeholder}
                  onChange={(e) => onFieldChange(field.key, e.target.value)}
                />
                {hint && <span className="settings-form-hint">{hint}</span>}
              </div>
            )
          })}

          {showCurrentCheck && (
            <div className="settings-form-group">
              <label className="settings-form-check">
                <input
                  type="checkbox"
                  checked={draft.isCurrent}
                  disabled={busy}
                  onChange={(e) => onCurrentChange(e.target.checked)}
                />
                {isNew ? '建好就设为当前使用' : '当前使用'}
              </label>
              <span className="settings-form-hint">
                {isNew
                  ? draft.isCurrent
                    ? `建出来就接管${spec.activity}，原来那条被顶掉——下一次${spec.activity}按这套走`
                    : '不勾＝还是原来那条在跑，这套先建着'
                  : draft.isCurrent
                    ? `${spec.activity}按这一套走。取消勾选再保存，这一档会暂时没有当前使用的方案`
                    : `勾上再保存，${spec.activity}才按这一套走`}
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
