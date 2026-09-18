import type { HTMLAttributes } from 'react'
import { cardClass, cx } from './recipes'
import type { CardTone } from './recipes'

type CardElement = 'div' | 'section' | 'article' | 'li' | 'aside'

/** The one container shape. Structure comes from the border; shadow is kept for things that float. */
export function Card({
  tone = 'default',
  as: Tag = 'div',
  className,
  ...rest
}: HTMLAttributes<HTMLElement> & { tone?: CardTone; as?: CardElement }) {
  return <Tag className={cx(cardClass(tone), className)} {...rest} />
}
