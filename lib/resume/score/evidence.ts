/**
 * How much there is to judge -- measured by code, never by the reviewer.
 *
 * WHY THIS EXISTS. The writing rubric judges presentation, and a reviewer asked
 * to judge presentation rated a 28-word summary and a bare job title at 83-92%.
 * That resume scored 85. So the amount of developed content sets a CEILING on
 * the clinical categories and, more gently, on clarity and organisation. The
 * reviewer still decides quality beneath the ceiling; it cannot decide that a
 * resume says more than it does.
 *
 * WHAT IT NEVER READS. Nothing optional counts for or against. Leadership
 * framing is not capped here: when none is recorded it stays excluded.
 *
 * Pure: the same resume always yields the same evidence and ceilings.
 */

import { planDocument } from '../document/plan.ts'
import type { ResumeV2 } from '../model/types.ts'
import { category } from './types.ts'
import type { CategoryId, CategoryResult } from './types.ts'

/** A role bullet needs this many words before it describes any work. */
export const SUBSTANTIVE_WORDS = 6

export function countWords(text: string): number {
  return (text.match(/\S+/g) ?? []).length
}

/** How much one bullet counts: nothing under six words, 0.6 up to nine, then 1. */
export function bulletWeight(words: number): number {
  if (words >= 10) return 1
  if (words >= SUBSTANTIVE_WORDS) return 0.6
  return 0
}

const LADDER: readonly (readonly [number, number])[] = [[0, 0], [1, 0.45], [2, 0.65], [3, 0.8], [4, 0.9], [5, 1]]

/** The ceiling for a weight of developed bullets: straight lines between steps, full at five. */
export function developedCeiling(weight: number): number {
  if (weight <= 0) return 0
  for (let i = 1; i < LADDER.length; i++) {
    const [x0, y0] = LADDER[i - 1]
    const [x1, y1] = LADDER[i]
    if (weight <= x1) return y0 + ((y1 - y0) * (weight - x0)) / (x1 - x0)
  }
  return 1
}

/** A summary alone may lift the clinical ceilings this far, and no further. */
export function summaryFloor(words: number): number {
  if (words >= 25) return 0.15
  if (words >= 10) return 0.08
  return 0
}

/** Clarity and organisation: a gentle curve, full at eighty written words. */
export function contentCurve(words: number): number {
  return words <= 0 ? 0 : Math.min(1, Math.sqrt(words / 80))
}

// ---------------------------------------------------------------------------
// The wording check -- deliberately narrow
// ---------------------------------------------------------------------------

/**
 * Clinical detail: equipment, therapies, medications, patient groups, units,
 * clinical actions, or a number. A missing term here only matters when the same
 * line also uses a stock phrase, so this list does not need to be exhaustive.
 */
const CONCRETE = new RegExp(String.raw`\b(?:` + [
  'ecmo', 'crrt', 'cvvhd?f?', 'iabp', 'impella', 'balloon pump', 'ventilat\\w*', 'vents?', 'bipap', 'cpap', 'hfov',
  'arterial lines?', 'art lines?', 'central lines?', 'swan[- ]ganz', 'telemetry', 'evd', 'lvad', 'chest tubes?', 'trach\\w*',
  'vasoactive', 'vasopressors?', 'pressors', 'inotropes?', 'sedation', 'paralytics?', 'proning', 'hypothermia',
  'thrombolytics?', 'tpa', 'transfusions?', 'insulin', 'heparin', 'nitroglycerin', 'norepinephrine', 'vasopressin',
  'epinephrine', 'dobutamine', 'milrinone', 'propofol', 'fentanyl', 'nicardipine', 'amiodarone', 'dialysis',
  'sepsis', 'septic', 'ards', 'dka', 'tbi', 'strokes?', 'cardiac arrest', 'cabg', 'transplants?', 'overdoses?',
  'micu', 'sicu', 'cvicu', 'cticu', 'nicu', 'picu', 'icu', 'step[- ]?down', 'pacu',
  'titrat\\w*', 'intubat\\w*', 'extubat\\w*', 'cannulat\\w*', 'resuscitat\\w*', 'defibrillat\\w*', 'cardiovert\\w*',
  'precept\\w*', 'charge nurse', 'rapid response', 'catheteri[sz]ation', 'anticoagulation', 'ha?emodynamic\\w*',
].join('|') + String.raw`)\b|\d`, 'i')

/** Phrases that describe no particular work. Short on purpose. */
const STOCK: readonly RegExp[] = [
  /\bprovided (?:(?:quality|excellent|safe|compassionate|holistic|high[- ]quality|exceptional|patient[- ]cent(?:e|r)ed)\s+)*(?:patient |nursing )?care\b/i,
  /\bresponsible for\b/i,
  /\b(?:various|other|assigned) (?:nursing )?duties\b/i,
  /\bduties (?:included|as assigned)\b/i,
  /\bas (?:needed|assigned|required)\b/i,
  /\bworked (?:closely )?with (?:the )?(?:(?:healthcare|health care|interdisciplinary|multidisciplinary|care)\s+)?team\b/i,
  /\bteam player\b/i,
  /\bhard[- ]working\b/i,
  /\bdetail[- ]oriented\b/i,
  /\bfast[- ]paced environment\b/i,
  /\bstrong work ethic\b/i,
]

export function isConcrete(line: string): boolean {
  return CONCRETE.test(line)
}

export function isStock(line: string): boolean {
  return STOCK.some((pattern) => pattern.test(line))
}

export interface WordingReport {
  readonly concrete: number
  readonly stock: number
  readonly neutral: number
  readonly total: number
  /** Half or more stock, and a fifth or less concrete. Only then does it cap. */
  readonly predominantlyStock: boolean
  /** Multiplies the clinical ceilings: 1 unless predominantly stock, never below 0.35. */
  readonly factor: number
}

/** Classifies lines. A line with clinical detail is concrete even if it also uses a stock phrase. */
export function assessWording(lines: readonly string[]): WordingReport {
  let concrete = 0
  let stock = 0
  for (const line of lines) {
    if (isConcrete(line)) concrete++
    else if (isStock(line)) stock++
  }
  const total = lines.length
  const predominantlyStock = total > 0 && stock / total >= 0.5 && concrete / total <= 0.2
  return {
    concrete, stock, neutral: total - concrete - stock, total, predominantlyStock,
    factor: predominantlyStock ? Math.max(0.35, 1 - stock / total) : 1,
  }
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface ResumeEvidence {
  readonly summaryWords: number
  readonly clinicalPositions: number
  readonly criticalCarePositions: number
  /** Distinct clinical role bullets of six or more words. */
  readonly substantiveRoleBullets: number
  /** Weighted developed bullets across both clinical sections. */
  readonly roleWeight: number
  /** Weighted developed bullets under critical-care positions only. */
  readonly criticalCareWeight: number
  /** Role weight plus half credit for described leadership, project, volunteer and award entries. */
  readonly accomplishmentWeight: number
  /** Summary words plus every distinct description line. */
  readonly writtenWords: number
  /** Sections that would print. */
  readonly sections: number
  readonly wording: WordingReport
}

const CLINICAL = new Set<string>(['critical_care', 'other_clinical'])
const ACCOMPLISHMENT = new Set<string>(['leadership', 'quality_improvement', 'research', 'volunteer', 'awards'])

/** Read from the document plan, so only what would print counts. A repeated line counts once. */
export function measureEvidence(resume: ResumeV2): ResumeEvidence {
  const plan = planDocument(resume)
  const seen = new Set<string>()
  const roleLines: string[] = []
  let summaryWords = 0
  let clinicalPositions = 0
  let criticalCarePositions = 0
  let roleWeight = 0
  let criticalCareWeight = 0
  let entryWeight = 0
  let writtenWords = 0

  for (const block of plan.blocks) {
    if (block.kind === 'prose') {
      const words = block.paragraphs.reduce((n, p) => n + countWords(p), 0)
      if (block.sectionType === 'summary') summaryWords += words
      writtenWords += words
      continue
    }
    const clinical = CLINICAL.has(block.sectionType)
    const critical = block.sectionType === 'critical_care'
    for (const entry of block.entries) {
      if (clinical) clinicalPositions++
      if (critical) criticalCarePositions++
      for (const line of entry.detail) {
        const key = line.trim().toLowerCase().replace(/\s+/g, ' ')
        if (key === '' || seen.has(key)) continue
        seen.add(key)
        const words = countWords(line)
        writtenWords += words
        if (clinical) {
          roleWeight += bulletWeight(words)
          if (critical) criticalCareWeight += bulletWeight(words)
          if (words >= SUBSTANTIVE_WORDS) roleLines.push(line)
        } else if (ACCOMPLISHMENT.has(block.sectionType)) {
          entryWeight += bulletWeight(words)
        }
      }
    }
  }

  return {
    summaryWords, clinicalPositions, criticalCarePositions,
    substantiveRoleBullets: roleLines.length,
    roleWeight, criticalCareWeight,
    accomplishmentWeight: roleWeight + 0.5 * entryWeight,
    writtenWords, sections: plan.blocks.length,
    wording: assessWording(roleLines),
  }
}

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

export type CappedCategoryId =
  | 'clinical-specificity' | 'accomplishment-focus' | 'critical-care-presentation'
  | 'clarity-and-tone' | 'organisation-readability'

/** Each capped category's ceiling, as a share of its maximum. */
export function writingCeilings(evidence: ResumeEvidence): Readonly<Record<CappedCategoryId, number>> {
  const floor = summaryFloor(evidence.summaryWords)
  const factor = evidence.wording.factor
  const content = contentCurve(evidence.writtenWords)
  return {
    'clinical-specificity': Math.max(developedCeiling(evidence.roleWeight), floor) * factor,
    'accomplishment-focus': Math.max(developedCeiling(evidence.accomplishmentWeight), floor) * factor,
    'critical-care-presentation': evidence.criticalCarePositions === 0
      ? 0
      : Math.max(developedCeiling(evidence.criticalCareWeight), floor) * factor,
    'clarity-and-tone': content,
    'organisation-readability': evidence.sections === 1 ? content * 0.5 : content,
  }
}

const CAPPED = new Set<CategoryId>([
  'clinical-specificity', 'accomplishment-focus', 'critical-care-presentation', 'clarity-and-tone', 'organisation-readability',
])

/** Below this ceiling, a category the reviewer declined scores zero instead of leaving the denominator. */
const DECLINE_THRESHOLD = 0.5

interface Reason { readonly weakness: string; readonly improvement: string }

const AMOUNT: Readonly<Record<CappedCategoryId, Reason>> = {
  'clinical-specificity': {
    weakness: 'There is not yet enough written about your clinical roles for this to score higher.',
    improvement: 'Add bullets under your clinical roles that describe what you actually did: the patients, equipment and decisions involved.',
  },
  'accomplishment-focus': {
    weakness: 'There is not yet enough written about your roles for this to score higher.',
    improvement: 'Add bullets that say what you contributed in each role, not only what the role involved.',
  },
  'critical-care-presentation': {
    weakness: 'There is not yet enough written about your critical-care work for this to score higher.',
    improvement: 'Add bullets to your critical-care role describing what you handled and were trusted with.',
  },
  'clarity-and-tone': {
    weakness: 'Only a little has been written so far, so clarity can only be judged on a small amount of text.',
    improvement: 'Write out your summary and role bullets; clarity is judged across everything you write.',
  },
  'organisation-readability': {
    weakness: 'There is not yet much on the resume to organise.',
    improvement: 'Fill in your main sections; organisation is judged once there is material to order.',
  },
}

const NO_CRITICAL_CARE: Reason = {
  weakness: 'There is no critical-care role on the resume yet, so there is no critical-care work to present.',
  improvement: 'Add your critical-care position, with bullets describing what you handled and were trusted with.',
}

const STOCK_WORDING: Reason = {
  weakness: 'Most of your role bullets use stock phrases such as “responsible for” or “provided quality patient care” rather than describing specific work.',
  improvement: 'Rewrite those lines to name the patients, equipment, therapies or decisions involved.',
}

function reasonFor(id: CappedCategoryId, evidence: ResumeEvidence): Reason {
  if (id === 'critical-care-presentation' && evidence.criticalCarePositions === 0) return NO_CRITICAL_CARE
  const clinical = id === 'clinical-specificity' || id === 'accomplishment-focus' || id === 'critical-care-presentation'
  if (clinical && evidence.wording.predominantlyStock) return STOCK_WORDING
  return AMOUNT[id]
}

/**
 * The reviewer's scores, held to what is written.
 *
 * A score above its ceiling is lowered and the reason added. A category the
 * reviewer declined scores zero when its ceiling is under half -- "not written
 * yet" is not "not applicable" -- and otherwise stays declined, because a
 * reviewer failing on a developed resume is not the applicant's fault.
 * Leadership framing and the data-quality categories pass through untouched.
 */
export function applyWritingCeilings(
  categories: readonly CategoryResult[],
  evidence: ResumeEvidence
): CategoryResult[] {
  const ceilings = writingCeilings(evidence)
  return categories.map((result) => {
    if (!CAPPED.has(result.id)) return result
    const id = result.id as CappedCategoryId
    const reason = reasonFor(id, evidence)
    if (result.earned === null) {
      if (ceilings[id] >= DECLINE_THRESHOLD) return result
      return category(id, 0, { weaknesses: [reason.weakness], improvements: [reason.improvement] })
    }
    const ceiling = ceilings[id] * result.max
    if (result.earned <= ceiling + 1e-9) return result
    return category(id, ceiling, {
      strengths: result.strengths,
      weaknesses: [...result.weaknesses, reason.weakness],
      improvements: [...result.improvements, reason.improvement],
    })
  })
}
