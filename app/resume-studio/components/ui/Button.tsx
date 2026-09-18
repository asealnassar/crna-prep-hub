import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import { buttonClass, cx, glyph, iconButtonClass } from './recipes'
import type { ButtonSize, ButtonVariant, IconButtonSize, IconButtonTone, IconType } from './recipes'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconType
  trailingIcon?: IconType
}

/** Every text button in Resume Studio. Pick the lowest weight that still reads as the action it is. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, trailingIcon: Trailing, className, children, type = 'button', ...rest },
  ref
) {
  const iconClass = size === 'sm' ? glyph.sm : glyph.md
  return (
    <button ref={ref} type={type} className={cx(buttonClass(variant, size), className)} {...rest}>
      {Icon && <Icon className={iconClass} aria-hidden="true" />}
      {children}
      {Trailing && <Trailing className={cx(iconClass, '-mr-0.5 opacity-70')} aria-hidden="true" />}
    </button>
  )
})

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Required: an icon-only control without a name is invisible to a screen reader. */
  label: string
  icon: IconType
  size?: IconButtonSize
  tone?: IconButtonTone
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon: Icon, size = 'md', tone = 'neutral', className, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(iconButtonClass(size, tone), className)}
      {...rest}
    >
      <Icon className={size === 'sm' ? glyph.sm : glyph.md} aria-hidden="true" />
    </button>
  )
})
