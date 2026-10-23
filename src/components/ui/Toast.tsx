import { useState } from 'react'
import { CheckCircle2, XCircle, Info, Loader2, ExternalLink } from 'lucide-react'

type ToastType = 'success' | 'error' | 'info' | 'loading'

export interface ToastAction {
  label: string
  onClick: () => void
}

interface ToastItem {
  id: number
  type: ToastType
  content: string
  key?: string
  action?: ToastAction
}

type ToastSetter = (updater: (prev: ToastItem[]) => ToastItem[]) => void

let toastId = 0
let globalSetToasts: ToastSetter = () => {}

const ICONS: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle2 size={16} className="toast__icon toast__icon--success" />,
  error: <XCircle size={16} className="toast__icon toast__icon--error" />,
  info: <Info size={16} className="toast__icon toast__icon--info" />,
  loading: <Loader2 size={16} className="toast__icon toast__icon--loading animate-spin" />,
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  globalSetToasts = setToasts

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.type}`}>
          {ICONS[t.type]}
          <span className="toast__text">{t.content}</span>
          {t.action && (
            <button type="button" className="toast__action" onClick={t.action.onClick}>
              <ExternalLink size={13} />
              <span>{t.action.label}</span>
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function addToast(
  type: ToastType,
  content: string,
  duration: number = 3000,
  key?: string,
  action?: ToastAction,
) {
  const id = ++toastId

  if (key) {
    globalSetToasts((prev) => {
      const existing = prev.findIndex((t) => t.key === key)
      if (existing >= 0) {
        const next = [...prev]
        next[existing] = { id, type, content, key, action }
        return next
      }
      return [...prev, { id, type, content, key, action }]
    })
  } else {
    globalSetToasts((prev) => [...prev, { id, type, content, action }])
  }

  if (duration > 0) {
    setTimeout(() => {
      globalSetToasts((prev) => prev.filter((t) => t.id !== id))
    }, duration)
  }
}

function removeToastByKey(key: string) {
  globalSetToasts((prev) => prev.filter((t) => t.key !== key))
}

export const toast = {
  success(content: string, duration?: number) {
    addToast('success', content, duration)
  },
  error(content: string, duration?: number, action?: ToastAction) {
    addToast('error', content, duration, undefined, action)
  },
  info(content: string, duration?: number) {
    addToast('info', content, duration)
  },
  loading(content: string, duration?: number) {
    addToast('loading', content, duration)
  },
  remove(key: string) {
    removeToastByKey(key)
  },
}
