import type {
  QuestionFormat,
  DifficultyLevel,
  InterviewMode,
  InterviewState,
  InterviewType,
  ModelTurn,
  QuestionCategory,
  ScenarioEvaluation,
  TurnAction,
} from './types'
import { ALL_FORMATS, CLINICAL_FORMATS, EMOTIONAL_FORMATS } from './types'

export const MAX_PRIMARY_QUESTIONS = 10
export const MAX_FOLLOW_UPS = 3
/**
 * Behavioral answers don't reward deep laddering the way clinical ones do —
 * two probes is enough to find out whether the example is real and reflected on.
 */
export const MAX_FOLLOW_UPS_EMOTIONAL = 2
/**
 * Follow-ups available across the entire interview. Ten primaries at the
 * per-scenario cap would run 40+ turns, so the budget is what actually keeps
 * the interview a sane length: at 8 it averages well under one follow-up per
 * question, forcing the interviewer to spend them only where depth is genuinely
 * in doubt rather than probing everything. Tune here.
 */
export const FOLLOW_UP_BUDGET = 8
/** Cap on remembered concepts so the prompt cannot grow without bound. */
const MAX_TESTED_CONCEPTS = 60

/** Clinical rubric weights. Must sum to 1. */
export const CLINICAL_WEIGHTS = {
  accuracy: 0.3,
  reasoning: 0.25,
  depth: 0.2,
  safety: 0.15,
  communication: 0.1,
} as const

const EMPTY_COUNTS: Record<QuestionCategory, number> = {
  clinical: 0,
  emotional: 0,
  behavioral: 0,
  custom: 0,
}

export function createInitialState(opts: {
  mode: InterviewMode
  type: InterviewType
  customTopic?: string
}): InterviewState {
  return {
    version: 1,
    mode: opts.mode,
    type: opts.type,
    customTopic: opts.customTopic || '',
    primaryQuestionNumber: 0,
    maxPrimaryQuestions: MAX_PRIMARY_QUESTIONS,
    followUpCount: 0,
    maxFollowUps: MAX_FOLLOW_UPS,
    followUpBudget: FOLLOW_UP_BUDGET,
    maxFollowUpBudget: FOLLOW_UP_BUDGET,
    turnKind: 'opening',
    currentScenario: '',
    currentCategory: null,
    difficultyLevel: 2,
    suggestedDifficulty: 2,
    categoryCounts: { ...EMPTY_COUNTS },
    askedFormats: [],
    testedConcepts: [],
    askedPrimaryQuestions: [],
    evaluations: [],
    finalReport: null,
    complete: false,
  }
}

/**
 * Rebuilds a trustworthy state object from whatever the client sent. The client
 * is not trusted with the counters, but it is the only place the state lives
 * between turns, so everything is clamped back into range here.
 */
export function normalizeState(raw: any, fallback: InterviewState): InterviewState {
  if (!raw || typeof raw !== 'object') return fallback
  const maxPrimary = clampInt(raw.maxPrimaryQuestions, 1, 25, MAX_PRIMARY_QUESTIONS)
  const maxFollowUps = clampInt(raw.maxFollowUps, 0, 5, MAX_FOLLOW_UPS)
  const maxBudget = clampInt(raw.maxFollowUpBudget, 0, 60, FOLLOW_UP_BUDGET)
  return {
    version: 1,
    mode: raw.mode === 'real' ? 'real' : 'practice',
    type: isType(raw.type) ? raw.type : fallback.type,
    customTopic: typeof raw.customTopic === 'string' ? raw.customTopic : '',
    primaryQuestionNumber: clampInt(raw.primaryQuestionNumber, 0, maxPrimary, 0),
    maxPrimaryQuestions: maxPrimary,
    followUpCount: clampInt(raw.followUpCount, 0, maxFollowUps, 0),
    maxFollowUps,
    followUpBudget: clampInt(raw.followUpBudget, 0, maxBudget, maxBudget),
    maxFollowUpBudget: maxBudget,
    turnKind: ['opening', 'primary', 'follow_up', 'final_report'].includes(raw.turnKind)
      ? raw.turnKind
      : 'opening',
    currentScenario: str(raw.currentScenario),
    currentCategory: isCategory(raw.currentCategory) ? raw.currentCategory : null,
    difficultyLevel: clampInt(raw.difficultyLevel, 1, 5, 2) as DifficultyLevel,
    suggestedDifficulty: clampInt(raw.suggestedDifficulty, 1, 5, 2) as DifficultyLevel,
    categoryCounts: {
      clinical: clampInt(raw.categoryCounts?.clinical, 0, 99, 0),
      emotional: clampInt(raw.categoryCounts?.emotional, 0, 99, 0),
      behavioral: clampInt(raw.categoryCounts?.behavioral, 0, 99, 0),
      custom: clampInt(raw.categoryCounts?.custom, 0, 99, 0),
    },
    askedFormats: strArray(raw.askedFormats).filter(isFormat),
    testedConcepts: strArray(raw.testedConcepts).slice(-MAX_TESTED_CONCEPTS),
    askedPrimaryQuestions: strArray(raw.askedPrimaryQuestions),
    evaluations: Array.isArray(raw.evaluations) ? raw.evaluations.filter(Boolean) : [],
    finalReport: raw.finalReport ?? null,
    complete: raw.complete === true,
  }
}

/**
 * Follow-up ceiling for the scenario currently in play. Emotional and
 * behavioral scenarios cap lower than clinical ones, so a Mixed interview
 * tightens and loosens as its category changes.
 */
export function followUpCapFor(state: InterviewState): number {
  if (state.currentCategory === 'emotional' || state.currentCategory === 'behavioral') {
    return Math.min(state.maxFollowUps, MAX_FOLLOW_UPS_EMOTIONAL)
  }
  return state.maxFollowUps
}

/**
 * The only place that decides what the interviewer may do next. Returned as a
 * dynamic enum in the response schema, so the model physically cannot pick an
 * action the state machine has ruled out (e.g. a fourth follow-up).
 */
export function allowedActions(state: InterviewState): TurnAction[] {
  if (state.complete) return ['final_report']
  // Opening turn: nothing has been asked yet, so the only move is to ask Q1.
  if (state.primaryQuestionNumber === 0) return ['next_primary']

  const actions: TurnAction[] = []
  // Both gates must pass: this scenario's cap and the interview-wide budget.
  if (state.followUpCount < followUpCapFor(state) && state.followUpBudget > 0) {
    actions.push('ask_follow_up')
  }
  if (state.primaryQuestionNumber < state.maxPrimaryQuestions) {
    actions.push('next_primary')
  } else {
    actions.push('final_report')
  }
  return actions
}

/** True when the interviewer is allowed to close out the interview this turn. */
export function canFinish(state: InterviewState): boolean {
  return allowedActions(state).includes('final_report')
}

/** True on the very first call, before any question exists. */
export function isOpeningTurn(state: InterviewState): boolean {
  return state.primaryQuestionNumber === 0 && !state.complete
}

/** Applies a model turn to the state. The server, not the model, moves counters. */
export function applyTurn(state: InterviewState, turn: ModelTurn): InterviewState {
  const next: InterviewState = {
    ...state,
    categoryCounts: { ...state.categoryCounts },
    askedFormats: [...state.askedFormats],
    testedConcepts: [...state.testedConcepts],
    askedPrimaryQuestions: [...state.askedPrimaryQuestions],
    evaluations: [...state.evaluations],
  }

  const evaluation = normalizeEvaluation(turn.evaluation, state)

  if (turn.action === 'ask_follow_up') {
    next.followUpCount = Math.min(state.followUpCount + 1, followUpCapFor(state))
    next.followUpBudget = Math.max(0, state.followUpBudget - 1)
    next.turnKind = 'follow_up'
    next.difficultyLevel = clampInt(turn.difficulty_level, 1, 5, state.difficultyLevel) as DifficultyLevel
  } else if (turn.action === 'next_primary') {
    if (evaluation) next.evaluations.push(evaluation)
    next.primaryQuestionNumber = Math.min(state.primaryQuestionNumber + 1, state.maxPrimaryQuestions)
    next.followUpCount = 0
    next.turnKind = 'primary'
    next.currentScenario = str(turn.scenario_label) || next.currentScenario
    next.currentCategory = isCategory(turn.category) ? turn.category : next.currentCategory
    if (isCategory(turn.category)) next.categoryCounts[turn.category] += 1
    next.difficultyLevel = clampInt(turn.difficulty_level, 1, 5, state.suggestedDifficulty) as DifficultyLevel
    const q = str(turn.question_asked)
    if (q) next.askedPrimaryQuestions.push(q)
    if (isFormat(turn.question_format) && turn.question_format !== 'none') {
      next.askedFormats.push(turn.question_format)
    }
  } else {
    if (evaluation) next.evaluations.push(evaluation)
    next.turnKind = 'final_report'
    next.finalReport = turn.final_report ?? null
    next.complete = true
  }

  for (const concept of strArray(turn.concepts_tested)) {
    const key = concept.trim().toLowerCase()
    if (!key) continue
    if (!next.testedConcepts.some((c) => c.trim().toLowerCase() === key)) {
      next.testedConcepts.push(concept.trim())
    }
  }
  if (next.testedConcepts.length > MAX_TESTED_CONCEPTS) {
    next.testedConcepts = next.testedConcepts.slice(-MAX_TESTED_CONCEPTS)
  }

  next.suggestedDifficulty = computeSuggestedDifficulty(next)
  return next
}

/**
 * Difficulty ladder. Climbs when the applicant is clearly handling the level,
 * and drops back toward fundamentals when they are not — the goal is to locate
 * where understanding actually stops, not to bury a struggling applicant.
 */
export function computeSuggestedDifficulty(state: InterviewState): DifficultyLevel {
  const scored = state.evaluations.filter((e) => e && typeof e.overall_score === 'number')
  if (scored.length === 0) return 2
  const recent = scored.slice(-3)
  const avg = recent.reduce((sum, e) => sum + e.overall_score, 0) / recent.length
  const current = state.difficultyLevel || 2

  let nextLevel: number
  if (avg >= 8) nextLevel = current + 1
  else if (avg >= 6.5) nextLevel = current
  else if (avg >= 4.5) nextLevel = current - 1
  else nextLevel = current - 2

  return clampInt(nextLevel, 1, 5, 2) as DifficultyLevel
}

/** Weighted clinical score, used to sanity-check what the model reports. */
export function weightedClinicalScore(sub: ScenarioEvaluation['clinical']): number | null {
  if (!sub) return null
  const raw =
    sub.accuracy * CLINICAL_WEIGHTS.accuracy +
    sub.reasoning * CLINICAL_WEIGHTS.reasoning +
    sub.depth * CLINICAL_WEIGHTS.depth +
    sub.safety * CLINICAL_WEIGHTS.safety +
    sub.communication * CLINICAL_WEIGHTS.communication
  return Math.round(raw * 10) / 10
}

function normalizeEvaluation(raw: any, state: InterviewState): ScenarioEvaluation | null {
  if (!raw || typeof raw !== 'object') return null
  const clinical = raw.clinical && typeof raw.clinical === 'object' ? raw.clinical : null
  const weighted = weightedClinicalScore(clinical)
  // Trust the sub-scores over the headline number when they disagree badly.
  let overall = typeof raw.overall_score === 'number' ? raw.overall_score : 0
  if (weighted !== null && Math.abs(weighted - overall) > 1.5) overall = weighted
  return {
    ...raw,
    primary_question_number:
      clampInt(raw.primary_question_number, 1, state.maxPrimaryQuestions, state.primaryQuestionNumber || 1),
    overall_score: Math.max(0, Math.min(10, Math.round(overall * 10) / 10)),
    clinical,
    emotional: raw.emotional && typeof raw.emotional === 'object' ? raw.emotional : null,
    did_well: strArray(raw.did_well),
    to_tighten: strArray(raw.to_tighten),
    missed_concepts: strArray(raw.missed_concepts),
    elite_answer: str(raw.elite_answer),
    red_flags: strArray(raw.red_flags).filter((f) => f !== 'none') as ScenarioEvaluation['red_flags'],
  }
}

function clampInt(value: any, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function str(value: any): string {
  return typeof value === 'string' ? value.trim() : ''
}

function strArray(value: any): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
}

function isType(value: any): value is InterviewType {
  return ['emotional', 'clinical', 'mixed', 'custom'].includes(value)
}

function isCategory(value: any): value is QuestionCategory {
  return ['clinical', 'emotional', 'behavioral', 'custom'].includes(value)
}

function isFormat(value: any): value is QuestionFormat {
  return ALL_FORMATS.includes(value)
}

/** Clinical formats not yet used this interview, in canonical order. */
export function unusedClinicalFormats(state: InterviewState): QuestionFormat[] {
  return CLINICAL_FORMATS.filter((f) => !state.askedFormats.includes(f))
}

/** Emotional-intelligence formats not yet used this interview. */
export function unusedEmotionalFormats(state: InterviewState): QuestionFormat[] {
  return EMOTIONAL_FORMATS.filter((f) => !state.askedFormats.includes(f))
}
