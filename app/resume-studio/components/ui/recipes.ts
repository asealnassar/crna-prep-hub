import type { ComponentType } from 'react'

/**
 * Resume UI — the look of every Resume Studio surface, in one file.
 *
 * Components ask for a recipe instead of inventing classes, so a button on the
 * dashboard and a button in the Studio cannot drift apart, and changing what a
 * secondary button looks like is one edit here. Every class is a stock Tailwind
 * utility: nothing needs a theme change in the app's tailwind.config.js.
 *
 *   workspace  #F7F8FC      surface  white        canvas  slate-100
 *   borders    slate-200    inputs   slate-400    focus   violet-600
 *   text       slate-900 · slate-600 · slate-500 (slate-500 on white only)
 *   accent     violet-600: primary action, selection, focus. Never a background.
 *   states     emerald = done, amber = needs attention, red = destructive --
 *              always with words or an icon, never colour alone.
 */

export type IconType = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export const surface = {
  workspace: 'bg-[#F7F8FC]',
  canvas: 'bg-slate-100',
  panel: 'bg-white',
} as const

export const text = {
  primary: 'text-slate-900',
  secondary: 'text-slate-600',
  muted: 'text-slate-500',
  heading: 'text-sm font-semibold text-slate-900',
  overline: 'text-xs font-medium text-slate-500',
} as const

/** One focus treatment for everything a keyboard can reach. */
export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white'

// ----------------------------------------------------------------- buttons

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'danger' | 'ai'
export type ButtonSize = 'sm' | 'md'

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  /** One per view: the thing this screen is for. */
  primary: 'bg-violet-600 text-white shadow-sm hover:bg-violet-700 active:bg-violet-800',
  /** Real actions that are not the main one. */
  secondary: 'border border-slate-300 bg-white text-slate-800 shadow-sm hover:border-slate-400 hover:bg-slate-50',
  /** Low emphasis; reads as text until hovered. */
  tertiary: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  /** Destructive and deliberately quiet: never a filled block beside Open. */
  danger: 'text-red-600 hover:bg-red-50 hover:text-red-700',
  /** AI actions only. Tertiary weight, in the accent colour. */
  ai: 'text-violet-700 hover:bg-violet-50 hover:text-violet-800',
}

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-2.5 text-[13px]',
  md: 'h-9 gap-2 px-3.5 text-sm',
}

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md'): string {
  return cx(
    'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-lg font-semibold transition-colors',
    'disabled:pointer-events-none disabled:opacity-50',
    focusRing,
    BUTTON_SIZE[size],
    BUTTON_VARIANT[variant]
  )
}

export type IconButtonSize = 'sm' | 'md' | 'touch'
export type IconButtonTone = 'neutral' | 'danger' | 'ai'

const ICON_BUTTON_SIZE: Record<IconButtonSize, string> = {
  sm: 'h-7 w-7',
  md: 'h-8 w-8',
  /** 44px: the minimum for a thumb. */
  touch: 'h-11 w-11',
}

const ICON_BUTTON_TONE: Record<IconButtonTone, string> = {
  neutral: 'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
  danger: 'text-slate-500 hover:bg-red-50 hover:text-red-600',
  ai: 'text-violet-600 hover:bg-violet-50 hover:text-violet-700',
}

export function iconButtonClass(size: IconButtonSize = 'md', tone: IconButtonTone = 'neutral'): string {
  return cx(
    'inline-flex shrink-0 items-center justify-center rounded-lg transition-colors',
    'disabled:pointer-events-none disabled:opacity-40',
    focusRing,
    ICON_BUTTON_SIZE[size],
    ICON_BUTTON_TONE[tone]
  )
}

/** A full-width "add something" affordance: easy to find, but not a primary action. */
export const addActionClass = cx(
  'flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white/70 px-4 py-3',
  'text-sm font-semibold text-slate-600 transition-colors hover:border-violet-400 hover:bg-violet-50/50 hover:text-violet-700',
  focusRing
)

export const glyph = { xs: 'h-3 w-3', sm: 'h-3.5 w-3.5', md: 'h-4 w-4' } as const

// ------------------------------------------------------------------ badges

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'accent'

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
  accent: 'bg-violet-50 text-violet-700 ring-violet-200',
}

export function badgeClass(tone: BadgeTone = 'neutral'): string {
  return cx(
    'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
    BADGE_TONE[tone]
  )
}

// ------------------------------------------------------------------- cards

export type CardTone = 'default' | 'muted' | 'accent'

const CARD_TONE: Record<CardTone, string> = {
  default: 'border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]',
  /** A quieter panel inside a card, or a hidden section. */
  muted: 'border-slate-200 bg-slate-50',
  /** AI suggestions, and nothing else. */
  accent: 'border-violet-200 bg-violet-50/60',
}

export function cardClass(tone: CardTone = 'default'): string {
  return cx('rounded-xl border', CARD_TONE[tone])
}

// ------------------------------------------------------- floating surfaces

export const floating = {
  menu: 'z-40 min-w-[13rem] rounded-xl border border-slate-200 bg-white p-1 shadow-lg shadow-slate-900/10',
  popover: 'z-40 rounded-xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10',
  sheet: 'rounded-t-2xl border-t border-slate-200 bg-white shadow-xl shadow-slate-900/20',
  scrim: 'bg-slate-900/30',
} as const

const MENU_ITEM = cx(
  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm focus:outline-none',
  'disabled:pointer-events-none disabled:opacity-50'
)

// focus-visible rather than focus: opening a menu with the mouse still moves
// focus to the first item, and that must not look like a hover nobody made.
export const menu = {
  item: cx(MENU_ITEM, 'text-slate-700 hover:bg-slate-100 focus-visible:bg-slate-100'),
  itemDanger: cx(MENU_ITEM, 'text-red-600 hover:bg-red-50 focus-visible:bg-red-50'),
  icon: 'h-4 w-4 shrink-0',
  hint: 'ml-auto pl-4 text-xs text-slate-500',
  separator: 'my-1 h-px bg-slate-100',
  label: 'px-2.5 pb-1 pt-2 text-xs font-medium text-slate-500',
} as const

// ------------------------------------------------------------- form fields

const CONTROL_EDGE = cx(
  'rounded-lg border border-slate-400 bg-white shadow-[inset_0_1px_1px_rgba(15,23,42,0.03)] transition-colors',
  'hover:border-slate-500'
)

export const field = {
  label: 'block text-xs font-medium text-slate-600',
  help: 'mt-1.5 text-xs text-slate-500',
  control: cx(
    'block w-full px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400',
    CONTROL_EDGE,
    'focus:border-violet-600 focus:outline-none focus:ring-[3px] focus:ring-violet-600/15',
    'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500'
  ),
  /** A control with a toolbar inside its border, e.g. prose with an AI action. */
  shell: cx(CONTROL_EDGE, 'focus-within:border-violet-600 focus-within:ring-[3px] focus-within:ring-violet-600/15'),
  bare: 'block w-full resize-y rounded-t-lg border-0 bg-transparent px-3 py-2 text-sm leading-relaxed text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-0',
  shellFooter: 'flex flex-wrap items-center justify-between gap-1 border-t border-slate-100 px-1.5 py-1',
  textarea: 'min-h-[4.5rem] resize-y leading-relaxed',
  select: 'pr-8',
  checkbox: 'h-4 w-4 rounded border-slate-400 accent-violet-600',
  checkboxLabel: 'inline-flex items-center gap-2 text-sm text-slate-700',
  /** The editable title in the Studio toolbar: reads as text until touched. */
  inlineTitle: cx(
    'min-w-0 truncate rounded-md border border-transparent bg-transparent px-2 py-1 text-[15px] font-semibold text-slate-900',
    'hover:border-slate-200 focus:border-violet-600 focus:outline-none focus:ring-[3px] focus:ring-violet-600/15'
  ),
} as const

// ------------------------------------------------------ segmented controls

export const segmented = {
  group: 'inline-flex rounded-lg bg-slate-100 p-0.5',
  item: cx(
    'inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium text-slate-600 transition',
    'hover:text-slate-900',
    focusRing
  ),
  size: {
    md: 'px-3 py-1.5 text-sm',
    /** Compact, e.g. choosing between two AI suggestions. */
    sm: 'min-w-[1.75rem] px-2 py-0.5 text-xs',
  },
  itemActive: 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200',
} as const
