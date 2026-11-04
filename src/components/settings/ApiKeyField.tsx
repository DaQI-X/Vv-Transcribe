/**
 * API Key 那一格（三档共用，#222 重写第⑥步从 SettingsModal 里搬出来）。
 *
 * 搬的原因只有一个：转写的「新建API接入／编辑」弹窗也要摆这一格，而 SettingsModal 不能
 * 反过来 import 自己的子组件。搬过来之后它同时给两个落点用——面板里（校对、配音）和弹窗里（转写）。
 *
 * 三态不变：有字＝保存时替换、点「清除」＝保存时清空、两者都没＝整个键不发送，磁盘上那把不动。
 * 「保存」那两个字是参数（`saveLabel`）：面板里点的是右下角「保存设置」，弹窗里点的是它自己的
 * 「保存」，而这两句落盘的是不同的东西——把话术写死成一处，另一处就成谎。
 */
import { useState } from 'react'
import { Eye, EyeOff, Trash2, TriangleAlert } from 'lucide-react'
import type { KeyStatus } from '@/utils/readiness'

/** 主进程只给状态不给值，所以界面能说清的只有「有没有、能不能用、是不是明文」这三件事 */
const KEY_STATUS_HINT: Record<Exclude<KeyStatus, 'none'>, string> = {
  encrypted: '已加密保存在本机 · 留空表示不修改',
  plaintext: '已保存在本机，但这条是明文 · 留空表示不修改',
  unreadable: '这台机器读不出已保存的那把 Key（可能换过电脑，或系统密钥库被清过），重新填写并保存即可',
}

/** 认不准的状态一律按「没有」处理，别让界面上凭空多出一种可能值 */
export function toKeyStatus(value: unknown): KeyStatus {
  return value === 'encrypted' || value === 'plaintext' || value === 'unreadable' ? value : 'none'
}

function PasswordInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
}) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="settings-form-password-wrapper">
      <input
        className="settings-form-input"
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      <button
        type="button"
        className="settings-form-password-toggle"
        onClick={() => setVisible(!visible)}
        tabIndex={-1}
      >
        {visible ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  )
}

export interface ApiKeyFieldProps {
  value: string
  status: KeyStatus
  encryptable: boolean
  cleared: boolean
  disabled?: boolean
  /** 还没保存过 Key 时的说法，各处不同 */
  emptyHint: string
  /** 输入框里有字时的说法；新建那一次磁盘上还没有 Key，「替换已保存的」就成了谎 */
  typedHint?: string
  /** 这一格跟着哪颗按钮落盘：面板里是「保存设置」，转写弹窗里是它自己的「保存」 */
  saveLabel?: string
  onChange: (v: string) => void
  onClear: () => void
}

export function ApiKeyField({
  value,
  status,
  encryptable,
  cleared,
  disabled,
  emptyHint,
  typedHint,
  saveLabel = '保存设置',
  onChange,
  onClear,
}: ApiKeyFieldProps) {
  const typed = value.trim() !== ''
  return (
    <>
      <PasswordInput
        value={value}
        onChange={onChange}
        placeholder={status === 'none' ? 'sk-...' : '已保存 · 留空不修改'}
        disabled={disabled}
      />
      <span className="settings-form-hint">
        {cleared
          ? `将在点「${saveLabel}」后清除已保存的 Key`
          : typed
            ? (typedHint ?? `点「${saveLabel}」后替换已保存的 Key`)
            : status === 'none'
              ? emptyHint
              : KEY_STATUS_HINT[status]}
      </span>
      {status !== 'none' && !cleared && (
        <button
          type="button"
          onClick={onClear}
          disabled={disabled}
          className="settings-modal__dict-update-btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 6 }}
        >
          <Trash2 size={12} />
          清除已保存的 Key
        </button>
      )}
      {!encryptable && (
        <span className="settings-form-hint" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <TriangleAlert size={12} style={{ color: '#d97706' }} />
          这台机器用不了系统密钥库，这把 Key 只能以明文存在配置文件里
        </span>
      )}
    </>
  )
}
