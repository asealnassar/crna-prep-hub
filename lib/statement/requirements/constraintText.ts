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
  SPACING_LABELS, characterCount, type ConstraintKind, type Constraints, type Enforcement,
  type LiveCount, type Overage, hasTruncationPolicy, isStrict, measurableInEditor,
  truncatedKinds, unmeasurableKinds,
} from './constraints.ts'

/** 1,000 rather than 1000, consistently, wherever a limit is shown. */
function n(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * How a bound is named, by register.
 *
 * THE WORD "MAXIMUM" IS RESERVED FOR BOUNDS THAT ARE ONE. A suggested length is
 * a "suggested maximum", a target is not a maximum at all, and an unknown
 * register says so rather than picking. These strings are the entire difference
 * between quoting a school and inventing a rule for it, so they are literal and
 * there is no fall-through default that could quietly promote one.
 */
const MAXIMUM_LABELS: Readonly<Record<Enforcement, (amount: string) => string>> = {
  truncated: (amount) => `${amount} maximum`,
  enforced: (amount) => `${amount} maximum`,
  target: (amount) => `${amount} (the stated length, not a maximum)`,
  suggested: (amount) => `${amount} suggested`,
  unknown: (amount) => `${amount} stated, without saying whether it is a limit`,
}

const MINIMUM_LABELS: Readonly<Record<Enforcement, (amount: string) => string>> = {
  truncated: (amount) => `${amount} minimum`,
  enforced: (amount) => `${amount} minimum`,
  target: (amount) => `${amount} (the stated length, not a minimum)`,
  suggested: (amount) => `${amount} suggested`,
  unknown: (amount) => `${amount} stated, without saying whether it is a limit`,
}

const RANGE_LABELS: Readonly<Record<Enforcement, (amount: string) => string>> = {
  truncated: (amount) => amount,
  enforced: (amount) => amount,
  target: (amount) => `${amount} (the stated length, not a limit)`,
  suggested: (amount) => `${amount} suggested`,
  unknown: (amount) => `${amount} stated, without saying whether it is a limit`,
}

/**
 * The sentence a register adds, when it adds one.
 *
 * APPENDED RATHER THAN SUBSTITUTED, so the number stays legible at a glance and
 * the qualification is unmissable. Nothing is added for a plain enforced limit,
 * because "500 words maximum" already says everything.
 */
function truncationSuffix(enforcement: Enforcement): string {
  return enforcement === 'truncated' ? ' — the school reads only this much' : ''
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
    const e = w.enforcement
    const tail = truncationSuffix(e)
    if (w.min !== null && w.max !== null) {
      add('words', RANGE_LABELS[e](`${n(w.min)}–${n(w.max)} words`) + tail)
    } else if (w.max !== null) {
      add('words', MAXIMUM_LABELS[e](`${n(w.max)} words`) + tail)
    } else if (w.min !== null) {
      add('words', MINIMUM_LABELS[e](`${n(w.min)} words`) + tail)
    }
  }

  const c = constraints.characters
  if (c !== null) {
    // WHETHER SPACES COUNT IS PART OF THE LIMIT, so it is never omitted -- and
    // when the school did not say, the line says that rather than picking one.
    const spaces = c.spacesCount === true ? ' including spaces'
      : c.spacesCount === false ? ' excluding spaces'
      : ' (the school does not state whether spaces count)'
    const e = c.enforcement
    const tail = truncationSuffix(e)
    if (c.min !== null && c.max !== null) {
      add('characters', RANGE_LABELS[e](`${n(c.min)}–${n(c.max)} characters`) + spaces + tail)
    } else if (c.max !== null) {
      add('characters', MAXIMUM_LABELS[e](`${n(c.max)} characters`) + spaces + tail)
    } else if (c.min !== null) {
      add('characters', MINIMUM_LABELS[e](`${n(c.min)} characters`) + spaces + tail)
    }
  }

  const p = constraints.pages
  if (p !== null) {
    const spacing = p.spacing === null ? '' : ` (${SPACING_LABELS[p.spacing]})`
    const e = p.enforcement
    const tail = truncationSuffix(e)
    if (p.min !== null && p.max !== null) {
      add('pages', RANGE_LABELS[e](`${n(p.min)}–${n(p.max)} pages`) + spacing + tail)
    } else if (p.max !== null) {
      add('pages',
        MAXIMUM_LABELS[e](`${n(p.max)} page${p.max === 1 ? '' : 's'}`) + spacing + tail)
    } else if (p.min !== null) {
      add('pages',
        MINIMUM_LABELS[e](`${n(p.min)} page${p.min === 1 ? '' : 's'}`) + spacing + tail)
    } else if (p.spacing !== null) add('spacing', SPACING_LABELS[p.spacing])
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

  // THE LENGTH THE SCHOOL STATED AND THIS PRODUCT DOES NOT BOUND.
  //
  // THE LINE CARRIES THE REFUSAL, not just the quotation. "1-2 pages" on its
  // own reads as a limit; an applicant has to be told in the same breath that
  // the editor is not holding them to it, because the school never said it was
  // a rule. Hence the quotation marks and the clause after the dash.
  const shown = constraints.unenforcedLength
  if (shown !== null) {
    // QUOTATION MARKS ONLY FOR A QUOTATION. A summary gets the label that says
    // what it is, and no quote marks at all -- so an applicant can never read a
    // paraphrase as the school's sentence.
    const attributed = shown.verbatim
      ? `The school states: \u201c${shown.text}\u201d`
      : `Recorded requirement, not the school\u2019s exact wording: ${shown.text}`
    add('unenforced-length',
      `${attributed} \u2014 not enforced here, because the school does not say whether it is `
      + 'a limit')
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

// ---------------------------------------------------------------------------
// The school's own wording about length
// ---------------------------------------------------------------------------

/**
 * Every length sentence the school published, verbatim, in display order.
 *
 * KEPT OUT OF describe() DELIBERATELY. A chip reading "250 words suggested" has
 * to stay a chip; a full quotation belongs in the detail view and in the
 * analyser's prompt, where there is room for it. Splitting them means the short
 * form can never be the only thing an applicant sees when the classification is
 * arguable -- the quotation is one tap away and says what the school said.
 *
 * ONLY WHAT WAS RECORDED. No sentence is synthesised from the numbers, so an
 * entry whose researcher did not capture the wording yields nothing here rather
 * than a plausible-looking paraphrase.
 */
export function statedWordings(constraints: Constraints): readonly string[] {
  const out: string[] = []
  for (const limit of [constraints.words, constraints.characters, constraints.pages]) {
    const stated = limit?.statedAs ?? null
    if (stated !== null && stated.trim().length > 0 && !out.includes(stated)) out.push(stated)
  }
  // THE UNENFORCED LENGTH IS A STATED WORDING TOO, and the most important one:
  // it is the ONLY thing published about that document's length, because no
  // bound is stored beside it.
  //
  // VERBATIM ONLY. This function's output is rendered under the heading "The
  // school's wording", which is a quotation claim; a summary has no business
  // there and reaches the applicant through its own constraint line instead,
  // labelled as a summary.
  const unenforced = constraints.unenforcedLength
  if (unenforced !== null && unenforced.verbatim
      && unenforced.text.trim().length > 0 && !out.includes(unenforced.text)) {
    out.push(unenforced.text)
  }
  return out
}

/** Whether the shown length is the school's own words rather than a summary. */
export function unenforcedLengthIsVerbatim(constraints: Constraints): boolean {
  return constraints.unenforcedLength?.verbatim === true
}

// ---------------------------------------------------------------------------
// Going past a bound
// ---------------------------------------------------------------------------

/**
 * What an applicant is told when a bound has been passed.
 *
 * FIVE REGISTERS, FIVE SENTENCES, AND NO SHARED "OVER THE LIMIT" STRING. This
 * is the requirement in plain form: a draft 40 words past UC Davis's suggested
 * length and a draft 40 words past Maryland's hard cap must not read the same,
 * because only one of them has broken a rule. The strict pair say so; the rest
 * report the difference without calling it a breach.
 *
 * NO UNIT IS CONVERTED AND NO ADVICE IS GIVEN. These sentences state a measured
 * count against a stored number. They do not suggest how much to cut, which is
 * the applicant's judgement, and they never mention pages.
 */
export function overageMessage(overage: Overage): string {
  const unit = overage.kind === 'words' ? 'words' : 'characters'
  const count = `${n(overage.count)} ${unit}`
  const bound = `${n(overage.max)} ${unit}`
  const by = `${n(overage.over)} ${overage.over === 1 ? unit.slice(0, -1) : unit}`
  switch (overage.enforcement) {
    case 'truncated':
      return `${count}: ${by} past the school’s ${bound} limit. The school states it reads `
        + 'only up to the limit, so anything beyond it may not be read at all.'
    case 'enforced':
      return `${count}: ${by} over the school’s stated maximum of ${bound}.`
    case 'target':
      return `${count}: ${by} more than the ${bound} the school describes. The school states `
        + 'that length without calling it a maximum, so this is not a breach of a stated limit.'
    case 'suggested':
      return `${count}: ${by} more than the ${bound} the school suggests. A suggested length `
        + 'is not a maximum.'
    case 'unknown':
      return `${count}: ${by} more than the ${bound} the school states. The school does not `
        + 'say whether that figure is a limit, so treat it as unconfirmed.'
  }
}

/** The same for a bound not yet reached. */
export function shortfallMessage(shortfall: Overage): string {
  const unit = shortfall.kind === 'words' ? 'words' : 'characters'
  const count = `${n(shortfall.count)} ${unit}`
  const bound = `${n(shortfall.max)} ${unit}`
  if (isStrict(shortfall.enforcement)) {
    return `${count}: below the school’s stated minimum of ${bound}.`
  }
  return `${count}: below the ${bound} the school describes, which it does not state as a `
    + 'minimum.'
}

/**
 * The school's own truncation warning, when it published one.
 *
 * SAYS WHAT THE SCHOOL SAID AND NOTHING MORE. It does not claim this draft is
 * over, because the truncated bound is usually a page count and this system has
 * no way to know. An applicant reading it is being told a policy, not given a
 * measurement.
 */
export function truncationNotice(constraints: Constraints): string | null {
  if (!hasTruncationPolicy(constraints)) return null
  const kinds = truncatedKinds(constraints)
  const quoted = statedWordings(constraints)
  const limits = kinds.map((kind) => {
    if (kind === 'words') return `${n(constraints.words!.max ?? 0)} words`
    if (kind === 'characters') return `${n(constraints.characters!.max ?? 0)} characters`
    const max = constraints.pages!.max
    return max === null ? 'the page limit' : `${n(max)} page${max === 1 ? '' : 's'}`
  })
  const head = `This school states that it reads only the first ${limits.join(' / ')}. `
    + 'Anything beyond that may not be read.'
  return quoted.length === 0 ? head : `${head} The school’s wording: “${quoted[0]}”`
}

/**
 * What a reader is told when a length is shown and not enforced.
 *
 * SAYS WHOSE FIGURE IT IS AND WHY NOTHING IS BEING CHECKED. An applicant who
 * sees a page range and no counter will assume the counter is broken unless
 * told otherwise, and the honest reason is that the school did not say whether
 * the figure is a limit. It also tells them where to settle it, which is the
 * only place that can: their own application materials.
 */
export const UNENFORCED_LENGTH_NOTICE =
  'This school publishes a length but does not say whether it is a maximum, a minimum or a '
  + 'suggestion, so this editor shows you their wording and checks nothing against it. '
  + 'Confirm what applies to you in your own application materials.'

/**
 * The same, for a length recorded as a summary rather than quoted.
 *
 * TWO REASONS TO CHECK YOUR OWN MATERIALS, NOT ONE. For a quoted instruction
 * the open question is only what the figure MEANS. For a summary it is also
 * whether the wording is right, and an applicant is entitled to know which
 * situation they are in.
 */
export const UNENFORCED_LENGTH_SUMMARY_NOTICE =
  'This school publishes a length but does not say whether it is a maximum, a minimum or a '
  + 'suggestion, so nothing is checked against it. What is shown is a RECORDED SUMMARY of '
  + 'their requirement, not their exact wording — read the school’s own instructions before '
  + 'relying on it.'

/** The right notice for this requirement, or null when there is no such length. */
export function unenforcedLengthNotice(constraints: Constraints): string | null {
  const shown = constraints.unenforcedLength
  if (shown === null) return null
  return shown.verbatim ? UNENFORCED_LENGTH_NOTICE : UNENFORCED_LENGTH_SUMMARY_NOTICE
}

/** Whether that notice belongs on screen. */
export function showUnenforcedLengthNotice(constraints: Constraints): boolean {
  return constraints.unenforcedLength !== null
}

/** What a reader is told once, when any stated length is softer than a rule. */
export const ADVISORY_LENGTH_NOTICE =
  'Some of this school’s lengths are guidance rather than limits. This editor shows the '
  + 'school’s own wording beside each one — it does not treat a suggested or stated length '
  + 'as a maximum.'

/**
 * The live counter's own label, e.g. "412 / 2,500 characters including spaces".
 *
 * NO LIMIT MEANS NO SLASH. "412 words" is the whole label when the school
 * stated nothing, because "412 / --" invites a reader to wonder what the
 * missing number is.
 *
 * AND NO SLASH FOR A LENGTH THAT IS NOT A LIMIT. "412 / 250 words" is the shape
 * of a quota and reads as one at a glance, which is exactly wrong for a
 * suggestion -- so a non-strict bound is shown in parentheses with the register
 * named: "412 words (250 suggested)". The counter keeps counting either way;
 * only its framing changes.
 */
function boundSuffix(
  count: string, unit: string, max: number, enforcement: Enforcement,
): string {
  if (isStrict(enforcement)) return `${count} / ${n(max)} ${unit}`
  const register = enforcement === 'suggested' ? 'suggested'
    : enforcement === 'target' ? 'the stated length'
    : 'stated, not confirmed as a limit'
  return `${count} ${unit} (${n(max)} ${register})`
}

export function liveCountLabel(input: {
  readonly kind: LiveCount
  readonly constraints: Constraints
  readonly words: number
  readonly text: string
}): string {
  if (input.kind === 'words') {
    const w = input.constraints.words
    const max = w?.max ?? null
    if (max === null) return `${n(input.words)} words`
    return boundSuffix(n(input.words), 'words', max, w!.enforcement)
  }
  const c = input.constraints.characters
  const count = characterCount(input.text, c?.spacesCount ?? null)
  const suffix = c?.spacesCount === false ? ' excluding spaces'
    : c?.spacesCount === true ? ' including spaces'
    : ''
  const max = c?.max ?? null
  if (max === null) return `${n(count)} characters${suffix}`
  return boundSuffix(n(count), 'characters', max, c!.enforcement) + suffix
}
