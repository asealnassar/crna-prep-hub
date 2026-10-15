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
  DEFAULT_ENFORCEMENT, type LiveCount, type Overage, hasStructuredLengthBound,
  hasTruncationPolicy, isStrict, truncatedKinds,
} from './constraints.ts'
import {
  capabilityOfKind, fontFamilyCapability, measuredKind, resolveRequirementCapabilities,
  type Capability,
} from '../layout/capabilities.ts'

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

/**
 * What a surface does about one requirement.
 *
 * ---------------------------------------------------------------------------
 * THREE THINGS CAN HAPPEN TO A STATED REQUIREMENT, NOT TWO
 * ---------------------------------------------------------------------------
 * 'counted'  the editor produces a live figure for it -- words, characters,
 *            pages -- and the status bar is watching it.
 * 'applied'  the editor DOES it, by rendering: the spacing, the type size, the
 *            margins. There is nothing to watch because there is nothing the
 *            applicant can get wrong.
 * 'manual'   the editor can neither measure it nor render it, so it is the
 *            applicant's to apply: a citation style, a length the school never
 *            said was a limit.
 *
 * THE BOOLEAN COLLAPSED THE LAST TWO. Both rendered as an outlined chip, so
 * Drexel's "12-point Times New Roman" -- which the Studio typesets exactly --
 * looked identical to Keiser's "AMA format", which it cannot touch. An
 * applicant could not tell what was being done for them, and the only thing
 * telling them was a sentence repeating the chips underneath.
 */
export type ConstraintRegister = 'counted' | 'applied' | 'manual'

const REGISTER_FOR_CAPABILITY: Readonly<Record<Capability, ConstraintRegister>> = {
  measured: 'counted',
  applied: 'applied',
  // A SUBSTITUTED FONT IS STILL APPLIED. The substitution is disclosed where
  // the font is chosen; it is not a thing the applicant has to go and do.
  substituted: 'applied',
  manual: 'manual',
}

/** One stated requirement, as a sentence, tagged with what we do about it. */
export interface LabelledConstraint {
  readonly kind: ConstraintKind
  readonly text: string
  /**
   * Whether the Studio produces a live figure for this.
   *
   * ASKED OF THE CAPABILITY TABLE, not hardcoded here. It used to be true for
   * words and characters alone, which stopped being right when the editor
   * started laying out the page and measuring it.
   *
   * KEPT AS `register === 'counted'`, for callers that only need the number.
   */
  readonly measured: boolean
  readonly register: ConstraintRegister
}

/**
 * Every stated requirement, in display order.
 *
 * MEASURED FIRST, deliberately: the applicant reads the two numbers the editor
 * is actually watching before the ones they have to check themselves.
 */
function describe(constraints: Constraints): readonly LabelledConstraint[] {
  const out: LabelledConstraint[] = []
  /*
    `capability` IS PASSED ONLY WHERE THE KIND CANNOT ANSWER.

    'font' stands for two fields with different answers -- the SIZE is applied
    by rendering, the FAMILY only if we ship it -- so a chip naming a family
    resolves the family's own capability and everything else asks the table.
  */
  const add = (kind: ConstraintKind, text: string, capability?: Capability) => {
    const resolved = capability ?? capabilityOfKind(kind)
    out.push({
      kind,
      text,
      measured: measuredKind(kind),
      register: REGISTER_FOR_CAPABILITY[resolved],
    })
  }

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
      add('font', `${t.fontSizePt}-point ${t.fontFamily}`, fontFamilyCapability(t.fontFamily))
    } else if (t.fontSizePt !== null) add('font', `${t.fontSizePt}-point font`)
    else if (t.fontFamily !== null) {
      add('font', t.fontFamily, fontFamilyCapability(t.fontFamily))
    }
    if (t.marginsInches !== null) add('margins', `${t.marginsInches}-inch margins`)
  }

  const cite = constraints.citation
  if (cite !== null) {
    add('citation', cite.minReferences === null
      ? cite.statedAs
      : `${cite.statedAs}, at least ${n(cite.minReferences)} reference${cite.minReferences === 1 ? '' : 's'}`)
  }

  /*
    THE LENGTH THE SCHOOL STATED AND THIS PRODUCT DOES NOT BOUND.

    THE LINE CARRIES THE REFUSAL, not just the quotation. "1-2 pages" on its
    own reads as a limit; an applicant has to be told in the same breath that
    the editor is not holding them to it, because the school never said it was
    a rule. Hence the quotation marks and the clause after the dash.

    AND NOT AT ALL ONCE A BOUND EXISTS. Eight documents carry this prose
    alongside a bound normalised out of the same sentence, so the card showed
    "500-1,000 words" and, beside it, that sentence "not enforced here" -- two
    claims about one requirement with one of them false. A normalised bound IS
    the answer, so the refusal line goes away entirely; the school's own words
    are still on the card, under `statedWordings`, where they are attribution
    rather than a competing rule.

    DECIDED BY THE DATA, by whether a bound was normalised. A length left as
    prose because the source genuinely does not say keeps its line, and no
    school is named anywhere in this decision.
  */
  const shown = hasStructuredLengthBound(constraints) ? null : constraints.unenforcedLength
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

/**
 * Whether anything this school stated still needs a human.
 *
 * NARROW BY CONSTRUCTION. It is true only when the resolver found a field the
 * Studio can neither measure nor render -- a citation style, a font we do not
 * embed -- and false for a school whose whole requirement the Studio applies
 * and checks. The blanket version of this was true for almost everyone.
 */
export function needsManualReview(constraints: Constraints): boolean {
  return resolveRequirementCapabilities(constraints).manualReview.length > 0
}

// ---------------------------------------------------------------------------
// The school's own wording about length
// ---------------------------------------------------------------------------

/**
 * The school's own words out of a `*_stated_as` value, or null.
 *
 * ---------------------------------------------------------------------------
 * THE COLUMN HOLDS TWO THINGS, AND ONLY ONE OF THEM IS A QUOTATION
 * ---------------------------------------------------------------------------
 * The normaliser records WHY a figure was classified as it was, and it records
 * it in front of the fragment it classified:
 *
 *     length used adjectivally: "200 word limit"
 *     explicit bound: "maximum"
 *     target marker: "not labeled a maximum"
 *
 * The first half is this product's vocabulary. The second is the school's. The
 * whole string was being rendered under the heading "The school's wording",
 * so 58 of 79 documents showed an applicant a classification label and told
 * them their school wrote it -- with the nested quotes rendering mangled on
 * top.
 *
 * So the basis is stripped and the quotation kept. A value with no quoted
 * fragment yields NULL rather than a cleaned-up version of the basis: if the
 * school's words were never captured, the honest output is nothing at all.
 *
 * 'target marker: "not labeled a maximum"' IS WITHHELD TOO. Its quoted half is
 * the researcher describing what the school did NOT say, which is the opposite
 * of a quotation from them. The test below is what excludes it: a length a
 * school published always carries a figure.
 *
 * THE SAME SPLIT HAPPENS UPSTREAM. scripts/normalize_statement_catalog.py now
 * stores the quotation in the column and keeps the basis as a research note,
 * so a regenerated catalog needs none of this. This stays because the applied
 * production catalog still holds the old two-part values.
 */
export function statedAsQuote(statedAs: string | null | undefined): string | null {
  if (typeof statedAs !== 'string') return null
  const trimmed = statedAs.trim()
  if (trimmed.length === 0) return null
  // The LAST double-quoted run, so a basis containing quotes cannot win.
  const quoted = [...trimmed.matchAll(/"([^"]+)"/g)]
  if (quoted.length > 0) {
    const text = quoted[quoted.length - 1]![1]!.trim()
    /*
      AND IT HAS TO BE A LENGTH, NOT A CLASSIFIER THE RESEARCHER QUOTED.

      Several entries quote the single word the classification turned on --
      `explicit bound: "maximum"`. Printing that under "The school's wording"
      is no longer jargon, but it is still not what the school said about the
      length: it is one word out of a sentence nobody recorded. A quotation
      that carries no figure and is barely a phrase is withheld, which leaves
      the chip -- "2 pages maximum (double-spaced)" -- to say the whole thing.
    */
    // A FIGURE, OR A SENTENCE LONG ENOUGH TO BE ONE. Every length a school
    // publishes carries a number; a short quoted phrase without one is the
    // researcher's note about what they could not find -- "not labeled a
    // maximum" -- and is not something the school said.
    const carriesLength = /\d/.test(text) || text.split(/\s+/).length >= 6
    return text.length > 0 && carriesLength ? text : null
  }
  // NO QUOTED FRAGMENT AT ALL. A bare value is either the school's whole
  // sentence -- which is what the column was meant to hold -- or a basis with
  // nothing attached. A basis always ends in a colon-separated label, so one
  // that does not look like our own vocabulary is treated as the school's.
  return /^(length used|explicit |target marker|implicit |inferred )/i.test(trimmed)
    ? null
    : trimmed
}

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
    // THE QUOTATION ONLY, NEVER THE BASIS. See statedAsQuote().
    const stated = statedAsQuote(limit?.statedAs ?? null)
    if (stated !== null && !out.includes(stated)) out.push(stated)
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
  // THE SAME TEST THE FLAG BELOW APPLIES, so a caller that reads the sentence
  // and a caller that asks whether to show one cannot disagree. A requirement
  // whose length was normalised into a bound is enforced, and nothing here may
  // say it is not.
  if (hasStructuredLengthBound(constraints)) return null
  return shown.verbatim ? UNENFORCED_LENGTH_NOTICE : UNENFORCED_LENGTH_SUMMARY_NOTICE
}

/**
 * Whether that notice belongs on screen.
 *
 * ---------------------------------------------------------------------------
 * NOT WHEN A STRUCTURED BOUND ALREADY ANSWERS THE SAME QUESTION
 * ---------------------------------------------------------------------------
 * `unenforcedLength` is the prose a school published when nobody could tell
 * what the figure MEANT, and its notice says so: "nothing is checked against
 * it". Eight documents carry that prose AND a structured bound normalised from
 * the same sentence -- Arkansas State's "500-1,000 words" is stored as a word
 * range and kept as prose. The editor then enforced the range in the status bar
 * and, directly beneath, told the applicant it was "not enforced here, because
 * the school does not say whether it is a limit".
 *
 * Both statements about one requirement, and one of them false. Once a bound
 * has been normalised it IS the answer, so the prose stops claiming otherwise.
 *
 * DECIDED BY THE DATA. A document whose length was deliberately left as prose
 * -- because the source genuinely does not say -- carries no bound, so its
 * notice is untouched. No school is named.
 */
export function showUnenforcedLengthNotice(constraints: Constraints): boolean {
  if (constraints.unenforcedLength === null) return false
  return !hasStructuredLengthBound(constraints)
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

/**
 * How a RANGE reads, per register.
 *
 * A MINIMUM IS A REQUIREMENT TOO. The counter used to read only `.max`, so a
 * school asking for 100-200 words was shown "154 / 200" -- which says nothing
 * about the floor and reads as though 20 words would be fine.
 */
const RANGE_COUNTER: Readonly<Record<Enforcement, (lo: string, hi: string) => string>> = {
  truncated: (lo, hi) => `required ${lo}–${hi}`,
  enforced: (lo, hi) => `required ${lo}–${hi}`,
  target: (lo, hi) => `${lo}–${hi} stated`,
  suggested: (lo, hi) => `${lo}–${hi} suggested`,
  unknown: (lo, hi) => `${lo}–${hi} stated, not confirmed as a limit`,
}

/** How a lone MINIMUM reads, per register. */
const MINIMUM_COUNTER: Readonly<Record<Enforcement, (lo: string) => string>> = {
  truncated: (lo) => `at least ${lo} required`,
  enforced: (lo) => `at least ${lo} required`,
  target: (lo) => `at least ${lo} stated`,
  suggested: (lo) => `at least ${lo} suggested`,
  unknown: (lo) => `at least ${lo} stated, not confirmed as a limit`,
}

/**
 * The live counter for one unit, against whatever bounds the school stated.
 *
 * GENERIC OVER THE SHAPE OF THE BOUND -- a maximum, a minimum, or both. The
 * three cases are one function because a school choosing to state a floor is
 * not a special case of anything; it is just a different pair of numbers.
 */
function countedAgainst(input: {
  readonly count: number
  readonly unit: string
  readonly min: number | null
  readonly max: number | null
  readonly enforcement: Enforcement
}): string {
  const { count, unit, min, max, enforcement } = input
  if (min !== null && max !== null) {
    return `${n(count)} ${unit} — ${RANGE_COUNTER[enforcement](n(min), n(max))}`
  }
  if (max !== null) return boundSuffix(n(count), unit, max, enforcement)
  if (min !== null) {
    return `${n(count)} ${unit} — ${MINIMUM_COUNTER[enforcement](n(min))}`
  }
  return `${n(count)} ${unit}`
}

/**
 * Where a live count sits against its bounds.
 *
 * ---------------------------------------------------------------------------
 * COMPUTED FROM THE SAME BOUNDS AS THE LABEL, DELIBERATELY
 * ---------------------------------------------------------------------------
 * The counter said "154 / 200" and the thing that coloured it read a different
 * field entirely -- a legacy single maximum carried on the draft -- so a school
 * with a structured 100-200 range got a number with no bound in it and no
 * warning at any count. One function per question, over one set of bounds, is
 * what stops the two disagreeing.
 *
 * 'none' IS NOT 'within'. A school that stated no bound has nothing to be
 * inside of, and colouring that green would claim a check nobody asked for.
 */
export type LiveCountStatus = 'under' | 'within' | 'over' | 'none'

export function liveCountStatus(input: {
  readonly kind: LiveCount
  readonly constraints: Constraints
  readonly words: number
  readonly text: string
}): LiveCountStatus {
  const bound = input.kind === 'words'
    ? input.constraints.words
    : input.constraints.characters
  const count = input.kind === 'words'
    ? input.words
    : characterCount(input.text, input.constraints.characters?.spacesCount ?? null)
  const min = bound?.min ?? null
  const max = bound?.max ?? null
  if (min === null && max === null) return 'none'
  // OVER BEFORE UNDER. A count cannot be both, and the maximum is the bound an
  // applicant is likelier to be refused for.
  if (max !== null && count > max) return 'over'
  if (min !== null && count < min) return 'under'
  return 'within'
}

/**
 * The verdict in words, or null when there is nothing to say.
 *
 * ---------------------------------------------------------------------------
 * A REGISTER DECIDES WHETHER CROSSING A NUMBER IS A BREACH
 * ---------------------------------------------------------------------------
 * The editor used to append " — over the maximum" from liveCountStatus alone.
 * That status says only which side of a bound the count is on; it says nothing
 * about whether the bound is a rule. So a school that wrote "a 700 word essay"
 * -- a length, not a limit -- told an applicant at 701 words that they were
 * over a maximum their school never set, while the very same screen described
 * the requirement as "500–700 stated".
 *
 * The wording therefore lives here, with every other sentence that depends on
 * the register, and the component renders what it is given. An advisory length
 * still reports where the count sits, because that is useful; it just does not
 * call it a violation.
 *
 * null MEANS SAY NOTHING: inside the bounds, or no bound at all.
 */
export function liveCountVerdict(input: {
  readonly kind: LiveCount
  readonly constraints: Constraints
  readonly words: number
  readonly text: string
}): string | null {
  const status = liveCountStatus(input)
  if (status === 'none' || status === 'within') return null
  const bound = input.kind === 'words'
    ? input.constraints.words
    : input.constraints.characters
  const enforcement = bound?.enforcement ?? DEFAULT_ENFORCEMENT
  const binding = enforcement === 'enforced' || enforcement === 'truncated'
  if (status === 'over') {
    return binding ? ' — over the maximum' : ' — longer than the stated length'
  }
  return binding ? ' — under the minimum' : ' — shorter than the stated length'
}

export function liveCountLabel(input: {
  readonly kind: LiveCount
  readonly constraints: Constraints
  readonly words: number
  readonly text: string
}): string {
  if (input.kind === 'words') {
    const w = input.constraints.words
    return countedAgainst({
      count: input.words,
      unit: 'words',
      min: w?.min ?? null,
      max: w?.max ?? null,
      enforcement: w?.enforcement ?? DEFAULT_ENFORCEMENT,
    })
  }
  const c = input.constraints.characters
  const count = characterCount(input.text, c?.spacesCount ?? null)
  // WHETHER SPACES COUNT IS PART OF THE NUMBER, so it stays attached to it
  // whatever shape the bound has.
  const suffix = c?.spacesCount === false ? ' excluding spaces'
    : c?.spacesCount === true ? ' including spaces'
    : ''
  const min = c?.min ?? null
  const max = c?.max ?? null
  const label = countedAgainst({
    count, unit: 'characters', min, max,
    enforcement: c?.enforcement ?? DEFAULT_ENFORCEMENT,
  })
  // The qualifier belongs with the unit, before any bound clause.
  return min !== null && max !== null
    ? label.replace(' — ', `${suffix} — `)
    : min === null && max === null ? `${label}${suffix}`
      : label.includes(' — ') ? label.replace(' — ', `${suffix} — `) : `${label}${suffix}`
}
