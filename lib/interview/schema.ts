import type { InterviewState, TurnAction } from './types'
import { ALL_FORMATS } from './types'
import { allowedActions, isOpeningTurn } from './state'

const scoreField = { type: 'number', description: '0 to 10' }

const clinicalSubScores = {
  type: 'object',
  additionalProperties: false,
  required: ['accuracy', 'reasoning', 'depth', 'safety', 'communication'],
  properties: {
    accuracy: scoreField,
    reasoning: scoreField,
    depth: scoreField,
    safety: scoreField,
    communication: scoreField,
  },
}

const emotionalSubScores = {
  type: 'object',
  additionalProperties: false,
  required: [
    'self_awareness',
    'accountability',
    'communication',
    'conflict_resolution',
    'emotional_regulation',
    'professionalism',
    'teamwork',
    'reflection',
    'specificity',
    'structure',
  ],
  properties: {
    self_awareness: scoreField,
    accountability: scoreField,
    communication: scoreField,
    conflict_resolution: scoreField,
    emotional_regulation: scoreField,
    professionalism: scoreField,
    teamwork: scoreField,
    reflection: scoreField,
    specificity: scoreField,
    structure: scoreField,
  },
}

const evaluationObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'primary_question_number',
    'scenario_label',
    'category',
    'overall_score',
    'clinical',
    'emotional',
    'did_well',
    'to_tighten',
    'missed_concepts',
    'elite_answer',
    'red_flags',
    'depth_reached',
    'response_to_pressure',
  ],
  properties: {
    primary_question_number: { type: 'integer' },
    scenario_label: { type: 'string' },
    category: { type: 'string', enum: ['clinical', 'emotional', 'behavioral', 'custom'] },
    overall_score: scoreField,
    clinical: {
      anyOf: [clinicalSubScores, { type: 'null' }],
      description: 'Required for clinical or custom-technical scenarios, null otherwise.',
    },
    emotional: {
      anyOf: [emotionalSubScores, { type: 'null' }],
      description: 'Required for emotional or behavioral scenarios, null otherwise.',
    },
    did_well: { type: 'array', items: { type: 'string' } },
    to_tighten: { type: 'array', items: { type: 'string' } },
    missed_concepts: { type: 'array', items: { type: 'string' } },
    elite_answer: { type: 'string' },
    red_flags: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'none',
          'gibberish',
          'non_answer',
          'confident_nonsense',
          'buzzword_dump',
          'verbose_without_substance',
          'memorized_without_understanding',
          'dangerous_misinformation',
        ],
      },
    },
    depth_reached: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    response_to_pressure: {
      type: 'string',
      enum: ['improved', 'held', 'declined', 'not_applicable'],
    },
  },
}

const finalReportObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'overall_score',
    'clinical_score',
    'emotional_score',
    'communication_score',
    'strongest_areas',
    'weakest_areas',
    'top_priorities',
    'struggled_with',
    'patterns',
    'trajectory',
    'recommended_review',
    'readiness',
    'summary',
  ],
  properties: {
    overall_score: scoreField,
    clinical_score: { anyOf: [scoreField, { type: 'null' }] },
    emotional_score: { anyOf: [scoreField, { type: 'null' }] },
    communication_score: scoreField,
    strongest_areas: { type: 'array', items: { type: 'string' } },
    weakest_areas: { type: 'array', items: { type: 'string' } },
    top_priorities: { type: 'array', items: { type: 'string' }, description: 'Exactly three items.' },
    struggled_with: { type: 'array', items: { type: 'string' } },
    patterns: { type: 'array', items: { type: 'string' } },
    trajectory: {
      type: 'string',
      enum: [
        'improved_as_difficulty_rose',
        'held_steady',
        'declined_as_difficulty_rose',
        'inconsistent',
      ],
    },
    recommended_review: { type: 'array', items: { type: 'string' } },
    readiness: {
      type: 'string',
      enum: [
        'Needs significant preparation',
        'Developing',
        'Competitive',
        'Strong',
        'Interview-ready',
      ],
    },
    summary: { type: 'string' },
  },
}

/**
 * Builds a response schema narrowed to what the state machine permits this turn.
 * Narrowing the `action` enum is what makes the follow-up cap and the
 * ten-primary-question limit structurally enforced rather than prompt-enforced.
 */
export function buildTurnSchema(state: InterviewState) {
  const actions: TurnAction[] = allowedActions(state)
  const opening = isOpeningTurn(state)
  const mustFinish = actions.length === 1 && actions[0] === 'final_report'
  const canScore = !opening && (actions.includes('next_primary') || actions.includes('final_report'))

  // Opening turn cannot carry an evaluation; a forced final report must carry one.
  const evaluationSchema = opening
    ? { type: 'null' }
    : mustFinish
      ? evaluationObject
      : canScore
        ? { anyOf: [evaluationObject, { type: 'null' }] }
        : { type: 'null' }

  const finalReportSchema = mustFinish
    ? finalReportObject
    : actions.includes('final_report')
      ? { anyOf: [finalReportObject, { type: 'null' }] }
      : { type: 'null' }

  return {
    name: 'crna_interview_turn',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'action',
        'display_text',
        'question_asked',
        'scenario_label',
        'category',
        'question_format',
        'concepts_tested',
        'difficulty_level',
        'evaluation',
        'final_report',
        'internal_note',
      ],
      properties: {
        action: { type: 'string', enum: actions },
        display_text: {
          type: 'string',
          description:
            'Only the words the interviewer says out loud. Plain text. Never contains scores, rubric feedback, or an ideal answer.',
        },
        question_asked: {
          type: 'string',
          description:
            'The question text you ask THIS turn. On next_primary this is the NEW question, not the one just evaluated. Empty string when action is final_report.',
        },
        scenario_label: {
          type: 'string',
          description:
            'Short internal label for the scenario your question belongs to, e.g. "septic shock pressor choice". On next_primary this labels the NEW scenario you are opening.',
        },
        category: { type: 'string', enum: ['clinical', 'emotional', 'behavioral', 'custom'] },
        question_format: {
          type: 'string',
          enum: ALL_FORMATS,
          description:
            'The FORM of the question you ask THIS turn, in display_text. On next_primary this describes the NEW question, never the scenario you just evaluated.',
        },
        concepts_tested: {
          type: 'array',
          items: { type: 'string' },
          description: 'Underlying concepts this turn probes, used to prevent repeats later.',
        },
        difficulty_level: { type: 'integer', enum: [1, 2, 3, 4, 5] },
        evaluation: evaluationSchema,
        final_report: finalReportSchema,
        internal_note: {
          type: 'string',
          description: 'One short line on why this action was chosen. Never shown to the applicant.',
        },
      },
    },
  }
}
