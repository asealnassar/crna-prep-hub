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
  /**
   * What an active entry was published on.
   *
   * ---------------------------------------------------------------------------
   * TWO KINDS OF EVIDENCE ARE NOT ONE KIND
   * ---------------------------------------------------------------------------
   * An entry checked against the school's own published page and an entry
   * published from an applicant's submission are both "verified" in the sense
   * that somebody took responsibility for them. They are not equally reliable,
   * and an applicant deciding how much to trust a prompt needs to know which
   * one they are looking at.
   *
   * Migration 011 widened what may stand as evidence so that a submitted
   * prompt can be published at all. Widening it is only safe while the
   * difference stays visible, which is what this field is for: it is stored,
   * never inferred, and the interface reads it.
   *
   * 'official-source' IS THE DEFAULT for every row that says nothing, because
   * that is what every row written before 011 was.
   */
  readonly evidenceKind: EvidenceKind
}

/** Where an active entry's authority comes from. */
export type EvidenceKind = 'official-source' | 'admin-approved-submission'

/**
 * The evidence kind a stored or transmitted row is actually claiming.
 *
 * ---------------------------------------------------------------------------
 * ONE PARSER, BECAUSE EVERY COPY OF THIS DECISION WAS A PLACE IT COULD BE LOST
 * ---------------------------------------------------------------------------
 * Four modules rebuilt a Verification from untrusted data and three of them
 * wrote `evidenceKind: 'official-source'` as a literal, discarding whatever the
 * row said. The browser proof was the New Draft dialog: the API returned
 * `admin-approved-submission`, the view layer handles it correctly, and the
 * client's own parser overwrote it one hop earlier -- so an applicant's
 * approved submission was presented as "Confirmed against the school's
 * published materials".
 *
 * THE DEFAULT IS FOR ABSENCE, NOT FOR DOUBT. Every row written before
 * migration 011 has no such column, and those rows ARE official-source
 * research. A value that is present but unrecognised is a different thing: it
 * was written by something this build does not understand, and it is not
 * evidence this build may describe. It gets the same answer as absence here
 * and is prevented from becoming a claim by textAttribution, which requires a
 * real source URL before it will say anything was checked against a school.
 */
export function evidenceKindFrom(value: unknown): EvidenceKind {
  return value === 'admin-approved-submission' ? 'admin-approved-submission' : 'official-source'
}

/** Research with no source and no date: what a spreadsheet row becomes. */
export const UNVERIFIED: Verification = {
  status: 'unverified',
  sourceUrl: null,
  verifiedOn: null,
  verbatim: false,
  evidenceKind: 'official-source',
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
  if (verification.status !== 'verified') return false
  if (!isIsoDate(verification.verifiedOn)) return false
  /*
    TWO KINDS OF EVIDENCE, AS 20261008_011'S CHECK STATES THEM.

    THIS USED TO DEMAND A SOURCE URL FROM EVERY SET, which was right while
    official-source was the only kind of evidence and became wrong the moment a
    prompt could be published from an applicant's submission. Such a set has no
    source URL and never will -- that is what makes it the other kind -- so this
    judged it unactivatable, needsVerificationWarning() went true, and the
    reader was shown the WARNING slot filled with the `verified` sentence:
    "Confirmed against the school's published materials on the date shown."

    A reassurance in the warning position, about a set whose wording nobody
    checked against any published page. The rule is widened here to match the
    database's, and the sentence it produces is chosen by evidenceNotice().
  */
  if (verification.evidenceKind === 'admin-approved-submission') return true
  return typeof verification.sourceUrl === 'string' && verification.sourceUrl.length > 0
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
  /*
    AN APPROVED SUBMISSION SAYS SO, FIRST.

    "Quoted from the school's application materials" is a claim about where the
    words came from, and for a published submission it is one nobody has
    checked: the wording came from an applicant, and CRNAPREPHUB approved it
    without seeing the school's own page. Saying that plainly is the price of
    being able to publish these at all.
  */
  if (verification.evidenceKind === 'admin-approved-submission') {
    return verification.verbatim
      ? 'Submitted by an applicant as their school’s wording, and approved by '
        + 'CRNAPREPHUB. Not checked against the school’s own published page.'
      : 'Submitted by an applicant and approved by CRNAPREPHUB. Not checked '
        + 'against the school’s own published page.'
  }
  /*
    AND NOTHING HERE READS sourceUrl, DELIBERATELY.

    This function answers "whose words are these" -- verbatim or summary. How
    much anyone has CONFIRMED them is the notice's question, and
    activatableForApplicants already refuses to activate an official-source row
    with no source URL, so such a row carries its warning there. Folding the
    two together was tried and made a paraphrase from a sourceless research row
    stop describing itself as a paraphrase, which is a different claim going
    missing.
  */
  return verification.verbatim
    ? 'Quoted from the school’s application materials.'
    : 'A summary of published requirements, not the school’s exact wording.'
}

/**
 * The verification that applies to ONE requirement inside a set.
 *
 * ---------------------------------------------------------------------------
 * THE STRONGER CAVEAT OF THE TWO, NEVER THE WEAKER
 * ---------------------------------------------------------------------------
 * textAttribution and evidenceNotice answer from a Verification, and a
 * Verification was built from the SET's row. That is right for a set whose
 * documents all came from the same place and wrong for a mixed one: a school's
 * genuine official set that has gained a document reported by an applicant
 * would describe that document as "Quoted from the school's application
 * materials", which is the same false claim migration 011 was written to stop,
 * arriving one level down.
 *
 * SO A REQUIREMENT MAY ONLY EVER STRENGTHEN THE CAVEAT. An origin submission
 * upgrades the evidence to 'admin-approved-submission' for this document;
 * nothing here can turn a submission-backed set into an official-source one,
 * and a requirement with no origin is returned UNCHANGED -- so an official
 * document in an official set is never relabelled, which is the other half of
 * being truthful about a mixed set.
 *
 * EVERY OTHER FIELD IS THE SET'S. The status, the source URL and the date are
 * statements about the set's currency and remain so; only the kind of evidence
 * is a statement about where these particular words came from.
 */
export function requirementVerification(
  set: Verification,
  requirement: { readonly originSubmissionId: string | null },
): Verification {
  if (requirement.originSubmissionId === null) return set
  if (set.evidenceKind === 'admin-approved-submission') return set
  return { ...set, evidenceKind: 'admin-approved-submission' }
}

/** Whether a reader must be warned before they read a requirement as fact. */
export function needsVerificationWarning(verification: Verification): boolean {
  return !activatableForApplicants(verification)
}

/**
 * What to tell a reader about where this requirement came from, or null.
 *
 * ---------------------------------------------------------------------------
 * THE NOTICE CANNOT BE KEYED ON `status` ALONE
 * ---------------------------------------------------------------------------
 * VERIFICATION_NOTICES answers "how confident is anyone that this is current",
 * and for 'verified' its answer is a reassurance. That is the right sentence
 * for a set checked against a school's own page and the wrong one for a set
 * published from an applicant's submission -- which is equally "verified" in
 * the sense that somebody took responsibility, and not at all verified in the
 * sense the sentence means.
 *
 * So evidence is consulted first, and it produces its own sentence rather than
 * borrowing one. An unverified or conflicting set still gets its own notice,
 * because those are statements about currency and apply whatever the evidence
 * was.
 *
 * NULL MEANS SAY NOTHING, which is the common case: a verified set with a
 * source URL needs no caveat beyond the attribution line.
 */
export function evidenceNotice(verification: Verification): string | null {
  if (verification.evidenceKind === 'admin-approved-submission') {
    return 'This prompt was submitted by an applicant and approved by CRNAPREPHUB. '
      + 'It has not been checked against the school’s own published page — confirm '
      + 'it in your own application materials.'
  }
  if (needsVerificationWarning(verification)) {
    return VERIFICATION_NOTICES[verification.status]
  }
  return null
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
