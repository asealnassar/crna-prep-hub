import { cx, glyph, segmented } from './recipes'
import type { IconType } from './recipes'

export interface SegmentOption<T extends string> {
  value: T
  label: string
  icon?: IconType
}

/**
 * Two to four mutually exclusive views -- Edit / Preview, or one suggestion of
 * several. The selected segment is visible at a glance, so nobody has to work
 * out whether a label names where they are or where they would go.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'md',
  className,
}: {
  label: string
  value: T
  options: readonly SegmentOption<T>[]
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <div role="tablist" aria-label={label} className={cx(segmented.group, className)}>
      {options.map((option) => {
        const active = option.value === value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cx(segmented.item, segmented.size[size], active && segmented.itemActive)}
          >
            {Icon && <Icon className={glyph.md} aria-hidden="true" />}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
