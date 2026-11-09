/**
 * 渲染层自己的右键菜单。
 *
 * 为什么不用 Electron 原生 Menu：这些菜单项改的是渲染层 store 里的那份 segments，走原生菜单
 * 就得为它单开一条 IPC 通道（#361 这一摊的规矩是「一趟 IPC 都不走」）。
 * 菜单按鼠标点定位并夹在视口内；列表一滚就把菜单关掉，而不是跟着挪——挪动中的菜单容易
 * 让人点到已经换掉的那一行。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

const MARGIN = 8

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [active, setActive] = useState(0)

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    setPos({
      top: Math.max(MARGIN, Math.min(y, window.innerHeight - el.offsetHeight - MARGIN)),
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - el.offsetWidth - MARGIN)),
    })
  }, [x, y])

  // 第一帧菜单还是 visibility:hidden，那时 focus 是空操作（隐藏的节点拿不到焦点），
  // 所以要等量完位置、这一帧改回可见之后补一次。
  useLayoutEffect(() => {
    if (pos) menuRef.current?.focus()
  }, [pos])

  useEffect(() => {
    const onDocMouseDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDocMouseDown)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDocMouseDown)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const pick = (item: ContextMenuItem) => {
    if (item.disabled) return
    item.onSelect()
    onClose()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      pick(items[active])
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      // 只在可用项之间跳：菜单里出现置灰项时，一下一下按不该被卡住
      for (let i = 1; i <= items.length; i++) {
        const next = (active + step * i + items.length * i) % items.length
        if (!items[next].disabled) {
          setActive(next)
          return
        }
      }
    }
  }

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // 菜单 portal 到 body，但 React 的事件仍沿组件树往上冒：不在这儿挡住，
      // 点一项会连带触发调用方那一行的左键行为（跳转播放点）
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      style={{ top: pos?.top ?? y, left: pos?.left ?? x, visibility: pos ? 'visible' : 'hidden' }}
    >
      {items.map((item, index) => (
        <button
          key={item.label}
          role="menuitem"
          type="button"
          className={`context-menu__item ${index === active ? 'context-menu__item--active' : ''}`}
          disabled={item.disabled}
          onMouseEnter={() => setActive(index)}
          onClick={() => pick(item)}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
