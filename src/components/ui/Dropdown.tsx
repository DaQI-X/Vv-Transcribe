import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'

interface DropdownProps {
  items: Array<{ key: string; label: string; onClick: () => void }>
  children: React.ReactNode
}

export function Dropdown({ items, children }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 })

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (triggerRef.current && !triggerRef.current.contains(e.target as Node) &&
          menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleToggle = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setMenuPos({
        top: rect.bottom + 6,
        right: window.innerWidth - rect.right,
      })
    }
    setOpen(!open)
  }

  return (
    <div className="custom-dropdown" ref={triggerRef}>
      <div onClick={handleToggle}>{children}</div>
      {open && createPortal(
        <div
          ref={menuRef}
          className="custom-dropdown__menu"
          style={{
            position: 'fixed',
            top: menuPos.top,
            right: menuPos.right,
          }}
        >
          {items.map((item) => (
            <button
              key={item.key}
              className="custom-dropdown__item"
              onClick={() => { item.onClick(); setOpen(false) }}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
