'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from 'react'
import { cx, floating, menu } from './recipes'
import type { IconType } from './recipes'
import { useDismiss } from './useDismiss'

/**
 * A menu button: one trigger, a short list of actions.
 *
 * Follows the WAI-ARIA menu-button pattern. Click, Enter, Space or ArrowDown
 * opens it and focuses the first item; arrow keys, Home and End move; Escape
 * closes and returns focus to the trigger; Tab closes and moves on. The caller
 * renders the trigger, so any Button or IconButton can open a menu.
 *
 * Items are anything with role="menuitem": MenuItem, or a plain <button> or
 * <Link> when a caller needs its own markup. Choosing one closes the menu.
 *
 * `placement="top"` opens it upward: for a trigger at the foot of a card, where
 * opening downward would spill over whatever comes next on the page.
 */

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  'aria-controls': string | undefined
  onClick: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}

export function Menu({
  label,
  trigger,
  children,
  align = 'end',
  placement = 'bottom',
  defaultOpen = false,
  className,
}: {
  /** Names the list for assistive technology. */
  label: string
  trigger: (props: MenuTriggerProps) => ReactNode
  children: ReactNode
  align?: 'start' | 'end'
  placement?: 'top' | 'bottom'
  /** Review states only: renders open without moving focus. */
  defaultOpen?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const focusOnOpen = useRef<'first' | 'last' | null>(null)

  const items = () =>
    Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])

  const close = (returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }

  useDismiss(open, [triggerRef, panelRef], (reason) => close(reason === 'escape'))

  useEffect(() => {
    if (!open || !focusOnOpen.current) return
    const list = items()
    const target = focusOnOpen.current === 'last' ? list[list.length - 1] : list[0]
    target?.focus()
    focusOnOpen.current = null
  }, [open])

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    focusOnOpen.current = event.key === 'ArrowUp' ? 'last' : 'first'
    setOpen(true)
  }

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items()
    if (list.length === 0) return
    const at = list.indexOf(document.activeElement as HTMLElement)
    const moveTo = (index: number) => {
      event.preventDefault()
      list[(index + list.length) % list.length]?.focus()
    }
    if (event.key === 'ArrowDown') moveTo(at + 1)
    else if (event.key === 'ArrowUp') moveTo(at - 1)
    else if (event.key === 'Home') moveTo(0)
    else if (event.key === 'End') moveTo(list.length - 1)
    else if (event.key === 'Tab') setOpen(false)
  }

  /** The item's own handler has already run by the time this bubbles up. */
  const onPanelClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[role="menuitem"]')) close(true)
  }

  return (
    <div className={cx('relative inline-flex', className)}>
      {trigger({
        ref: triggerRef,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined,
        onClick: () => {
          focusOnOpen.current = open ? null : 'first'
          setOpen(!open)
        },
        onKeyDown: onTriggerKeyDown,
      })}
      {open && (
        <div
          ref={panelRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onPanelKeyDown}
          onClick={onPanelClick}
          className={cx(
            floating.menu,
            'absolute',
            placement === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
            align === 'end' ? 'right-0' : 'left-0'
          )}
        >
          {children}
        </div>
      )}
    </div>
  )
}

export function MenuItem({
  icon: Icon,
  children,
  onSelect,
  tone = 'default',
  hint,
  disabled,
}: {
  icon?: IconType
  children: ReactNode
  onSelect?: () => void
  /** Danger items belong last, after a MenuSeparator. */
  tone?: 'default' | 'danger'
  hint?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={disabled}
      className={tone === 'danger' ? menu.itemDanger : menu.item}
      onClick={onSelect}
    >
      {Icon && <Icon className={menu.icon} aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className={menu.hint}>{hint}</span>}
    </button>
  )
}

export function MenuSeparator() {
  return <div role="separator" className={menu.separator} />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div role="presentation" className={menu.label}>
      {children}
    </div>
  )
}
