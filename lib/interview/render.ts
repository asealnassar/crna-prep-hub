import type { FinalReport, InterviewState, ScenarioEvaluation } from './types'

const RULE = '────────────────────────'

const RED_FLAG_LABELS: Record<string, string> = {
  gibberish: 'That response was not a usable answer',
  non_answer: 'That did not answer the question asked',
  confident_nonsense: 'Delivered confidently, but incorrect',
  buzzword_dump: 'Correct terminology without the reasoning behind it',
  verbose_without_substance: 'Long, but it never answered the question',
  memorized_without_understanding: 'Recited rather than understood — it did not hold up when probed',
  dangerous_misinformation: 'PATIENT SAFETY: part of this answer would be harmful in practice',
}

const PRESSURE_LABELS: Record<string, string> = {
  improved: 'You got stronger as the questions got harder.',
  held: 'You held your ground under follow-up.',
  declined: 'Your answers weakened once you were pushed further.',
}

const TRAJECTORY_LABELS: Record<string, string> = {
  improved_as_difficulty_rose: 'Improved as the questions got harder',
  held_steady: 'Held steady throughout',
  declined_as_difficulty_rose: 'Declined as the questions got harder',
  inconsistent: 'Inconsistent from scenario to scenario',
}

const CLINICAL_LABELS: [keyof NonNullable<ScenarioEvaluation['clinical']>, string][] = [
  ['accuracy', 'Clinical accuracy (30%)'],
  ['reasoning', 'Clinical reasoning (25%)'],
  ['depth', 'Physiology / pharmacology depth (20%)'],
  ['safety', 'Safety and prioritization (15%)'],
  ['communication', 'Communication (10%)'],
]

const EI_LABELS: [keyof NonNullable<ScenarioEvaluation['emotional']>, string][] = [
  ['self_awareness', 'Self-awareness'],
  ['accountability', 'Accountability'],
  ['communication', 'Communication'],
  ['conflict_resolution', 'Conflict resolution'],
  ['emotional_regulation', 'Emotional regulation'],
  ['professionalism', 'Professionalism'],
  ['teamwork', 'Teamwork'],
  ['reflection', 'Reflection and growth'],
  ['specificity', 'Specificity of example'],
  ['structure', 'Structure of the answer'],
]

/**
 * Renders a completed scenario as plain text. Rendering this on the server
 * rather than letting the model write it keeps the sections consistent and
 * makes it impossible for coaching to leak into Real Interview Mode.
 */
export function renderEvaluation(evaluation: ScenarioEvaluation, opts: { compact?: boolean } = {}): string {
  const lines: string[] = []
  const label = evaluation.scenario_label ? ` — ${evaluation.scenario_label}` : ''
  lines.push(`${RULE}\nQuestion ${evaluation.primary_question_number} review${label}`)
  lines.push(`Score: ${fmt(evaluation.overall_score)}/10`)

  const flags = (evaluation.red_flags || []).filter((f) => f && f !== 'none')
  if (flags.length) {
    lines.push('')
    lines.push(flags.map((f) => RED_FLAG_LABELS[f] || f).join('\n'))
  }

  if (!opts.compact) {
    if (evaluation.clinical) {
      lines.push('')
      lines.push('Breakdown:')
      for (const [key, text] of CLINICAL_LABELS) {
        lines.push(`  ${text}: ${fmt(evaluation.clinical[key])}/10`)
      }
    } else if (evaluation.emotional) {
      lines.push('')
      lines.push('Breakdown:')
      for (const [key, text] of EI_LABELS) {
        lines.push(`  ${text}: ${fmt(evaluation.emotional[key])}/10`)
      }
    }
  }

  pushList(lines, 'What you did well:', evaluation.did_well, 'Nothing in this answer earned credit.')
  pushList(lines, 'What to tighten:', evaluation.to_tighten)
  pushList(lines, 'Concepts you missed:', evaluation.missed_concepts)

  if (evaluation.elite_answer) {
    lines.push('')
    lines.push('Elite-level answer:')
    lines.push(`"${evaluation.elite_answer.replace(/^"|"$/g, '')}"`)
  }

  const pressure = PRESSURE_LABELS[evaluation.response_to_pressure]
  if (pressure) {
    lines.push('')
    lines.push(pressure)
  }

  lines.push(RULE)
  return lines.join('\n')
}

/** Renders the end-of-interview report. Every section is always present. */
export function renderFinalReport(report: FinalReport, state: InterviewState): string {
  const lines: string[] = []
  lines.push(RULE)
  lines.push('INTERVIEW REPORT')
  lines.push(RULE)
  lines.push('')
  lines.push(`Overall interview score: ${fmt(report.overall_score)}/10`)
  if (typeof report.clinical_score === 'number') {
    lines.push(`Clinical: ${fmt(report.clinical_score)}/10`)
  }
  if (typeof report.emotional_score === 'number') {
    lines.push(`Emotional intelligence: ${fmt(report.emotional_score)}/10`)
  }
  lines.push(`Communication: ${fmt(report.communication_score)}/10`)

  const perQuestion = state.evaluations
    .map((e) => `  Q${e.primary_question_number} ${e.scenario_label || e.category}: ${fmt(e.overall_score)}/10`)
    .join('\n')
  if (perQuestion) {
    lines.push('')
    lines.push('Question by question:')
    lines.push(perQuestion)
  }

  pushList(lines, 'Strongest areas:', report.strongest_areas)
  pushList(lines, 'Weakest areas:', report.weakest_areas)
  pushList(lines, 'Where you struggled most:', report.struggled_with)
  pushList(lines, 'Patterns across the interview:', report.patterns)

  lines.push('')
  lines.push(`Trajectory: ${TRAJECTORY_LABELS[report.trajectory] || report.trajectory}`)

  pushNumberedList(lines, 'Top 3 priorities before your real interview:', report.top_priorities)
  pushList(lines, 'Recommended topics to review:', report.recommended_review)

  lines.push('')
  lines.push(`Readiness: ${report.readiness}`)
  if (report.summary) {
    lines.push('')
    lines.push(report.summary)
  }
  lines.push('')
  lines.push('This is practice feedback on today\'s answers only. It is not a prediction of any admissions decision.')
  lines.push(RULE)
  return lines.join('\n')
}

/**
 * Real Interview Mode withholds everything until the end, so the closing
 * message carries the per-scenario reviews before the report.
 */
export function renderWithheldReviews(state: InterviewState): string {
  if (!state.evaluations.length) return ''
  const header = `${RULE}\nSCENARIO REVIEWS\n${RULE}`
  return [header, ...state.evaluations.map((e) => renderEvaluation(e))].join('\n\n')
}

/** Assembles the message the applicant actually sees for a turn. */
export function composeMessage(args: {
  state: InterviewState
  displayText: string
  evaluation: ScenarioEvaluation | null
  finalReport: FinalReport | null
}): string {
  const { state, evaluation, finalReport } = args
  const displayText = (args.displayText || '').trim()
  const blocks: string[] = []
  const practice = state.mode !== 'real'

  // Practice mode shows the scenario review before asking what comes next.
  if (practice && evaluation && !finalReport) {
    blocks.push(renderEvaluation(evaluation))
  }

  if (displayText) blocks.push(displayText)

  if (finalReport) {
    if (practice && evaluation) {
      blocks.push(renderEvaluation(evaluation))
    } else if (!practice) {
      const reviews = renderWithheldReviews(state)
      if (reviews) blocks.push(reviews)
    }
    blocks.push(renderFinalReport(finalReport, state))
  }

  return blocks.join('\n\n').trim()
}

function pushList(lines: string[], heading: string, items: string[] | undefined, emptyText?: string) {
  const list = (items || []).filter((i) => i && i.trim())
  if (!list.length && !emptyText) return
  lines.push('')
  lines.push(heading)
  if (!list.length) {
    lines.push(`  ${emptyText}`)
    return
  }
  for (const item of list) lines.push(`  - ${stripBullet(item)}`)
}

function pushNumberedList(lines: string[], heading: string, items: string[] | undefined) {
  const list = (items || []).filter((i) => i && i.trim())
  if (!list.length) return
  lines.push('')
  lines.push(heading)
  list.forEach((item, i) => lines.push(`  ${i + 1}. ${stripBullet(item)}`))
}

/** The model is told not to add bullets; this catches it when it does anyway. */
function stripBullet(text: string): string {
  return text.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()
}

function fmt(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
