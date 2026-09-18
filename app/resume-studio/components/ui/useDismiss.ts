'use client'

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * Closes a floating surface on Escape or on a press outside it.
 *
 * `refs` are everything that counts as inside -- the trigger as well as the
 * surface, so pressing the trigger toggles instead of closing and reopening.
 */
export function useDismiss(
  open: boolean,
  refs: ReadonlyArray<RefObject<HTMLElement>>,
  onDismiss: (reason: 'escape' | 'outside') => void
): void {
  const latest = useRef({ refs, onDismiss })
  latest.current = { refs, onDismiss }

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') latest.current.onDismiss('escape')
    }
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && latest.current.refs.some((ref) => ref.current?.contains(target))) return
      latest.current.onDismiss('outside')
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open])
}
