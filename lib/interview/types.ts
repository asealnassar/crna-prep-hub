// Shared types for the mock interview engine.
// Safe to import from client components — types only, no server dependencies.

export type InterviewMode = 'practice' | 'real'

export type InterviewType = 'emotional' | 'clinical' | 'mixed' | 'custom'

export type QuestionCategory = 'clinical' | 'emotional' | 'behavioral' | 'custom'

/**
 * The shapes a real CRNA panel's questions take. Tracked so an interview
 * spreads across question FORMS, not just topics — without this the model
 * defaults to deteriorating-patient scenarios and conflict stories forever.
 */
export type ClinicalFormat =
  | 'scenario'
  | 'patient_deep_dive'
  | 'pharmacology'
  | 'hemodynamics'
  | 'pathophysiology'
  | 'ventilator'
  | 'shock_states'
  | 'emergency'
  | 'abg_labs'
  | 'cardiac_ecg'
  | 'equipment'

export type EmotionalFormat =
  | 'conflict'
  | 'mistake'
  | 'stress'
  | 'difficult_patient_family'
  | 'teamwork'
  | 'leadership'
  | 'receiving_feedback'
  | 'giving_feedback'
  | 'ethics'
  | 'self_awareness'
  | 'resilience'
  | 'adaptability'
  | 'communication'
  | 'accountability'
  | 'ambiguous_judgment'

export type QuestionFormat = ClinicalFormat | EmotionalFormat | 'none'

export const CLINICAL_FORMATS: ClinicalFormat[] = [
  'scenario',
  'patient_deep_dive',
  'pharmacology',
  'hemodynamics',
  'pathophysiology',
  'ventilator',
  'shock_states',
  'emergency',
  'abg_labs',
  'cardiac_ecg',
  'equipment',
]

export const EMOTIONAL_FORMATS: EmotionalFormat[] = [
  'conflict',
  'mistake',
  'stress',
  'difficult_patient_family',
  'teamwork',
  'leadership',
  'receiving_feedback',
  'giving_feedback',
  'ethics',
  'self_awareness',
  'resilience',
  'adaptability',
  'communication',
  'accountability',
  'ambiguous_judgment',
]

export const ALL_FORMATS: QuestionFormat[] = [...CLINICAL_FORMATS, ...EMOTIONAL_FORMATS, 'none']

export const FORMAT_LABELS: Record<QuestionFormat, string> = {
  scenario: 'Scenario-based',
  patient_deep_dive: 'Patient deep dive',
  pharmacology: 'Pharmacology',
  hemodynamics: 'Hemodynamics',
  pathophysiology: 'Pathophysiology',
  ventilator: 'Ventilator / respiratory',
  shock_states: 'Shock states',
  emergency: 'Emergency / crisis',
  abg_labs: 'ABG / lab interpretation',
  cardiac_ecg: 'Cardiac / ECG',
  equipment: 'Equipment / ICU devices',
  conflict: 'Conflict',
  mistake: 'Failure / mistake',
  stress: 'Stress / overwhelm',
  difficult_patient_family: 'Difficult patient or family',
  teamwork: 'Teamwork',
  leadership: 'Leadership',
  receiving_feedback: 'Receiving feedback',
  giving_feedback: 'Giving feedback / confrontation',
  ethics: 'Ethics / integrity',
  self_awareness: 'Self-awareness',
  resilience: 'Resilience',
  adaptability: 'Adaptability',
  communication: 'Communication',
  accountability: 'Accountability',
  ambiguous_judgment: 'Ambiguous / no perfect answer',
  none: 'Unclassified',
}

/** What the interviewer chose to do on a given turn. */
export type TurnAction = 'ask_follow_up' | 'next_primary' | 'final_report'

export type TurnKind = 'opening' | 'primary' | 'follow_up' | 'final_report'

export type DifficultyLevel = 1 | 2 | 3 | 4 | 5

export type RedFlag =
  | 'none'
  | 'gibberish'
  | 'non_answer'
  | 'confident_nonsense'
  | 'buzzword_dump'
  | 'verbose_without_substance'
  | 'memorized_without_understanding'
  | 'dangerous_misinformation'

/** Clinical rubric. Weights live in CLINICAL_WEIGHTS. */
export interface ClinicalSubScores {
  accuracy: number
  reasoning: number
  depth: number
  safety: number
  communication: number
}

/** Emotional intelligence / behavioral rubric — deliberately different from clinical. */
export interface EmotionalSubScores {
  self_awareness: number
  accountability: number
  communication: number
  conflict_resolution: number
  emotional_regulation: number
  professionalism: number
  teamwork: number
  reflection: number
  specificity: number
  structure: number
}

/** One completed primary scenario (the question plus all of its follow-ups). */
export interface ScenarioEvaluation {
  primary_question_number: number
  scenario_label: string
  category: QuestionCategory
  overall_score: number
  clinical: ClinicalSubScores | null
  emotional: EmotionalSubScores | null
  did_well: string[]
  to_tighten: string[]
  missed_concepts: string[]
  elite_answer: string
  red_flags: RedFlag[]
  depth_reached: DifficultyLevel
  response_to_pressure: 'improved' | 'held' | 'declined' | 'not_applicable'
}

export type Readiness =
  | 'Needs significant preparation'
  | 'Developing'
  | 'Competitive'
  | 'Strong'
  | 'Interview-ready'

export interface FinalReport {
  overall_score: number
  clinical_score: number | null
  emotional_score: number | null
  communication_score: number
  strongest_areas: string[]
  weakest_areas: string[]
  top_priorities: string[]
  struggled_with: string[]
  patterns: string[]
  trajectory: 'improved_as_difficulty_rose' | 'held_steady' | 'declined_as_difficulty_rose' | 'inconsistent'
  recommended_review: string[]
  readiness: Readiness
  summary: string
}

/**
 * Authoritative interview state. The server owns every counter here — the model
 * only reports what it did, it never sets the numbers itself.
 */
export interface InterviewState {
  version: 1
  mode: InterviewMode
  type: InterviewType
  customTopic: string
  /** 0 before the first question has been asked, then 1..maxPrimaryQuestions. */
  primaryQuestionNumber: number
  maxPrimaryQuestions: number
  /** Follow-ups already used on the current primary question. */
  followUpCount: number
  maxFollowUps: number
  /** Follow-ups left for the WHOLE interview. Keeps total length bounded. */
  followUpBudget: number
  maxFollowUpBudget: number
  turnKind: TurnKind
  currentScenario: string
  currentCategory: QuestionCategory | null
  /** Difficulty of the question actually asked most recently. */
  difficultyLevel: DifficultyLevel
  /** Where the server thinks difficulty should sit next, from rolling performance. */
  suggestedDifficulty: DifficultyLevel
  categoryCounts: Record<QuestionCategory, number>
  /** Clinical formats used, one entry per primary question. Drives variety. */
  askedFormats: QuestionFormat[]
  testedConcepts: string[]
  askedPrimaryQuestions: string[]
  evaluations: ScenarioEvaluation[]
  finalReport: FinalReport | null
  complete: boolean
}

/** What the model is contractually required to return each turn. */
export interface ModelTurn {
  action: TurnAction
  /** Only the interviewer's spoken words. Never contains scores or coaching. */
  display_text: string
  question_asked: string
  scenario_label: string
  category: QuestionCategory
  question_format: QuestionFormat
  concepts_tested: string[]
  difficulty_level: DifficultyLevel
  evaluation: ScenarioEvaluation | null
  final_report: FinalReport | null
  internal_note: string
}

/**
 * Exactly what the client is cleared to display this turn. The server decides
 * this, not the client, so Real Interview Mode cannot leak coaching even if the
 * frontend is wrong — there is simply nothing to render.
 */
export interface TurnRender {
  /** The interviewer's spoken words. */
  spoken: string
  /** This scenario's review. Practice Mode only. */
  evaluation: ScenarioEvaluation | null
  /** Every withheld review, revealed at the end of a Real Interview. */
  withheldReviews: ScenarioEvaluation[]
  finalReport: FinalReport | null
  /** All scenario scores, for the report's question-by-question list. */
  allEvaluations: ScenarioEvaluation[]
}

/** One rendered turn in the transcript. Also the row shape stored in the DB. */
export interface ChatMessage {
  role: string
  content: string
  evaluation?: ScenarioEvaluation | null
  withheldReviews?: ScenarioEvaluation[]
  finalReport?: FinalReport | null
  allEvaluations?: ScenarioEvaluation[]
}

/** Response shape returned by POST /api/interview. */
export interface InterviewTurnResponse {
  /** Plain-text composition, kept for legacy clients and degraded turns. */
  message: string
  render: TurnRender
  state: InterviewState
  turnKind: TurnKind
  questionAsked: string
  evaluation: ScenarioEvaluation | null
  finalReport: FinalReport | null
  complete: boolean
  degraded?: boolean
}
