/**
 * Feedback from Resume Builder V2, carried by the feedback system that already
 * exists.
 *
 * REUSED, NOT REBUILT. V1's feedback page writes one row to
 * `interview_feedback` -- `{ user_email, message }` -- and names the feature it
 * came from in the message itself: "[Resume Builder] ...". The Analytics page
 * reads that table and prints the message. V2 writes the SAME row to the SAME
 * table with the same kind of tag, so every submission lands in the feedback
 * anyone already reads, with no second table, no second API and no migration.
 *
 * WHAT THE TAG CARRIES. Source, so V1 and V2 can be told apart; the type the
 * applicant chose; where they were; which template they had open; and their
 * tier. All of it is context about the product, and none of it is their resume:
 * this module is given the typed message and a few labels, and there is no way
 * to hand it a bullet, a summary or a contact detail.
 *
 * Pure. The write itself is the browser Supabase client, exactly as V1 does it.
 */

export const FEEDBACK_TYPES = [
  { key: 'issue', label: 'Issue / Bug' },
  { key: 'suggestion', label: 'Suggestion' },
  { key: 'other', label: 'Other' },
] as const

export type FeedbackType = (typeof FEEDBACK_TYPES)[number]['key']
export type FeedbackSurface = 'dashboard' | 'studio'

/** What the tag says, and what Analytics matches on. */
export const V2_SOURCE = 'Resume Builder V2'
/** What V1's feedback page has always written. */
export const V1_SOURCE = 'Resume Builder'

/**
 * Longest message accepted. The existing system sets no limit of its own, so
 * this is a sane ceiling rather than a rule taken from somewhere else: long
 * enough for a detailed bug report, short enough that nobody pastes a resume
 * into it by accident.
 */
export const MAX_FEEDBACK_LENGTH = 2000

const SURFACE_LABEL: Record<FeedbackSurface, string> = {
  dashboard: 'Dashboard',
  studio: 'Studio',
}

export function feedbackTypeLabel(type: FeedbackType): string {
  return FEEDBACK_TYPES.find((option) => option.key === type)?.label ?? 'Other'
}

export type FeedbackCheck =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly error: string }

/** A message worth sending: something was typed, and it is not a whole document. */
export function checkFeedback(message: string): FeedbackCheck {
  const trimmed = message.trim()
  if (trimmed === '') return { ok: false, error: 'Tell us what happened, or what you would like to see.' }
  if (trimmed.length > MAX_FEEDBACK_LENGTH) {
    return { ok: false, error: `Please keep it under ${MAX_FEEDBACK_LENGTH} characters.` }
  }
  return { ok: true, message: trimmed }
}

export interface FeedbackContext {
  readonly type: FeedbackType
  readonly message: string
  readonly surface: FeedbackSurface
  /** The template on screen, when there is one. Never the resume itself. */
  readonly template?: string | null
  readonly tier?: string | null
}

/**
 * The message as it is stored and read: a tag line, then the applicant's words
 * exactly as typed.
 *
 *   [Resume Builder V2] Suggestion · Studio · Modern · Tier: ultimate
 *
 *   Could the preview zoom go to 150%?
 */
export function feedbackMessage(context: FeedbackContext): string {
  const parts = [
    feedbackTypeLabel(context.type),
    SURFACE_LABEL[context.surface],
    context.template ? titleCase(context.template) : null,
    context.tier ? `Tier: ${context.tier}` : null,
  ].filter((part): part is string => Boolean(part))

  return `[${V2_SOURCE}] ${parts.join(' · ')}\n\n${context.message.trim()}`
}

/**
 * The row handed to the existing table. The same two columns V1 writes, so
 * nothing about the feedback system has to change to accept V2.
 */
export function feedbackRow(
  context: FeedbackContext & { readonly email: string | null | undefined }
): { user_email: string; message: string } {
  return {
    user_email: context.email?.trim() || 'anonymous',
    message: feedbackMessage(context),
  }
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

// ---------------------------------------------------------------------------
// Reading it back, for Analytics
// ---------------------------------------------------------------------------

export type FeedbackSource = 'v2' | 'v1' | null

/** Which Resume Builder a stored message came from, or null for anything else. */
export function feedbackSourceOf(message: string | null | undefined): FeedbackSource {
  const text = String(message ?? '')
  if (text.startsWith(`[${V2_SOURCE}]`)) return 'v2'
  if (text.startsWith(`[${V1_SOURCE}]`)) return 'v1'
  return null
}

export function feedbackSourceLabel(source: FeedbackSource): string | null {
  if (source === 'v2') return V2_SOURCE
  if (source === 'v1') return `${V1_SOURCE} V1`
  return null
}

/** The type a V2 submission carried, for the Analytics list. Null for anything else. */
export function feedbackTypeOf(message: string | null | undefined): string | null {
  const text = String(message ?? '')
  if (feedbackSourceOf(text) !== 'v2') return null
  const line = text.slice(text.indexOf(']') + 1).split('\n')[0].trim()
  const label = line.split('·')[0].trim()
  return FEEDBACK_TYPES.some((option) => option.label === label) ? label : null
}
