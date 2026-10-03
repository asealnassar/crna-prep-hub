/**
 * Constraints, rendered for a human.
 *
 * EVERY LINE HERE STAYS IN THE UNIT THE SCHOOL USED. "2 pages maximum
 * (double-spaced)" is a complete, honest sentence; "2 pages maximum (about 500
 * words)" is this product inventing an admissions requirement. There is no
 * approximation, no "roughly", no parenthetical estimate -- the moment one
 * appears an applicant will cut their essay to it.
 *
 * SEPARATE FROM constraints.ts ON PURPOSE. That module decides what is true;
 * this one decides what is said. A copy-change here can never alter a count, a
 * limit or whether something is measurable.
 *
 * ONE DESCRIBER, TWO VIEWS. describe() below is the only place a constraint
 * becomes a sentence. The plain string list and the measured/unmeasured list
 * are both derived from it, so a line can never appear in one and be missing
 * from the other, and a new constraint kind cannot be added to one view only.
 */

import {
  SPACING_LABELS, characterCount, type ConstraintKind, type Constraints, type LiveCount,
  measurableInEditor, unmeasurableKinds,
} from './constraints.ts'

/** 1,000 rather than 1000, consistently, wherever a limit is shown. */
function n(value: number): string {
  return value.toLocaleString('en-US')
}

/** One stated requirement, as a sentence, tagged with whether we can check it. */
export interface LabelledConstraint {
  readonly kind: ConstraintKind
  readonly text: string
  /** True only for words and characters. Everything else is shown, not checked. */
  readonly measured: boolean
}

/**
 * Every stated requirement, in display order.
 *
 * MEASURED FIRST, deliberately: the applicant reads the two numbers the editor
 * is actually watching before the ones they have to check themselves.
 */
function describe(constraints: Constraints): readonly LabelledConstraint[] {
  const out: LabelledConstraint[] = []
  const add = (kind: ConstraintKind, text: string) =>
    out.push({ kind, text, measured: measurableInEditor(kind) })

  const w = constraints.words
  if (w !== null) {
    if (w.min !== null && w.max !== null) add('words', `${n(w.min)}–${n(w.max)} words`)
    else if (w.max !== null) add('words', `${n(w.max)} words maximum`)
    else if (w.min !== null) add('words', `${n(w.min)} words minimum`)
  }

  const c = constraints.characters
  if (c !== null) {
    // WHETHER SPACES COUNT IS PART OF THE LIMIT, so it is never omitted -- and
    // when the school did not say, the line says that rather than picking one.
    const spaces = c.spacesCount === true ? ' including spaces'
      : c.spacesCount === false ? ' excluding spaces'
      : ' (the school does not state whether spaces count)'
    if (c.min !== null && c.max !== null) add('characters', `${n(c.min)}–${n(c.max)} characters${spaces}`)
    else if (c.max !== null) add('characters', `${n(c.max)} characters maximum${spaces}`)
    else if (c.min !== null) add('characters', `${n(c.min)} characters minimum${spaces}`)
  }

  const p = constraints.pages
  if (p !== null) {
    const spacing = p.spacing === null ? '' : ` (${SPACING_LABELS[p.spacing]})`
    if (p.min !== null && p.max !== null) add('pages', `${n(p.min)}–${n(p.max)} pages${spacing}`)
    else if (p.max !== null) add('pages', `${n(p.max)} page${p.max === 1 ? '' : 's'} maximum${spacing}`)
    else if (p.min !== null) add('pages', `${n(p.min)} page${p.min === 1 ? '' : 's'} minimum${spacing}`)
    else if (p.spacing !== null) add('spacing', SPACING_LABELS[p.spacing])
  }

  const t = constraints.typography
  if (t !== null) {
    if (t.fontSizePt !== null && t.fontFamily !== null) {
      add('font', `${t.fontSizePt}-point ${t.fontFamily}`)
    } else if (t.fontSizePt !== null) add('font', `${t.fontSizePt}-point font`)
    else if (t.fontFamily !== null) add('font', t.fontFamily)
    if (t.marginsInches !== null) add('margins', `${t.marginsInches}-inch margins`)
  }

  const cite = constraints.citation
  if (cite !== null) {
    add('citation', cite.minReferences === null
      ? cite.statedAs
      : `${cite.statedAs}, at least ${n(cite.minReferences)} reference${cite.minReferences === 1 ? '' : 's'}`)
  }

  // Verbatim, last, because they are the ones nothing could structure.
  for (const other of constraints.otherInstructions) add('other', other)

  return out
}

export function labelledConstraints(constraints: Constraints): readonly LabelledConstraint[] {
  return describe(constraints)
}

/** The same requirements as plain sentences. */
export function constraintLines(constraints: Constraints): readonly string[] {
  return describe(constraints).map((line) => line.text)
}

/** What a reader is told when the school stated no length requirement at all. */
export const NO_STATED_LENGTH = 'No length requirement stated'

/** A one-line summary for a card, or the no-requirement sentence. */
export function constraintSummary(constraints: Constraints): string {
  const lines = constraintLines(constraints)
  return lines.length === 0 ? NO_STATED_LENGTH : lines.join(' · ')
}

/** Whether the unmeasured-requirements notice belongs on screen. */
export function showUnmeasuredNotice(constraints: Constraints): boolean {
  return unmeasurableKinds(constraints).length > 0
}

/**
 * The live counter's own label, e.g. "412 / 2,500 characters including spaces".
 *
 * NO LIMIT MEANS NO SLASH. "412 words" is the whole label when the school
 * stated nothing, because "412 / --" invites a reader to wonder what the
 * missing number is.
 */
export function liveCountLabel(input: {
  readonly kind: LiveCount
  readonly constraints: Constraints
  readonly words: number
  readonly text: string
}): string {
  if (input.kind === 'words') {
    const max = input.constraints.words?.max ?? null
    return max === null ? `${n(input.words)} words` : `${n(input.words)} / ${n(max)} words`
  }
  const c = input.constraints.characters
  const count = characterCount(input.text, c?.spacesCount ?? null)
  const suffix = c?.spacesCount === false ? ' excluding spaces'
    : c?.spacesCount === true ? ' including spaces'
    : ''
  const max = c?.max ?? null
  return max === null
    ? `${n(count)} characters${suffix}`
    : `${n(count)} / ${n(max)} characters${suffix}`
}
