/**
 * A verified import plan becomes a draft resume.
 *
 * ONLY WHAT TRACED CLEANLY IS WRITTEN IN. `buildImportPlan` has already dropped
 * anything the organiser asserted but the source did not contain, and set aside
 * anything that traced only loosely. This turns what survived into a ResumeV2.
 *
 * WHAT DID NOT SURVIVE IS NOT THROWN AWAY EITHER. Uncertain values and lines
 * the organiser could not place go into a HIDDEN custom section titled
 * "Imported — needs review". Hidden means it does not print, so nothing
 * unreviewed can reach a programme; keeping it means the applicant's own words
 * are still in their resume, where they can move them somewhere sensible and
 * delete the rest. Guessing where they belong is the one thing we may not do.
 *
 * EVERY PIECE OF PROSE IS MARKED 'import'. That is what stops imported text
 * being mistaken for something the applicant typed here, and -- via the rule in
 * factSheet.ts -- what lets it legitimately ground an AI proposal, which text
 * an AI wrote may not.
 *
 * Pure. Ids and timestamps are injected, so the same plan always produces the
 * same resume.
 */

import { createResume } from '../model/resume.ts'
import { createAuthoredText } from '../model/authoredText.ts'
import { createClinicalPosition, createSection, parseGpa } from '../model/sections.ts'
import { parseResumeDate, parseResumeDateRange } from '../model/dates.ts'
import type { ImportReference, ResumeSectionV2, ResumeV2 } from '../model/types.ts'
import type { ImportPlan } from './organise.ts'

export const REVIEW_SECTION_HEADING = 'Imported — needs review'

export interface DraftIds {
  readonly resumeId: string
  /** One id per section and entry the plan needs. Consumed in order. */
  readonly pool: readonly string[]
}

/** Splits a date string the extractor produced into a range, without guessing. */
function rangeFrom(raw: string) {
  const parts = raw.split(/\s*(?:–|—|-|to)\s*/i).filter((p) => p.trim() !== '')
  const current = /present|current/i.test(raw)
  return parseResumeDateRange({
    start: parts[0] ?? '',
    end: current ? '' : (parts[1] ?? ''),
    isCurrent: current,
  })
}

/**
 * The draft.
 *
 * Sections are created only when the plan actually produced content for them.
 * An import that found no certifications does not add an empty Certifications
 * section, because an empty visible section is a defect the applicant would
 * then have to clean up after us.
 */
export function draftFromPlan(input: {
  readonly plan: ImportPlan
  readonly userId: string
  readonly title: string
  readonly ids: DraftIds
  readonly now: string
  readonly importedFrom: ImportReference
}): ResumeV2 {
  const { plan, ids, now } = input
  const organised = plan.organised

  let cursor = 0
  const nextId = () => ids.pool[cursor++] ?? `${ids.resumeId}-${cursor}`

  const sections: ResumeSectionV2[] = []

  if (organised.summary.trim() !== '') {
    sections.push({
      ...createSection('summary', nextId()),
      text: createAuthoredText(organised.summary, 'import'),
    } as ResumeSectionV2)
  }

  const withContent = organised.education.filter(
    (e) => e.degree || e.field || e.institution || e.graduated
  )
  if (withContent.length > 0) {
    sections.push({
      ...createSection('education', nextId()),
      entries: withContent.map((e) => ({
        id: nextId(),
        degree: e.degree, field: e.field, institution: e.institution, location: e.location,
        graduationDate: parseResumeDate(e.graduated),
        // A GPA is never inferred from an imported document, and the switch that
        // would print one stays off.
        overallGpa: parseGpa(''), scienceGpa: parseGpa(''), honors: '',
      })),
    } as ResumeSectionV2)
  }

  const positions = organised.positions.filter((p) => p.employer || p.role || p.bullets.length > 0)
  if (positions.length > 0) {
    sections.push({
      ...createSection('critical_care', nextId()),
      positions: positions.map((p) => {
        const position = createClinicalPosition(nextId(), {
          employer: p.employer, role: p.role, unit: p.unit,
          location: p.location, dates: rangeFrom(p.dates),
        })
        return { ...position, bullets: p.bullets.map((b) => createAuthoredText(b, 'import')) }
      }),
    } as ResumeSectionV2)
  }

  const licenses = organised.licenses.filter((l) => l.licenseType || l.state)
  if (licenses.length > 0) {
    sections.push({
      ...createSection('licensure', nextId()),
      licenses: licenses.map((l) => ({
        id: nextId(), licenseType: l.licenseType, state: l.state,
        // Never inferred: an import that did not state a number does not get one.
        identifier: '', isCompact: false, expires: { kind: 'absent' as const },
      })),
    } as ResumeSectionV2)
  }

  const certifications = organised.certifications.filter((c) => c.name)
  if (certifications.length > 0) {
    sections.push({
      ...createSection('certifications', nextId()),
      certifications: certifications.map((c) => ({
        id: nextId(), name: c.name, issuer: c.issuer, identifier: '',
        earned: { kind: 'absent' as const }, expires: { kind: 'absent' as const },
      })),
    } as ResumeSectionV2)
  }

  for (const type of ['leadership', 'quality_improvement', 'research', 'volunteer', 'awards', 'publications', 'shadowing'] as const) {
    const forType = organised.entries.filter((e) => e.section === type)
    if (forType.length === 0) continue
    const section = buildEntrySection(type, forType, nextId, now)
    if (section) sections.push(section)
  }

  const review = reviewSection(plan, nextId)
  if (review) sections.push(review)

  const base = createResume({
    id: ids.resumeId,
    userId: input.userId,
    title: input.title,
    sectionIds: Array.from({ length: 20 }, (_, i) => `${ids.resumeId}-seed-${i}`),
    now,
  })

  return {
    ...base,
    contact: {
      fullName: organised.contact.fullName ?? '',
      credentials: organised.contact.credentials ?? '',
      email: organised.contact.email ?? '',
      phone: organised.contact.phone ?? '',
      city: organised.contact.city ?? '',
      state: organised.contact.state ?? '',
      linkedin: '', website: '',
    },
    sections,
    importedFrom: input.importedFrom,
  }
}

function buildEntrySection(
  type: 'leadership' | 'quality_improvement' | 'research' | 'volunteer' | 'awards' | 'publications' | 'shadowing',
  entries: readonly { title: string; organization: string; dates: string; detail: string }[],
  nextId: () => string,
  _now: string
): ResumeSectionV2 | null {
  const base = createSection(type, nextId())

  switch (type) {
    case 'awards':
      return {
        ...base,
        awards: entries.map((e) => ({
          id: nextId(), title: e.title || e.organization, issuer: e.organization,
          awarded: parseResumeDate(e.dates), detail: createAuthoredText(e.detail, 'import'),
        })),
      } as ResumeSectionV2
    case 'publications':
      return {
        ...base,
        entries: entries.map((e) => ({
          id: nextId(), title: e.title, venue: e.organization, kind: '',
          date: parseResumeDate(e.dates), citation: createAuthoredText(e.detail, 'import'),
        })),
      } as ResumeSectionV2
    case 'shadowing':
      return {
        ...base,
        experiences: entries.map((e) => ({
          id: nextId(), providerName: e.title, credential: '', setting: '',
          facility: e.organization, hours: '', dates: rangeFrom(e.dates),
          reflection: createAuthoredText(e.detail, 'import'),
        })),
      } as ResumeSectionV2
    case 'quality_improvement':
    case 'research':
      return {
        ...base,
        entries: entries.map((e) => ({
          id: nextId(), title: e.title, role: '', organization: e.organization,
          dates: rangeFrom(e.dates), detail: createAuthoredText(e.detail, 'import'),
        })),
      } as ResumeSectionV2
    default:
      return {
        ...base,
        entries: entries.map((e) => ({
          id: nextId(), role: e.title, organization: e.organization,
          dates: rangeFrom(e.dates), detail: createAuthoredText(e.detail, 'import'),
        })),
      } as ResumeSectionV2
  }
}

/**
 * Everything the import could not place, kept and hidden.
 *
 * HIDDEN, not omitted and not printed. Omitting it would quietly lose a line
 * from someone's resume; printing it would put unreviewed text in front of a
 * programme. Hidden, it renders nowhere and is one click from being read,
 * moved and deleted.
 */
function reviewSection(plan: ImportPlan, nextId: () => string): ResumeSectionV2 | null {
  const items = [
    ...plan.uncertain.map((value) => value.value),
    ...plan.unmapped,
  ].filter((text, i, all) => text.trim() !== '' && all.indexOf(text) === i)

  if (items.length === 0) return null

  return {
    ...createSection('custom', nextId(), { visible: false, heading: REVIEW_SECTION_HEADING }),
    heading: REVIEW_SECTION_HEADING,
    visible: false,
    entries: items.map((text) => ({
      id: nextId(), title: '', detail: createAuthoredText(text, 'import'),
    })),
  } as ResumeSectionV2
}
