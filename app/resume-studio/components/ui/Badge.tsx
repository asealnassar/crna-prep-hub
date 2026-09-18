import type { ReactNode } from 'react'
import { badgeClass, cx, glyph } from './recipes'
import type { BadgeTone, IconType } from './recipes'

/** A state label. Always words, optionally an icon -- never colour alone. */
export function Badge({
  tone = 'neutral',
  icon: Icon,
  children,
  className,
}: {
  tone?: BadgeTone
  icon?: IconType
  children: ReactNode
  className?: string
}) {
  return (
    <span className={cx(badgeClass(tone), className)}>
      {Icon && <Icon className={glyph.xs} aria-hidden="true" />}
      {children}
    </span>
  )
}
