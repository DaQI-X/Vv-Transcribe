import { useState } from 'react'
import { CheckCircle2, XCircle, Info, Loader2 } from 'lucide-react'

type ToastType = 'success' | 'error' | 'info' | 'loading'

interface ToastItem {
  id: number
  type: ToastType
  content: string
  key?: string
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
        </div>
      ))}
    </div>
  )
}

function addToast(type: ToastType, content: string, duration: number = 3000, key?: string) {
  const id = ++toastId

  if (key) {
    globalSetToasts((prev) => {
      const existing = prev.findIndex((t) => t.key === key)
      if (existing >= 0) {
        const next = [...prev]
        next[existing] = { id, type, content, key }
        return next
      }
      return [...prev, { id, type, content, key }]
    })
  } else {
    globalSetToasts((prev) => [...prev, { id, type, content }])
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
  error(content: string, duration?: number) {
    addToast('error', content, duration)
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
