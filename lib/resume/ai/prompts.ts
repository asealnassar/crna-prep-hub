/**
 * The prompt contract, and the strict reader for what comes back.
 *
 * Layer 2 of five, and deliberately not the one the design leans on. V1's
 * prompt said "INCLUDE MEASURABLE OUTCOMES (every bullet needs one)" and gave
 * worked examples containing patient ratios and MAP targets the product never
 * collected -- so the model did exactly as told and invented them. The lesson
 * is that an instruction is the weakest layer: it is advice, and a model under
 * pressure to satisfy a requirement will satisfy it with fiction.
 *
 * So this file does three things and claims nothing more:
 *
 *   1. States the prohibited categories VERBATIM, in the applicant's own terms.
 *   2. Gives the impulse somewhere to go -- `opportunities`, meaning "this
 *      would be stronger with a number; ask them for it" -- so the model has a
 *      legitimate move other than inventing.
 *   3. Reads the response STRICTLY. V1 accepted
 *      `result.bullets || result.bullet_points || Object.values(result)`, a
 *      fallback chain that turned malformed output into plausible nonsense.
 *
 * Pure. Builds strings; calls nothing.
 */

import type { FactSheet } from '../model/facts.ts'

/**
 * Decision 1, word for word.
 *
 * Copied rather than paraphrased, and exported so the tests assert the prompt
 * carries every one. A paraphrase is how a category quietly stops being
 * forbidden.
 */
export const PROHIBITED_CATEGORIES: readonly string[] = [
  'patient ratios',
  'MAP targets',
  'shift lengths',
  'procedure counts',
  'patient counts',
  'outcomes',
  'metrics',
  'devices',
  'therapies',
  'certifications',
  'leadership responsibilities',
  'unit types',
  'dates',
  'years of experience',
  'shadowing',
  'accomplishments',
  'any other unsupported fact',
]

export type AiOperation =
  | 'generate-bullets'
  | 'improve-bullet'
  /** Any narrative field that is not a bullet: a reflection, a detail, a citation. */
  | 'improve-text'
  | 'shorten'
  | 'achievement-focus'
  | 'tighten-summary'
  | 'strengthen-leadership'
  | 'strengthen-complexity'

/** Every operation, exported so the request parser cannot keep a second list. */
export const OPERATIONS: readonly AiOperation[] = [
  'generate-bullets', 'improve-bullet', 'improve-text', 'shorten',
  'achievement-focus', 'tighten-summary', 'strengthen-leadership',
  'strengthen-complexity',
]

const OPERATION_BRIEF: Record<AiOperation, string> = {
  'generate-bullets':
    'Write resume bullets for this position using only the facts below.',
  'improve-bullet':
    'Rewrite the single bullet below so it reads more clearly and professionally.',
  'improve-text':
    'Rewrite the text below so it reads more clearly and professionally. Keep it to the same kind of thing it already is.',
  'shorten':
    'Make the text below shorter without losing any fact it already states.',
  'achievement-focus':
    'Reframe the text below around what the applicant accomplished, using only facts already present.',
  'tighten-summary':
    'Tighten the professional summary below.',
  'strengthen-leadership':
    'Reframe the text below to make the applicant’s recorded leadership clearer.',
  'strengthen-complexity':
    'Reframe the text below to make the clinical complexity already recorded clearer.',
}

/** Operations that rewrite text the applicant already has. */
export function needsCurrentText(operation: AiOperation): boolean {
  return operation !== 'generate-bullets'
}

export interface PromptRequest {
  readonly operation: AiOperation
  readonly sheet: FactSheet
  /** The text being rewritten. Required for every operation but generation. */
  readonly currentText?: string
  /** Upper bound on how many bullets to return. */
  readonly maxItems?: number
}

export interface PromptMessages {
  readonly system: string
  readonly user: string
}

/**
 * The rules half. Constant for every call, so it says nothing about any
 * particular applicant and can be read on its own.
 */
export function systemPrompt(): string {
  return [
    'You help an ICU nurse write their CRNA school application resume.',
    '',
    'You may ONLY state facts supplied by the applicant, listed under FACTS.',
    'If something is not in FACTS, the applicant has not told you it, and you',
    'must not write it.',
    '',
    'You must never invent:',
    ...PROHIBITED_CATEGORIES.map((category) => `- ${category}`),
    '',
    'If a measurable detail would make a line stronger but is not in FACTS, do',
    'not estimate it, do not use a typical value, and do not phrase it vaguely',
    'to avoid committing. Put it in "opportunities" instead, as a question the',
    'applicant can answer. That is the only correct place for the impulse.',
    '',
    'Everything you write is a PROPOSAL. The applicant decides whether it is',
    'used. Write plainly; do not pad.',
    '',
    'Reply with JSON only, in exactly this shape:',
    '{"proposals": ["..."], "opportunities": [{"question": "...", "why": "..."}]}',
    'No prose outside the JSON. No markdown fence.',
  ].join('\n')
}

/**
 * The facts half.
 *
 * Each fact is listed with its id so a proposal can be traced afterwards, and
 * with nothing else -- no resume, no contact details, no other position.
 */
export function userPrompt(request: PromptRequest): string {
  const { operation, sheet, currentText, maxItems } = request

  const lines: string[] = [
    OPERATION_BRIEF[operation],
    '',
    `SUBJECT: ${sheet.subject}`,
    '',
    'FACTS:',
  ]

  if (sheet.facts.length === 0) {
    lines.push(
      '(none supplied)',
      '',
      'With no facts you cannot write anything truthful. Return an empty',
      '"proposals" list and ask for what you would need in "opportunities".'
    )
  } else {
    for (const fact of sheet.facts) {
      lines.push(`- [${fact.id}] ${fact.kind}: ${fact.value}`)
    }
  }

  if (needsCurrentText(operation)) {
    lines.push('', 'CURRENT TEXT:', currentText?.trim() ? currentText.trim() : '(empty)')
  }

  if (typeof maxItems === 'number' && maxItems > 0) {
    lines.push('', `Return at most ${maxItems} proposal${maxItems === 1 ? '' : 's'}.`)
  }

  return lines.join('\n')
}

export function buildPrompt(request: PromptRequest): PromptMessages {
  return { system: systemPrompt(), user: userPrompt(request) }
}

// ---------------------------------------------------------------------------
// Reading the response
// ---------------------------------------------------------------------------

export interface Opportunity {
  /** What to ask the applicant. */
  readonly question: string
  /** Why it would help. Shown beside the question. */
  readonly why: string
}

export interface ModelProposal {
  readonly proposals: readonly string[]
  readonly opportunities: readonly Opportunity[]
}

export type ParseResult =
  | { readonly ok: true; readonly value: ModelProposal }
  | { readonly ok: false; readonly reason: string }

/** Longest single proposal accepted. A bullet is a sentence, not an essay. */
export const MAX_PROPOSAL_LENGTH = 2_000
export const MAX_PROPOSALS = 12
export const MAX_OPPORTUNITIES = 12

/**
 * Reads a model response, or refuses it.
 *
 * STRICT ON PURPOSE. There is no alternative key, no coercion, no
 * `Object.values` rescue. A response that is not the agreed shape is a failed
 * call, and treating it as anything else is how nonsense reaches a resume.
 */
export function parseModelResponse(raw: unknown): ParseResult {
  let value = raw

  if (typeof value === 'string') {
    try {
      value = JSON.parse(stripFence(value))
    } catch {
      return { ok: false, reason: 'The response was not JSON.' }
    }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'The response was not an object.' }
  }
  const body = value as Record<string, unknown>

  if (!Array.isArray(body.proposals)) {
    return { ok: false, reason: 'The response had no "proposals" list.' }
  }
  if (body.proposals.length > MAX_PROPOSALS) {
    return { ok: false, reason: 'The response had too many proposals.' }
  }

  const proposals: string[] = []
  for (const item of body.proposals) {
    if (typeof item !== 'string') return { ok: false, reason: 'A proposal was not text.' }
    if (item.length > MAX_PROPOSAL_LENGTH) return { ok: false, reason: 'A proposal was too long.' }
    const trimmed = item.trim()
    if (trimmed !== '') proposals.push(trimmed)
  }

  // Absent is fine; present and malformed is not.
  const rawOpportunities = body.opportunities ?? []
  if (!Array.isArray(rawOpportunities)) {
    return { ok: false, reason: 'The response had a malformed "opportunities" list.' }
  }
  if (rawOpportunities.length > MAX_OPPORTUNITIES) {
    return { ok: false, reason: 'The response had too many opportunities.' }
  }

  const opportunities: Opportunity[] = []
  for (const item of rawOpportunities) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, reason: 'An opportunity was not an object.' }
    }
    const entry = item as Record<string, unknown>
    if (typeof entry.question !== 'string') {
      return { ok: false, reason: 'An opportunity had no question.' }
    }
    if (entry.why !== undefined && typeof entry.why !== 'string') {
      return { ok: false, reason: 'An opportunity had a malformed reason.' }
    }
    const question = entry.question.trim()
    if (question === '' || question.length > MAX_PROPOSAL_LENGTH) continue
    opportunities.push({ question, why: (entry.why ?? '').toString().trim() })
  }

  return { ok: true, value: { proposals, opportunities } }
}

/** Models wrap JSON in a fence despite being told not to. Tolerate that only. */
function stripFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text)
  return fenced ? fenced[1] : text
}
