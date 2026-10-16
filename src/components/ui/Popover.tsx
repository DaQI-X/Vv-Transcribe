import { useState, useRef, useEffect } from 'react'

interface PopoverProps {
  content: React.ReactNode
  trigger?: 'click' | 'hover'
  placement?: 'top' | 'bottom'
  children: React.ReactNode
}

export function Popover({ content, trigger = 'click', placement = 'top', children }: PopoverProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const triggerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || trigger !== 'click') return
    const handler = (e: MouseEvent) => {
      if (triggerRef.current && !triggerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, trigger])

  const handleToggle = () => {
    if (trigger !== 'click') return
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setPos({
        top: placement === 'top' ? rect.top - 8 : rect.bottom + 8,
        left: rect.left + rect.width / 2,
      })
    }
    setOpen(!open)
  }

  return (
    <>
      <div
        ref={triggerRef}
        onClick={handleToggle}
        onMouseEnter={() => {
          if (trigger === 'hover' && triggerRef.current) {
            const rect = triggerRef.current.getBoundingClientRect()
            setPos({
              top: rect.top - 8,
              left: rect.left + rect.width / 2,
            })
            setOpen(true)
          }
        }}
        onMouseLeave={() => trigger === 'hover' && setOpen(false)}
        style={{ display: 'inline' }}
      >
        {children}
      </div>
      {open && (
        <>
          <div className="custom-popover-overlay" onClick={() => setOpen(false)} />
          <div
            className="custom-popover"
            style={{
              top: pos.top,
              left: pos.left,
              transform: 'translate(-50%, -100%)',
            }}
          >
            {content}
          </div>
        </>
      )}
    </>
  )
}
