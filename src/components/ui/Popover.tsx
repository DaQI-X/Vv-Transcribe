import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

interface PopoverProps {
  content: React.ReactNode
  trigger?: 'click' | 'hover'
  placement?: 'top' | 'bottom'
  children: React.ReactNode
}

const MARGIN = 8

export function Popover({ content, trigger = 'click', placement = 'top', children }: PopoverProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // 测量触发点与气泡尺寸后计算视口坐标：水平居中并夹取，垂直按 placement 放置、溢出则翻转。
  // 用 top/left 像素定位而非 transform，避免与入场动画的 transform 冲突。
  const computePos = useCallback(() => {
    const t = triggerRef.current
    const p = popRef.current
    if (!t || !p) return
    const r = t.getBoundingClientRect()
    const pw = p.offsetWidth
    const ph = p.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight

    let left = r.left + r.width / 2 - pw / 2

    let top: number
    if (placement === 'top') {
      top = r.top - MARGIN - ph
      if (top < MARGIN) top = r.bottom + MARGIN // 上方放不下 → 翻到下方
    } else {
      top = r.bottom + MARGIN
      if (top + ph > vh - MARGIN) top = r.top - MARGIN - ph // 下方放不下 → 翻到上方
    }

    left = Math.max(MARGIN, Math.min(left, vw - pw - MARGIN))
    top = Math.max(MARGIN, Math.min(top, vh - ph - MARGIN))
    setPos({ top, left })
  }, [placement])

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    computePos()
  }, [open, computePos, content])

  // 滚动（含内层滚动容器）/缩放时重新定位，避免 fixed 气泡与触发点脱节
  useEffect(() => {
    if (!open) return
    window.addEventListener('scroll', computePos, true)
    window.addEventListener('resize', computePos)
    return () => {
      window.removeEventListener('scroll', computePos, true)
      window.removeEventListener('resize', computePos)
    }
  }, [open, computePos])

  useEffect(() => {
    if (!open || trigger !== 'click') return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, trigger])

  const handleToggle = () => {
    if (trigger === 'click') setOpen((o) => !o)
  }

  return (
    <>
      <div
        ref={triggerRef}
        onClick={handleToggle}
        onMouseEnter={() => trigger === 'hover' && setOpen(true)}
        onMouseLeave={() => trigger === 'hover' && setOpen(false)}
        style={{ display: 'inline' }}
      >
        {children}
      </div>
      {open &&
        createPortal(
          <>
            <div className="custom-popover-overlay" onClick={() => setOpen(false)} />
            <div
              ref={popRef}
              className="custom-popover"
              style={{
                top: pos?.top ?? 0,
                left: pos?.left ?? 0,
                visibility: pos ? 'visible' : 'hidden',
              }}
            >
              {content}
            </div>
          </>,
          document.body
        )}
    </>
  )
}
