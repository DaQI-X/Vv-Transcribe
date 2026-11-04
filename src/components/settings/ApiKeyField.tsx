/**
 * API Key 那一格（三档共用，#222 重写第⑥步从 SettingsModal 里搬出来）。
 *
 * 第⑥步从 SettingsModal 里搬出来时，转写的弹窗要先用这一格；第⑧步三档的凭据都进了同一个弹窗，
 * 面板上再没有这一格，于是它只剩 `ProfileDialog` 一个调用点。仍然独立成组件是因为它那段三态提示
 * （有字／点了「清除」／两者都没）容易写错，而写错就是拿用户的密钥开玩笑。
 *
 * 三态不变：有字＝保存时替换、点「清除」＝保存时清空、两者都没＝整个键不发送，磁盘上那把不动。
 * 「保存」那两个字是参数（`saveLabel`）：这一格跟着哪颗按钮落盘，只有那颗按钮自己说得清。
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
  /** 这一格跟着哪颗按钮落盘：话术里那颗按钮的名字必须和真的那颗一致 */
  saveLabel: string
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
  saveLabel,
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
