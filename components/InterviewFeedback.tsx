'use client'

import type {
  ChatMessage,
  FinalReport,
  RedFlag,
  ScenarioEvaluation,
} from '@/lib/interview/types'

/**
 * Fixed status palette. Never themed, never reused for anything decorative.
 * On a light surface warning/serious fall under 3:1, so every use pairs the
 * color with its numeric value and a written band label — color never carries
 * the meaning on its own.
 */
const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const

type Band = { color: string; label: string }

function band(score: number): Band {
  if (!Number.isFinite(score)) return { color: STATUS.serious, label: 'Not scored' }
  if (score < 2) return { color: STATUS.critical, label: 'Not an answer' }
  if (score < 5) return { color: STATUS.serious, label: 'Needs work' }
  if (score < 7) return { color: STATUS.warning, label: 'Adequate' }
  if (score < 9) return { color: STATUS.good, label: 'Good' }
  return { color: STATUS.good, label: 'Excellent' }
}

const READINESS_COLOR: Record<string, string> = {
  'Needs significant preparation': STATUS.critical,
  Developing: STATUS.serious,
  Competitive: STATUS.warning,
  Strong: STATUS.good,
  'Interview-ready': STATUS.good,
}

const RED_FLAG_LABELS: Record<RedFlag, string> = {
  none: '',
  gibberish: 'Not a usable answer',
  non_answer: 'Did not answer the question asked',
  confident_nonsense: 'Confidently delivered, but incorrect',
  buzzword_dump: 'Correct terminology without the reasoning behind it',
  verbose_without_substance: 'Long, but never answered the question',
  memorized_without_understanding: 'Recited rather than understood',
  dangerous_misinformation: 'Patient safety: part of this would be harmful in practice',
}

const CLINICAL_LABELS: [keyof NonNullable<ScenarioEvaluation['clinical']>, string][] = [
  ['accuracy', 'Clinical accuracy'],
  ['reasoning', 'Clinical reasoning'],
  ['depth', 'Physiology / pharm depth'],
  ['safety', 'Safety & prioritization'],
  ['communication', 'Communication'],
]

const CLINICAL_WEIGHT: Record<string, string> = {
  accuracy: '30%',
  reasoning: '25%',
  depth: '20%',
  safety: '15%',
  communication: '10%',
}

const EI_LABELS: [keyof NonNullable<ScenarioEvaluation['emotional']>, string][] = [
  ['self_awareness', 'Self-awareness'],
  ['accountability', 'Accountability'],
  ['communication', 'Communication'],
  ['conflict_resolution', 'Conflict resolution'],
  ['emotional_regulation', 'Emotional regulation'],
  ['professionalism', 'Professionalism'],
  ['teamwork', 'Teamwork'],
  ['reflection', 'Reflection & growth'],
  ['specificity', 'Specificity of example'],
  ['structure', 'Structure of answer'],
]

const PRESSURE_LABELS: Record<string, string> = {
  improved: 'You got stronger as the questions got harder.',
  held: 'You held your ground under follow-up.',
  declined: 'Your answers weakened once you were pushed further.',
}

const TRAJECTORY_LABELS: Record<string, string> = {
  improved_as_difficulty_rose: 'Improved as questions got harder',
  held_steady: 'Held steady throughout',
  declined_as_difficulty_rose: 'Declined as questions got harder',
  inconsistent: 'Inconsistent scenario to scenario',
}

function fmt(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/** Strips any bullet the model added, since the markup supplies its own. */
function clean(text: string): string {
  return text.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()
}

/**
 * The number and the band label carry the meaning; the status color rides
 * alongside as a dot. Warning and serious are sub-3:1 on a light surface, so
 * text never sits on top of a status fill.
 */
function ScoreBadge({ score }: { score: number }) {
  const { color, label } = band(score)
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-gray-100 px-2 py-1">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-sm font-bold tabular-nums text-gray-900">
          {fmt(score)}
          <span className="text-[10px] font-semibold text-gray-500">/10</span>
        </span>
      </span>
      <span className="text-xs font-semibold text-gray-600">{label}</span>
    </div>
  )
}

/** Tinted pill with ink text — safe at any status color. */
function StatusPill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold text-gray-900 sm:text-sm"
      style={{ borderColor: color, backgroundColor: `${color}1f` }}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      {children}
    </span>
  )
}

/** Thin meter with a rounded data end and a recessive track. Always labeled. */
function ScoreMeter({ label, weight, score }: { label: string; weight?: string; score: number }) {
  const { color } = band(score)
  const width = Math.max(0, Math.min(100, (score || 0) * 10))
  return (
    <div className="flex items-center gap-2 sm:gap-3">
      <span className="w-28 shrink-0 text-[10px] leading-tight text-gray-600 sm:w-44 sm:text-xs">
        {label}
        {weight && <span className="ml-1 text-gray-400">{weight}</span>}
      </span>
      <div className="h-1.5 flex-1 rounded-full bg-gray-200">
        <div className="h-1.5 rounded-full transition-all" style={{ width: `${width}%`, backgroundColor: color }} />
      </div>
      <span className="w-7 shrink-0 text-right text-[10px] font-semibold tabular-nums text-gray-700 sm:text-xs">
        {fmt(score)}
      </span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-500">{title}</h4>
      {children}
    </div>
  )
}

function BulletList({ items, marker, tone }: { items: string[]; marker: string; tone: string }) {
  return (
    <ul className="space-y-1">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-xs leading-relaxed text-gray-700 sm:text-sm">
          <span className={`shrink-0 font-bold ${tone}`}>{marker}</span>
          <span>{clean(item)}</span>
        </li>
      ))}
    </ul>
  )
}

export function EvaluationCard({ evaluation }: { evaluation: ScenarioEvaluation }) {
  const flags = (evaluation.red_flags || []).filter((f) => f && f !== 'none')
  const pressure = PRESSURE_LABELS[evaluation.response_to_pressure]

  return (
    <div className="w-full overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 bg-gray-50 px-3 py-2.5 sm:px-4">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wide text-purple-600">
            Question {evaluation.primary_question_number} review
          </p>
          {evaluation.scenario_label && (
            <p className="truncate text-xs text-gray-500 sm:text-sm">{evaluation.scenario_label}</p>
          )}
        </div>
        <ScoreBadge score={evaluation.overall_score} />
      </div>

      <div className="space-y-4 px-3 py-3 sm:px-4 sm:py-4">
        {flags.length > 0 && (
          <div
            className="rounded-lg border-l-4 bg-red-50 px-3 py-2"
            style={{ borderColor: flags.includes('dangerous_misinformation') ? STATUS.critical : STATUS.serious }}
          >
            {flags.map((flag) => (
              <p key={flag} className="text-xs font-semibold text-red-800 sm:text-sm">
                {RED_FLAG_LABELS[flag] || flag}
              </p>
            ))}
          </div>
        )}

        {evaluation.clinical && (
          <Section title="Breakdown">
            <div className="space-y-1.5">
              {CLINICAL_LABELS.map(([key, label]) => (
                <ScoreMeter key={key} label={label} weight={CLINICAL_WEIGHT[key]} score={evaluation.clinical![key]} />
              ))}
            </div>
          </Section>
        )}

        {!evaluation.clinical && evaluation.emotional && (
          <Section title="Breakdown">
            <div className="space-y-1.5">
              {EI_LABELS.map(([key, label]) => (
                <ScoreMeter key={key} label={label} score={evaluation.emotional![key]} />
              ))}
            </div>
          </Section>
        )}

        {evaluation.did_well.length > 0 ? (
          <Section title="What you did well">
            <BulletList items={evaluation.did_well} marker="✓" tone="text-green-600" />
          </Section>
        ) : (
          <Section title="What you did well">
            <p className="text-xs italic text-gray-500 sm:text-sm">Nothing in this answer earned credit.</p>
          </Section>
        )}

        {evaluation.to_tighten.length > 0 && (
          <Section title="What to tighten">
            <BulletList items={evaluation.to_tighten} marker="→" tone="text-amber-600" />
          </Section>
        )}

        {evaluation.missed_concepts.length > 0 && (
          <Section title="Concepts you missed">
            <div className="flex flex-wrap gap-1.5">
              {evaluation.missed_concepts.map((concept, i) => (
                <span key={i} className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] text-gray-700 sm:text-xs">
                  {clean(concept)}
                </span>
              ))}
            </div>
          </Section>
        )}

        {evaluation.elite_answer && (
          <Section title="Elite-level answer">
            <blockquote className="rounded-r-lg border-l-4 border-purple-400 bg-purple-50 px-3 py-2 text-xs italic leading-relaxed text-gray-800 sm:text-sm">
              {evaluation.elite_answer.replace(/^"|"$/g, '')}
            </blockquote>
          </Section>
        )}

        {pressure && <p className="text-[11px] text-gray-500 sm:text-xs">{pressure}</p>}
      </div>
    </div>
  )
}

/** Stat tile: ink number, with a mini meter underneath carrying the status color. */
function Tile({ label, score, hero }: { label: string; score: number | null; hero?: boolean }) {
  if (typeof score !== 'number') return null
  const { color } = band(score)
  const width = Math.max(0, Math.min(100, score * 10))
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`font-bold tabular-nums text-gray-900 ${hero ? 'text-3xl' : 'text-xl'}`}>
        {fmt(score)}
        <span className="text-xs font-semibold text-gray-400">/10</span>
      </p>
      <div className="mt-1.5 h-1 rounded-full bg-gray-200">
        <div className="h-1 rounded-full" style={{ width: `${width}%`, backgroundColor: color }} />
      </div>
    </div>
  )
}

export function FinalReportCard({
  report,
  evaluations,
}: {
  report: FinalReport
  evaluations: ScenarioEvaluation[]
}) {
  const readinessColor = READINESS_COLOR[report.readiness] || STATUS.warning

  return (
    <div className="w-full overflow-hidden rounded-2xl border border-purple-200 bg-white shadow-md">
      <div className="bg-gradient-to-r from-purple-600 to-pink-500 px-4 py-3">
        <h3 className="text-sm font-bold uppercase tracking-wide text-white sm:text-base">Interview Report</h3>
        <p className="text-xs text-white/80">Across all {evaluations.length || report.top_priorities.length} scenarios</p>
      </div>

      <div className="space-y-5 px-3 py-4 sm:px-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label="Overall" score={report.overall_score} hero />
          <Tile label="Clinical" score={report.clinical_score} />
          <Tile label="Emotional IQ" score={report.emotional_score} />
          <Tile label="Communication" score={report.communication_score} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusPill color={readinessColor}>{report.readiness}</StatusPill>
          <span className="rounded-full bg-gray-100 px-3 py-1 text-[11px] font-semibold text-gray-700 sm:text-xs">
            {TRAJECTORY_LABELS[report.trajectory] || report.trajectory}
          </span>
        </div>

        {evaluations.length > 0 && (
          <Section title="Question by question">
            <div className="space-y-1.5">
              {evaluations.map((e) => (
                <ScoreMeter
                  key={e.primary_question_number}
                  label={`Q${e.primary_question_number} ${e.scenario_label || e.category}`}
                  score={e.overall_score}
                />
              ))}
            </div>
          </Section>
        )}

        {report.top_priorities.length > 0 && (
          <Section title="Top priorities before your real interview">
            <ol className="space-y-2">
              {report.top_priorities.map((item, i) => (
                <li key={i} className="flex gap-2.5 text-xs leading-relaxed text-gray-800 sm:text-sm">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-purple-600 text-[11px] font-bold text-white">
                    {i + 1}
                  </span>
                  <span className="font-medium">{clean(item)}</span>
                </li>
              ))}
            </ol>
          </Section>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {report.strongest_areas.length > 0 && (
            <Section title="Strongest areas">
              <BulletList items={report.strongest_areas} marker="✓" tone="text-green-600" />
            </Section>
          )}
          {report.weakest_areas.length > 0 && (
            <Section title="Weakest areas">
              <BulletList items={report.weakest_areas} marker="→" tone="text-amber-600" />
            </Section>
          )}
        </div>

        {report.patterns.length > 0 && (
          <Section title="Patterns across the interview">
            <BulletList items={report.patterns} marker="•" tone="text-purple-500" />
          </Section>
        )}

        {report.struggled_with.length > 0 && (
          <Section title="Where you struggled most">
            <div className="flex flex-wrap gap-1.5">
              {report.struggled_with.map((item, i) => (
                <span key={i} className="rounded-full bg-red-50 px-2.5 py-1 text-[11px] text-red-700 sm:text-xs">
                  {clean(item)}
                </span>
              ))}
            </div>
          </Section>
        )}

        {report.recommended_review.length > 0 && (
          <Section title="Recommended topics to review">
            <div className="flex flex-wrap gap-1.5">
              {report.recommended_review.map((item, i) => (
                <span key={i} className="rounded-full bg-indigo-50 px-2.5 py-1 text-[11px] text-indigo-700 sm:text-xs">
                  {clean(item)}
                </span>
              ))}
            </div>
          </Section>
        )}

        {report.summary && (
          <p className="rounded-lg bg-gray-50 px-3 py-2.5 text-xs leading-relaxed text-gray-700 sm:text-sm">
            {report.summary}
          </p>
        )}

        <p className="border-t border-gray-100 pt-3 text-[10px] leading-relaxed text-gray-400 sm:text-[11px]">
          This is practice feedback on today&apos;s answers only. It is not a prediction of any admissions decision.
        </p>
      </div>
    </div>
  )
}

/**
 * Renders one transcript turn. Used by both the live chat and the past-session
 * review, so old rows (plain `content`, no structured fields) still render —
 * they just come out as the plain-text bubble they were saved as.
 */
export function InterviewMessage({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-line rounded-2xl bg-gradient-to-r from-purple-600 to-pink-500 px-3 py-2 text-sm text-white sm:max-w-md sm:px-4 sm:py-3 sm:text-base">
          {message.content}
        </div>
      </div>
    )
  }

  const withheld = message.withheldReviews || []
  const report = message.finalReport || null
  const allEvaluations = message.allEvaluations || withheld

  return (
    <div className="space-y-3">
      {message.content && (
        <div className="flex justify-start">
          <div className="max-w-[90%] whitespace-pre-line rounded-2xl bg-gray-100 px-3 py-2 text-sm text-gray-800 sm:max-w-xl sm:px-4 sm:py-3 sm:text-base">
            {message.content}
          </div>
        </div>
      )}

      {message.evaluation && <EvaluationCard evaluation={message.evaluation} />}

      {withheld.length > 0 && (
        <div className="space-y-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
            Scenario reviews
          </p>
          {withheld.map((evaluation) => (
            <EvaluationCard key={evaluation.primary_question_number} evaluation={evaluation} />
          ))}
        </div>
      )}

      {report && <FinalReportCard report={report} evaluations={allEvaluations} />}
    </div>
  )
}
