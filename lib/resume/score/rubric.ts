/**
 * The Writing Quality half: 60 points, judged by a model.
 *
 * WHAT IT JUDGES. How well the applicant's experience is PRESENTED. Not how
 * impressive it is, not how much of it there is, and never anything about
 * admission. A nurse with two years in a small community ICU can score full
 * marks here by describing their actual work precisely; a nurse with ten years
 * of the rarest experience in the state scores badly if their bullets say
 * "provided patient care".
 *
 * ELIGIBILITY IS NOT THE MODEL'S DECISION. Which categories can legitimately be
 * judged is worked out from the resume, here, before the call -- and enforced
 * again after it. If the applicant has recorded no leadership, Leadership
 * framing is NOT ASSESSED whatever the model returns, because a model told
 * "mark it not assessed" might still return a 2, and a 2 out of 8 for having no
 * leadership is exactly the penalty the design forbids. The prompt asks; the
 * code decides.
 *
 * Everything except the call itself is pure and tested.
 */

import { planDocument } from '../document/plan.ts'
import { CATEGORIES, category, categoriesOf } from './types.ts'
import type { CategoryId, CategoryResult } from './types.ts'
import { withoutAdmissionsClaims } from './language.ts'
import type { ResumeV2 } from '../model/types.ts'

const WRITING_CATEGORY_IDS = categoriesOf('writing-quality').map((c) => c.id)

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/** Why a category cannot be judged, or null when it can. */
export type Eligibility = Readonly<Record<CategoryId, string | null>>

/**
 * What there is to judge.
 *
 * Each reason is written for the applicant, because it appears in place of a
 * score. "Not assessed — you have not recorded any leadership experience" is a
 * neutral fact; "0 out of 8" would be an accusation.
 */
export function rubricEligibility(resume: ResumeV2): Eligibility {
  const visible = resume.sections.filter((s) => s.visible)
  const plan = planDocument(resume)

  const prose = plan.blocks.some((block) =>
    block.kind === 'prose' ? block.paragraphs.length > 0 : block.entries.some((e) => e.detail.length > 0)
  )

  const clinical = visible.some(
    (s) => (s.type === 'critical_care' || s.type === 'other_clinical') && s.positions.length > 0
  )

  const leadership = visible.some((s) => {
    if (s.type === 'leadership') return s.entries.length > 0
    if (s.type === 'quality_improvement' || s.type === 'research') return s.entries.length > 0
    if (s.type === 'critical_care' || s.type === 'other_clinical') {
      return s.positions.some(
        (p) => p.facts.chargeExperience || p.facts.preceptorExperience ||
          p.facts.committees.length > 0 || p.facts.specialResponsibilities.length > 0
      )
    }
    return false
  })

  const noProse = 'You have not written any bullets or descriptions yet.'

  return {
    'section-completeness': null,
    'contact-completeness': null,
    'date-integrity': null,
    'content-hygiene': null,
    'length-and-fit': null,
    'clinical-specificity': prose ? null : noProse,
    'accomplishment-focus': prose ? null : noProse,
    'critical-care-presentation': clinical
      ? null
      : 'You have not added a critical care or other clinical position yet.',
    'leadership-framing': leadership
      ? null
      : 'You have not recorded any leadership, precepting or committee work. This is not counted against you.',
    'clarity-and-tone': prose ? null : noProse,
    'organisation-readability': plan.blocks.length >= 2
      ? null
      : 'There is only one section on the resume, so there is no ordering to judge yet.',
  }
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export interface RubricPrompt {
  readonly system: string
  readonly user: string
}

export function rubricSystemPrompt(): string {
  return [
    'You review how well a CRNA-school applicant has WRITTEN their resume.',
    '',
    'You are judging PRESENTATION, never the person and never their experience.',
    'A nurse with two years in a small community ICU can score full marks by',
    'describing their actual work precisely. A nurse with ten years of rare',
    'experience scores badly if their lines read like a job description.',
    '',
    'You must never:',
    '- say or imply anything about admission, acceptance, chances or competitiveness',
    '- claim what programmes require, expect or look for',
    '- reduce a score because the applicant lacks a GPA, a certification, a number',
    '  of shadowing hours, leadership, research, publications, or any other',
    '  experience they simply do not have',
    '- reduce Accomplishment focus because a line has no figures in it. If a figure',
    '  would help, say so as an improvement, not as a deduction.',
    '- invent anything about the applicant that is not in the resume below',
    '',
    'If a category has nothing legitimate to judge, return it with "notAssessed"',
    'and a short reason instead of a score. Never score such a category zero.',
    '',
    'For every category you DO score, return all four of: score, strengths,',
    'weaknesses, improvements. Improvements must be specific and actionable —',
    '"rewrite the second bullet on the ICU role to say what you decided" beats',
    '"add more detail".',
    '',
    'Reply with JSON only, in exactly this shape:',
    '{"categories":[{"id":"...","score":0,"strengths":["..."],"weaknesses":["..."],"improvements":["..."]}]}',
    'A not-assessed category takes the form {"id":"...","notAssessed":"reason"}.',
    'No prose outside the JSON. No markdown fence.',
  ].join('\n')
}

/**
 * The resume as a reader sees it, plus the categories to judge.
 *
 * Built from the same document plan the renderer uses, so the model reviews
 * what would actually print -- not the raw record, and not the applicant's
 * contact details, which have no bearing on writing quality and do not need to
 * leave the server.
 */
export function rubricUserPrompt(resume: ResumeV2, eligibility: Eligibility): string {
  const plan = planDocument(resume)
  const lines: string[] = ['THE RESUME AS IT WOULD PRINT:', '']

  for (const block of plan.blocks) {
    lines.push(`## ${block.heading}`)
    if (block.kind === 'prose') {
      lines.push(...block.paragraphs)
    } else {
      for (const entry of block.entries) {
        const header = [entry.title, entry.subtitle, entry.meta].filter((p) => p !== '').join(' — ')
        if (header) lines.push(header)
        for (const detail of entry.detail) lines.push(`- ${detail}`)
      }
    }
    lines.push('')
  }

  if (plan.blocks.length === 0) lines.push('(the resume is empty)', '')

  lines.push('SCORE THESE CATEGORIES:')
  for (const id of WRITING_CATEGORY_IDS) {
    const definition = CATEGORIES.find((c) => c.id === id)!
    const reason = eligibility[id]
    lines.push(
      reason
        ? `- ${id} (max ${definition.maxPoints}) — NOT ASSESSABLE: ${reason} Return it as notAssessed.`
        : `- ${id} (max ${definition.maxPoints}) — ${definition.measures}`
    )
  }

  return lines.join('\n')
}

export function buildRubricPrompt(resume: ResumeV2): RubricPrompt {
  return {
    system: rubricSystemPrompt(),
    user: rubricUserPrompt(resume, rubricEligibility(resume)),
  }
}

// ---------------------------------------------------------------------------
// Reading the reply
// ---------------------------------------------------------------------------

export interface RubricParse {
  readonly categories: readonly CategoryResult[]
  /** Lines removed for making a claim about admission. Logged, never shown. */
  readonly droppedLines: number
}

const MAX_LINE = 600
const MAX_LINES = 6

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v !== '' && v.length <= MAX_LINE)
    .slice(0, MAX_LINES)
}

/**
 * Turns a model reply into category results, or falls back to not-assessed.
 *
 * NEVER THROWS AND NEVER TRUSTS. A malformed reply produces categories marked
 * not assessed rather than zeros, because a parsing failure is our problem and
 * charging the applicant points for it would be absurd. Eligibility is applied
 * last and wins outright: whatever the model said about a category the resume
 * cannot support, the answer is "not assessed".
 */
export function parseRubric(raw: unknown, eligibility: Eligibility): RubricParse {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(stripFence(value))
    } catch {
      value = null
    }
  }

  const body = (typeof value === 'object' && value !== null && !Array.isArray(value))
    ? (value as Record<string, unknown>)
    : {}
  const rows = Array.isArray(body.categories) ? body.categories : []

  const byId = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const entry = row as Record<string, unknown>
    if (typeof entry.id === 'string') byId.set(entry.id, entry)
  }

  let dropped = 0
  const clean = (value: unknown): string[] => {
    const before = strings(value)
    const after = withoutAdmissionsClaims(before)
    dropped += before.length - after.length
    return after
  }

  const categories = WRITING_CATEGORY_IDS.map((id) => {
    const reason = eligibility[id]
    // Eligibility wins. A model that scored an absent category is overruled.
    if (reason) return category(id, null, { notAssessed: reason })

    const row = byId.get(id)
    if (!row) {
      return category(id, null, { notAssessed: 'The reviewer did not return this category.' })
    }
    if (typeof row.notAssessed === 'string' && row.notAssessed.trim() !== '') {
      return category(id, null, { notAssessed: clean([row.notAssessed])[0] ?? 'Nothing to assess.' })
    }
    if (typeof row.score !== 'number' || !Number.isFinite(row.score)) {
      return category(id, null, { notAssessed: 'The reviewer did not return a usable score.' })
    }

    return category(id, row.score, {
      strengths: clean(row.strengths),
      weaknesses: clean(row.weaknesses),
      improvements: clean(row.improvements),
    })
  })

  return { categories, droppedLines: dropped }
}

/** Every writing category as not-assessed. Used when the call cannot be made. */
export function rubricUnavailable(reason: string): CategoryResult[] {
  return WRITING_CATEGORY_IDS.map((id) => category(id, null, { notAssessed: reason }))
}

function stripFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text)
  return fenced ? fenced[1] : text
}
