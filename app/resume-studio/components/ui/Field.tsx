import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { cx, field } from './recipes'

/**
 * Form fields.
 *
 * Every control has a real <label>: a placeholder is a hint, never a name.
 * `action` sits on the label row (an AI action, say); `footer` puts a toolbar
 * inside the control's own border, which is how prose fields carry their AI
 * affordance without a second box underneath.
 */

interface FrameProps {
  id: string
  label: string
  help?: string
  action?: ReactNode
  className?: string
  /** Keeps the label for screen readers but not on screen (numbered bullets). */
  hideLabel?: boolean
}

function Frame({ id, label, help, action, className, hideLabel, children }: FrameProps & { children: ReactNode }) {
  return (
    <div className={className}>
      <div className={cx('mb-1.5 flex min-h-5 items-center justify-between gap-2', hideLabel && !action && 'sr-only')}>
        <label htmlFor={id} className={cx(field.label, hideLabel && 'sr-only')}>
          {label}
        </label>
        {action}
      </div>
      {children}
      {help && (
        <p id={`${id}-help`} className={field.help}>
          {help}
        </p>
      )}
    </div>
  )
}

const describedBy = (id: string, help?: string) => (help ? `${id}-help` : undefined)

export function TextField({
  id, label, help, action, className, hideLabel, ...input
}: FrameProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className'>) {
  return (
    <Frame id={id} label={label} help={help} action={action} className={className} hideLabel={hideLabel}>
      <input id={id} className={field.control} aria-describedby={describedBy(id, help)} {...input} />
    </Frame>
  )
}

export function TextAreaField({
  id, label, help, action, className, hideLabel, footer, ...textarea
}: FrameProps & { footer?: ReactNode } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'className'>) {
  return (
    <Frame id={id} label={label} help={help} action={action} className={className} hideLabel={hideLabel}>
      {footer ? (
        <div className={field.shell}>
          <textarea id={id} className={field.bare} aria-describedby={describedBy(id, help)} {...textarea} />
          <div className={field.shellFooter}>{footer}</div>
        </div>
      ) : (
        <textarea
          id={id}
          className={cx(field.control, field.textarea)}
          aria-describedby={describedBy(id, help)}
          {...textarea}
        />
      )}
    </Frame>
  )
}

export function SelectField({
  id, label, help, action, className, hideLabel, children, ...select
}: FrameProps & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'className'>) {
  return (
    <Frame id={id} label={label} help={help} action={action} className={className} hideLabel={hideLabel}>
      <select id={id} className={cx(field.control, field.select)} aria-describedby={describedBy(id, help)} {...select}>
        {children}
      </select>
    </Frame>
  )
}

export function CheckboxField({
  id, label, className, ...input
}: { id: string; label: string; className?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className' | 'type'>) {
  return (
    <label htmlFor={id} className={cx(field.checkboxLabel, className)}>
      <input id={id} type="checkbox" className={field.checkbox} {...input} />
      {label}
    </label>
  )
}
