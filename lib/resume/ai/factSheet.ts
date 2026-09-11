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
 *    accepted is still AI-authored, and letting it back in as grounding would
 *    launder a fabrication into a fact over two turns. Text being improved is
 *    passed to the prompt SEPARATELY, as the subject, never as grounding.
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
import type { AuthoredText } from '../model/authoredText.ts'
import { formatDateRange } from '../document/format.ts'
import type {
  ClinicalPosition, ResumeSectionV2, ResumeV2, ShadowingEntry,
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
 * Facts for one clinical position.
 *
 * The date range is formatted with the document's own formatter rather than a
 * second one, so a model is told the same dates the resume prints. It is the
 * range as supplied -- no duration is computed from it.
 */
export function positionFacts(position: ClinicalPosition, sectionType: string): Fact[] {
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
  sectionType: string
): FactSheet {
  return factSheet(`${sectionType}/${position.id}/bullets`, [positionFacts(position, sectionType)])
}

/** Facts for one shadowing experience. */
export function shadowingFacts(entry: ShadowingEntry, sectionType = 'shadowing'): Fact[] {
  const base = `${sectionType}/${entry.id}`
  return [
    ...factFromValue(entry.providerName, 'employer', `${base}/providerName`),
    ...factFromValue(entry.credential, 'credential', `${base}/credential`),
    ...factFromValue(entry.setting, 'unit_type', `${base}/setting`),
    ...factFromValue(entry.facility, 'employer', `${base}/facility`),
    // Hours are printed as supplied. "40+" is a real answer and is not a number
    // to be tidied into 40.
    ...factFromValue(entry.hours, 'applicant_metric', `${base}/hours`),
    ...factFromValue(formatDateRange(entry.dates), 'date_range', `${base}/dates`),
    ...factsFromAuthored(entry.reflection, 'applicant_note', `${base}/reflection`),
  ]
}

export function factSheetForShadowing(entry: ShadowingEntry): FactSheet {
  return factSheet(`shadowing/${entry.id}/reflection`, [shadowingFacts(entry)])
}

/**
 * The sheet for tightening the professional summary.
 *
 * A summary is about the whole applicant, so this is the one sheet that spans
 * sections -- and it is still built from named fields, never from the resume
 * object. Nothing is counted, nothing is totalled, and no span of years is
 * derived from the dates it includes.
 */
export function factSheetForSummary(resume: ResumeV2): FactSheet {
  const facts: Fact[] = []

  for (const section of resume.sections) {
    if (!section.visible) continue

    if (section.type === 'critical_care' || section.type === 'other_clinical') {
      for (const position of section.positions) {
        facts.push(...positionFacts(position, section.type))
      }
    }

    if (section.type === 'education') {
      for (const entry of section.entries) {
        const base = `education/${entry.id}`
        facts.push(
          ...factFromValue(entry.degree, 'credential', `${base}/degree`),
          ...factFromValue(entry.field, 'credential', `${base}/field`),
          ...factFromValue(entry.institution, 'organization', `${base}/institution`),
        )
      }
    }

    if (section.type === 'certifications') {
      for (const entry of section.certifications) {
        facts.push(...factFromValue(entry.name, 'credential', `certifications/${entry.id}/name`))
      }
    }

    if (section.type === 'licensure') {
      for (const entry of section.licenses) {
        facts.push(
          ...factFromValue(entry.licenseType, 'credential', `licensure/${entry.id}/type`),
          ...factFromValue(entry.state, 'location', `licensure/${entry.id}/state`),
        )
      }
    }
  }

  return factSheet('summary/text', [facts])
}

/** The sheet for any section the generic builders cover. */
export function factSheetForSection(section: ResumeSectionV2): FactSheet {
  if (section.type === 'critical_care' || section.type === 'other_clinical') {
    return factSheet(`${section.type}/bullets`, [
      section.positions.flatMap((p) => positionFacts(p, section.type)),
    ])
  }
  if (section.type === 'shadowing') {
    return factSheet('shadowing/reflection', [section.experiences.flatMap((e) => shadowingFacts(e))])
  }
  return factSheet(`${section.type}`, [[]])
}

/** Every fact value in the sheet, lower-cased, for the verifier's tracing. */
export function groundedValues(sheet: FactSheet): string[] {
  return sheet.facts.map((f) => f.value.toLowerCase())
}
