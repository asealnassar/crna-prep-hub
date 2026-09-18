/**
 * The grounding envelope: everything one AI proposal is allowed to know.
 *
 * A model call receives a FactSheet and nothing else -- not the resume, not the
 * contact block, not a free-form context object. If a fact is not in the sheet,
 * the model has never seen it. V1 did the reverse: it sent an unstructured blob
 * and a prompt demanding "measurable outcomes", so the numbers on the page came
 * from nowhere.
 *
 * THREE RULES THIS FILE ENFORCES, each of them tested.
 *
 * 1. NOTHING DERIVED. No years-of-experience arithmetic, no counts, no totals.
 *    "Years of experience" is on the prohibited list precisely because it is so
 *    easy to compute and so easy to get wrong, and a computed fact in the sheet
 *    is indistinguishable to the model from one a person typed.
 *
 * 2. NOTHING AI-AUTHORED. A Fact's provenance admits 'user' and 'import' only,
 *    so the type already forbids it -- but text that an AI wrote and a person
 *    accepted is still AI-authored, and letting that SENTENCE back in as
 *    grounding would launder a fabrication into a fact over two turns.
 *
 *    Two cases that look alike and are not. Text the applicant STORED is theirs
 *    and may ground what comes next, even where an assistant later tightened it
 *    -- their own words are still recorded underneath, and
 *    `factsFromApplicantSource` reads those rather than the proposal. A NEW
 *    candidate is a different thing entirely: it is never in the sheet it is
 *    checked against, because it is verified before it is anything at all. Text
 *    being improved is likewise passed to the prompt SEPARATELY, as the subject.
 *
 * 3. NOTHING OUT OF SCOPE. One position's sheet carries that position's facts.
 *    A proposal for one bullet cannot see another job, another applicant's
 *    anything, or the rest of the resume.
 */

import {
  factFromValue, factSheet, factsFromValues,
} from '../model/facts.ts'
import type { Fact, FactSheet } from '../model/facts.ts'
import { isAiAuthored, isBlankAuthoredText } from '../model/authoredText.ts'
import { descriptorFor } from '../studio/fields.ts'
import type { AuthoredText } from '../model/authoredText.ts'
import { formatDateRange, formatResumeDate } from '../document/format.ts'
import type {
  ClinicalPosition, ResumeSectionType, ResumeSectionV2, ResumeV2,
} from '../model/types.ts'

/**
 * Text a person is responsible for, or nothing.
 *
 * Blank text contributes no fact. AI-authored text contributes no fact either,
 * however genuinely the applicant accepted it -- see rule 2 above.
 */
function factsFromAuthored(
  text: AuthoredText | undefined,
  kind: Fact['kind'],
  path: string
): Fact[] {
  if (!text || isBlankAuthoredText(text) || isAiAuthored(text)) return []
  return factFromValue(text.accepted, kind, path, text.userOrigin === 'import' ? 'import' : 'user')
}

/**
 * The applicant's own words behind a piece of stored text.
 *
 * `factsFromAuthored` discards AI-accepted text whole, which is right where the
 * question is "did a person write this sentence". It is wrong where the question
 * is "what has this applicant told us about this job": someone who wrote a
 * bullet and then let an assistant tighten it has not stopped having written it.
 * Their source is kept in `userSource` precisely so it stays recoverable, and it
 * is what grounds here -- never the proposal that replaced it.
 *
 * So an AI sentence can never support the next generation, while the applicant's
 * own account of the same work still can. A bullet with no applicant source
 * behind it contributes nothing, which is the recursion closing.
 */
function factsFromApplicantSource(
  text: AuthoredText | undefined,
  kind: Fact['kind'],
  path: string
): Fact[] {
  if (!text || isBlankAuthoredText(text)) return []
  const own = isAiAuthored(text) ? text.userSource : text.accepted
  return factFromValue(own, kind, path, text.userOrigin === 'import' ? 'import' : 'user')
}

/**
 * Facts for one clinical position.
 *
 * The date range is formatted with the document's own formatter rather than a
 * second one, so a model is told the same dates the resume prints. It is the
 * range as supplied -- no duration is computed from it.
 */
export function positionFacts(
  position: ClinicalPosition,
  sectionType: string,
  options: {
    /**
     * Include the bullets the APPLICANT wrote for this position.
     *
     * Off by default, because the caller that improves ONE bullet must not be
     * handed the bullets: there they are the subject, and a claim allowed to
     * ground itself would verify against itself. On for GENERATION, where what
     * they have already written about this job is exactly the context a sixth
     * bullet needs in order not to repeat or contradict the first five.
     *
     * A new candidate is never here. Only STORED text reaches a sheet, and a
     * candidate is checked against this one before it is anything at all.
     */
    readonly includeWrittenBullets?: boolean
  } = {}
): Fact[] {
  const base = `${sectionType}/${position.id}`
  const f = position.facts

  const flags: Fact[] = []
  // A flag becomes a fact only when it is true. A false flag is not a fact
  // that something did not happen; it is the absence of a fact.
  if (f.chargeExperience) flags.push(...factFromValue('Charge nurse experience', 'charge_role', `${base}/charge`))
  if (f.preceptorExperience) flags.push(...factFromValue('Preceptor experience', 'preceptor_role', `${base}/preceptor`))

  const dates = formatDateRange(f.dates)

  return [
    ...factFromValue(f.employer, 'employer', `${base}/employer`),
    ...factFromValue(f.location, 'location', `${base}/location`),
    ...factFromValue(f.role, 'role', `${base}/role`),
    ...factFromValue(f.unit, 'unit_type', `${base}/unit`),
    ...factFromValue(f.unitType, 'unit_type', `${base}/unitType`),
    ...factFromValue(f.acuity, 'acuity', `${base}/acuity`),
    ...factFromValue(dates, 'date_range', `${base}/dates`),
    ...factsFromValues(f.patientPopulations, 'patient_population', `${base}/patientPopulations`),
    ...factsFromValues(f.devices, 'device', `${base}/devices`),
    ...factsFromValues(f.therapies, 'therapy', `${base}/therapies`),
    ...factsFromValues(f.committees, 'committee', `${base}/committees`),
    ...factsFromValues(f.specialResponsibilities, 'responsibility', `${base}/specialResponsibilities`),
    ...flags,
    // What the applicant said in their own words, before anything was written.
    ...position.guided.flatMap((response, i) =>
      factsFromAuthored(response.answer, 'applicant_note', `${base}/guided#${i}`)),
    // Their own words, whoever tightened them afterwards: an assistant's
    // sentence is never a fact, and `factsFromApplicantSource` reads the source
    // recorded underneath it instead. A bullet with no applicant source behind
    // it contributes nothing, which is where the recursion closes.
    ...(options.includeWrittenBullets
      ? position.bullets.flatMap((bullet, i) =>
          factsFromApplicantSource(bullet, 'applicant_note', `${base}/bullets#${i}`))
      : []),
  ]
}

/**
 * The sheet for writing or improving a bullet on one position.
 *
 * `subject` names the field being written, so a proposal is auditable after the
 * fact: it says what it was for, not merely what it produced.
 */
export function factSheetForPosition(
  position: ClinicalPosition,
  sectionType: string,
  options: { readonly includeWrittenBullets?: boolean } = {}
): FactSheet {
  return factSheet(
    `${sectionType}/${position.id}/bullets`,
    [positionFacts(position, sectionType, options)]
  )
}

/**
 * The sheet for tightening the professional summary.
 *
 * THE SUMMARY IS THE GROUNDING. Tightening means rewriting the paragraph the
 * applicant wrote, so what licenses a claim is that paragraph and nothing else.
 *
 * It once spanned the whole resume, on the reasoning that a summary is about
 * the whole applicant. That was the wrong envelope: a fact sheet is permission,
 * so listing a degree, a certification and four employers invited a "tightened"
 * summary to introduce claims the applicant had never made ABOUT THEMSELVES --
 * true statements, in the wrong paragraph, that they never chose to say. The
 * rest of the resume still cross-checks the result, because the verifier
 * refuses anything this sheet cannot support.
 *
 * `factsFromApplicantSource` means a summary an assistant has already tightened
 * grounds in the applicant's own words underneath, never in the last proposal.
 */
export function factSheetForSummary(resume: ResumeV2): FactSheet {
  const summary = resume.sections.find((section) => section.type === 'summary')
  const facts = summary?.type === 'summary'
    ? factsFromApplicantSource(summary.text, 'applicant_note', 'summary/text')
    : []

  return factSheet('summary/text', [facts])
}

/**
 * What a field of one entry is called in fact terms.
 *
 * The descriptor table already says which of an entry's fields are FACTUAL and
 * which are NARRATIVE -- `kind: 'authored'` is the whole distinction. So the
 * grounding for "improve this leadership detail" is simply every non-authored
 * field beside it: the role, the organisation, the dates. Deriving it from the
 * descriptor rather than from a per-section list is what makes a new section
 * type grounded the moment it is declared, and is why there is one entry
 * grounding path rather than one per section.
 */
const FACT_KIND_BY_FIELD: Record<string, Fact['kind']> = {
  organization: 'organization',
  institution: 'organization',
  issuer: 'organization',
  venue: 'organization',
  facility: 'employer',
  providerName: 'employer',
  role: 'role',
  setting: 'unit_type',
  credential: 'credential',
  degree: 'credential',
  field: 'credential',
  licenseType: 'credential',
  name: 'credential',
  state: 'location',
  location: 'location',
  hours: 'applicant_metric',
}

function factKindFor(fieldName: string, kind: string): Fact['kind'] {
  if (kind === 'date' || kind === 'daterange') return 'date_range'
  return FACT_KIND_BY_FIELD[fieldName] ?? 'applicant_note'
}

/**
 * Facts for one entry of a list-shaped section.
 *
 * Narrative fields are excluded -- prose is not grounding, whoever wrote it.
 * The one being rewritten reaches the prompt as the text to rewrite and the
 * verifier as already-present, so listing it here as well would let a claim
 * support itself.
 */
export function entryFacts(
  sectionType: ResumeSectionType,
  entry: Record<string, unknown>,
  base: string
): Fact[] {
  const descriptor = descriptorFor(sectionType).entry
  if (!descriptor) return []

  const facts: Fact[] = []
  for (const field of descriptor.fields) {
    if (field.kind === 'authored') continue
    const value = entry[field.name]
    const path = `${base}/${field.name}`

    // A field declared after some records were written is ABSENT on those
    // records, not empty -- education gained a start date long after people had
    // saved degrees. Formatters read `.kind` off the value, so an absent one is
    // treated as no date here rather than read.
    if (field.kind === 'date') {
      const formatted = value ? formatResumeDate(value as never) : ''
      facts.push(...factFromValue(formatted, factKindFor(field.name, field.kind), path))
      continue
    }
    if (field.kind === 'daterange') {
      const formatted = value ? formatDateRange(value as never) : ''
      facts.push(...factFromValue(formatted, factKindFor(field.name, field.kind), path))
      continue
    }
    if (field.kind === 'gpa') {
      // A GPA is not narrative grounding, and the applicant may have chosen not
      // to show it at all.
      continue
    }
    if (field.kind === 'boolean') {
      // A true flag is a fact. A false one is the absence of a fact, not a fact
      // that something did not happen.
      if (value === true) facts.push(...factFromValue(field.label, 'responsibility', path))
      continue
    }
    facts.push(...factFromValue(typeof value === 'string' ? value : '', factKindFor(field.name, field.kind), path))
  }
  return facts
}

/**
 * The sheet for a narrative field on one entry.
 *
 * Returns null when the section has no entries, the entry is gone, or the named
 * field is not narrative -- so a request aimed at a licence number or an
 * institution gets no grounding, and therefore no proposal. That single check
 * is what keeps AI off factual identity fields everywhere at once.
 */
export function factSheetForEntryField(
  section: ResumeSectionV2,
  entryId: string,
  fieldName: string
): FactSheet | null {
  const entryDescriptor = descriptorFor(section.type).entry
  if (!entryDescriptor) return null

  const field = entryDescriptor.fields.find((f) => f.name === fieldName)
  if (!field || field.kind !== 'authored') return null

  const list = (section as unknown as Record<string, Record<string, unknown>[]>)[entryDescriptor.listKey]
  if (!Array.isArray(list)) return null
  const entry = list.find((e) => e.id === entryId)
  if (!entry) return null

  const base = `${section.type}/${entryId}`
  return factSheet(`${base}/${fieldName}`, [entryFacts(section.type, entry, base)])
}

/** Every fact value in the sheet, lower-cased, for the verifier's tracing. */
export function groundedValues(sheet: FactSheet): string[] {
  return sheet.facts.map((f) => f.value.toLowerCase())
}
