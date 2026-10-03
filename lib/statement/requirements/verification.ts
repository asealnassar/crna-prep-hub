/**
 * Where a requirement came from, and whether this product vouches for it.
 *
 * THE DEFAULT IS "WE DO NOT KNOW". A requirement arrives here as research --
 * somebody read a programme page and wrote down what it said -- and research is
 * not policy. An admissions requirement shown to an applicant as fact, which
 * then turns out to be last cycle's wording, costs them an application. So
 * `unverified` is the starting state, it is the state every entry derived from
 * a spreadsheet is in, and activatableForApplicants() below refuses it.
 *
 * VERBATIM IS A SEPARATE FACT FROM VERIFIED. A paraphrase can be accurate and a
 * quotation can be stale. `verbatim` says whether the stored text is the
 * school's own words; `status` says whether anybody has confirmed it is current.
 * Collapsing them would let a summary be presented as a quotation, which is the
 * specific failure the Arkansas State entry was written to avoid.
 *
 * CONFLICTING IS ITS OWN STATUS, NOT A NOTE ON AN OTHERWISE FINE ENTRY. When two
 * official pages disagree -- and in the research they do, one saying three
 * single-spaced pages and another three double-spaced -- there is no correct
 * single value to store. Picking one silently is the worst available option, so
 * the status records the disagreement and both readings travel in `notes`.
 */

export type VerificationStatus =
  /** Nobody has checked this against a primary source. Research only. */
  | 'unverified'
  /** Checked once, but something about it needs a human decision. */
  | 'needs-review'
  /** Confirmed against the school's own current published materials. */
  | 'verified'
  /** Two sources disagree. No single value is correct. */
  | 'conflicting'

export const VERIFICATION_LABELS: Readonly<Record<VerificationStatus, string>> = {
  unverified: 'Unverified research',
  'needs-review': 'Needs review',
  verified: 'Verified',
  conflicting: 'Sources conflict',
}

/**
 * What an applicant is told about an entry's standing.
 *
 * WRITTEN TO BE READ BY SOMEBODY APPLYING, not by whoever maintains the
 * catalog. Each one ends by sending them to their own application materials,
 * because that is the only source that is authoritative for them.
 */
export const VERIFICATION_NOTICES: Readonly<Record<VerificationStatus, string>> = {
  unverified:
    'This requirement has not been verified against the school’s official materials. '
    + 'Treat it as a starting point and confirm the current requirements yourself.',
  'needs-review':
    'This requirement is under review. Confirm the current requirements in your own '
    + 'application materials before relying on it.',
  verified:
    'Confirmed against the school’s published materials on the date shown. Requirements '
    + 'change between cycles — check your own application materials.',
  conflicting:
    'Published sources disagree about this requirement. Both readings are shown below. '
    + 'Confirm which applies to you before writing to either.',
}

export interface Verification {
  readonly status: VerificationStatus
  /** The page this was read from. null when nobody recorded one. */
  readonly sourceUrl: string | null
  /** ISO date (YYYY-MM-DD) the check was made. null when never checked. */
  readonly verifiedOn: string | null
  /** True only when the stored text is the school's own words, unaltered. */
  readonly verbatim: boolean
}

/** Research with no source and no date: what a spreadsheet row becomes. */
export const UNVERIFIED: Verification = {
  status: 'unverified',
  sourceUrl: null,
  verifiedOn: null,
  verbatim: false,
}

/**
 * Whether this entry may be shown to applicants as a catalog requirement.
 *
 * THREE CONDITIONS, ALL REQUIRED, AND NO WAY TO OVERRIDE THEM. A status of
 * 'verified' that carries no source URL and no date is a claim with nothing
 * behind it -- somebody set a field -- so the source and the date are part of
 * the test rather than metadata beside it.
 *
 * FAILS CLOSED. Anything that is not exactly this shape is not activatable,
 * including a malformed date and an entry whose sources conflict.
 */
export function activatableForApplicants(verification: Verification): boolean {
  return verification.status === 'verified'
    && typeof verification.sourceUrl === 'string'
    && verification.sourceUrl.length > 0
    && isIsoDate(verification.verifiedOn)
}

/** YYYY-MM-DD, and a real calendar date. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * How the stored requirement text may be described in the interface.
 *
 * THE TWO STRINGS ARE NOT INTERCHANGEABLE and this function is the only place
 * that chooses between them, so no component can decide on its own to call a
 * summary a quotation.
 */
export function textAttribution(verification: Verification): string {
  return verification.verbatim
    ? 'Quoted from the school’s application materials.'
    : 'A summary of published requirements, not the school’s exact wording.'
}

/** Whether a reader must be warned before they read a requirement as fact. */
export function needsVerificationWarning(verification: Verification): boolean {
  return !activatableForApplicants(verification)
}

/**
 * What the editor says about a saved requirement that is not the catalog's
 * current published one.
 *
 * ONE SENTENCE FOR EVERY REASON, deliberately. The applicant does not need to
 * know -- and must not be told, because it would describe the catalog's
 * contents and this product's confidence in them -- whether their school
 * reworded the prompt, whether the entry was withdrawn, whether nobody has
 * verified it, or whether the row was edited directly. What they need to know
 * is the same in all four cases: these are the instructions saved with this
 * draft, they are not being presented as the school's current requirement, and
 * the analysis will not treat them as such.
 *
 * IT DOES NOT ACCUSE. A draft whose school simply reworded its prompt is the
 * commonest reason to see this, and that is nobody's fault.
 */
export const SAVED_COPY_NOTICE =
  'These are the instructions saved with this draft. They have not been confirmed against '
  + 'the school’s currently published requirements, so they are shown for your reference '
  + 'and the analysis will not treat them as verified. Check your own application materials.'
