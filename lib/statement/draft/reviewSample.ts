import { parseReview, type StatementReview } from './reviewSchema.ts'
import type { CategoryId } from './rubric.ts'

/**
 * Sample analysis results, for looking at the interface without paying for one.
 *
 * NOT A MOCKUP. Every sample below is a raw object run through parseReview --
 * the same validator the route uses on a real model response -- so the scores
 * are banded by bandFor, the overall percentage is computed by overallScore,
 * and the category set is checked against the rubric. If the schema tightens,
 * these stop building and this file fails its test rather than drifting into a
 * picture of an interface that no longer exists.
 *
 * SO A SAMPLE CANNOT SHOW SOMETHING THE REAL THING COULD NOT. That is the whole
 * point of building it this way: a hand-written fixture could display a score
 * of 4, an eighth category or a 95% that disagreed with its own parts, and the
 * owner would approve a layout that can never occur.
 *
 * NOTHING HERE TOUCHES A MODEL, A DRAFT OR THE LEDGER. It is three constants
 * and a function; there is no request to make and no row to write.
 */

/** Visible on every sample, so a preview can never be mistaken for real feedback. */
export const SAMPLE_NOTICE = 'Sample AI feedback — visual preview only.'

/*
  THE EXCERPT AND THE PROSE ARE SEPARATE FIELDS HERE TOO.

  The sample is a VISUAL preview of a real result, so it has to carry the same
  shape a real one does -- including `excerpt`, which parseReview() verifies
  against the submitted essay. This sample has no essay (that is the point: it
  is a specimen, not an analysis), so it is parsed without one and the excerpt
  travels as written. A `found: false` category carries no excerpt at all,
  because the validator refuses one beside an absence. AI-QA-002.
*/
const EVIDENCE: Readonly<Record<CategoryId, {
  evidence: string; found: boolean; excerpt?: string
}>> = {
  motivation: {
    excerpt: 'I decided on anesthesia the night a trauma patient coded and the CRNA kept the room calm.',
    evidence: 'A specific night, and your own part in it.',
    found: true,
  },
  'clinical-experience': {
    excerpt: 'Three years in a cardiothoracic ICU, mostly post-op CABG and valve patients.',
    evidence: 'The unit and the patient population are both named.',
    found: true,
  },
  'reflection-growth': {
    evidence: 'The draft lists what you did but does not say how any of it changed your practice.',
    found: false,
  },
  'understanding-goals': {
    excerpt: 'I want to practise in a rural critical-access hospital where CRNAs work independently.',
    evidence: 'A particular kind of practice, not a general ambition.',
    found: true,
  },
  'organization-flow': {
    excerpt: 'Additionally, the unit relied on protocols I had helped to write.',
    evidence: '"Additionally" opens four of your seven paragraphs.',
    found: true,
  },
  'writing-quality': {
    excerpt: 'The patient\'s condition were deteriorating rapidly and the room was full.',
    evidence: 'Subject and verb disagree in this sentence.',
    found: true,
  },
  'prompt-alignment': {
    evidence: 'The prompt asks what you will contribute; the draft describes what you have done.',
    found: false,
  },
}

const EXPLANATION: Readonly<Record<CategoryId, string>> = {
  motivation: 'The moment is specific and yours, which is what lifts this above a stated interest in anesthesia. It stops short of saying what that night changed about how you work.',
  'clinical-experience': 'The unit and patient population are named, which most drafts never manage. No single case is developed far enough to show your judgement.',
  'reflection-growth': 'Experience is reported rather than examined. A reader finishes the draft knowing where you worked and not how it changed you, which is the part a committee is reading for.',
  'understanding-goals': 'The goal is concrete and the setting is named. The draft does not connect it to the independent practice a CRNA programme prepares you for.',
  'organization-flow': 'The arc from bedside to anesthesia is clear and easy to follow. The repeated transition flattens the rhythm and makes consecutive paragraphs read as a list.',
  'writing-quality': 'The prose is clean and readable throughout. Two agreement errors and one run-on sentence are the only things a reader would catch.',
  'prompt-alignment': 'The draft answers a question adjacent to the one asked. The material is relevant but it is organised around your history rather than around your contribution.',
}

const RECOMMENDATION: Readonly<Record<CategoryId, string>> = {
  motivation: 'Add one sentence after that night saying what you began doing differently because of it.',
  'clinical-experience': 'Take one case you already mention and give it four sentences: what you saw, what you decided, what happened.',
  'reflection-growth': 'For the two experiences you describe, write what you believed before and what you believe now.',
  'understanding-goals': 'Name one thing about rural practice that requires the autonomy a CRNA has and a bedside nurse does not.',
  'organization-flow': 'Replace three of the four "Additionally" openings with a phrase that carries the previous paragraph forward.',
  'writing-quality': 'Read the draft aloud once; both agreement errors are audible.',
  'prompt-alignment': 'Rewrite the closing paragraph to answer the prompt directly: what you expect to contribute, in your words.',
}

/**
 * The requirements a school's prompt states, broken out.
 *
 * The sample shows all three statuses, because a breakdown where everything is
 * "addressed" would hide the part of the interface that matters most.
 */
const SAMPLE_COMPONENTS = [
  {
    component: 'Your professional goals',
    status: 'addressed',
    evidence: '"I want to practise in a rural critical-access hospital where CRNAs work independently."',
  },
  {
    component: 'Relevant past experiences',
    status: 'addressed',
    evidence: '"Three years in a cardiothoracic ICU, mostly post-op CABG and valve patients."',
  },
  {
    component: 'What you expect to contribute to nurse anesthesia',
    status: 'missing',
    evidence: 'The draft describes what you have done but never says what you will bring.',
  },
]

function rawCategory(id: CategoryId, score: number) {
  return {
    id,
    score,
    evidence: EVIDENCE[id].evidence,
    evidenceFound: EVIDENCE[id].found,
    excerpt: EVIDENCE[id].excerpt ?? null,
    explanation: EXPLANATION[id],
    recommendation: RECOMMENDATION[id],
    ...(id === 'prompt-alignment' ? { components: SAMPLE_COMPONENTS } : {}),
  }
}

/** Deliberately mixed, so every band appears somewhere in the preview. */
const SCORES: Readonly<Record<CategoryId, number>> = {
  motivation: 8,
  'clinical-experience': 7,
  'reflection-growth': 3,
  'understanding-goals': 7,
  'organization-flow': 6,
  'writing-quality': 9,
  'prompt-alignment': 5,
}

const SUMMARY = {
  overallAssessment:
    'A readable draft with a real moment at its centre and a clearly named clinical background. '
    + 'What it does not yet do is reflect: it reports a career rather than examining what that career taught you, '
    + 'and that is the difference between a competent statement and a memorable one.',
  strengths: [
    'A specific opening moment that belongs only to you',
    'Named unit and patient population rather than "critical care experience"',
    'Clean, readable prose with few errors',
  ],
  priorities: [
    'Show what your experience changed about how you practise',
    'Develop one case far enough to show your clinical judgement',
    'Vary the paragraph openings so consecutive sections do not read as a list',
  ],
  nextSteps: [
    'Write four sentences about a single case and replace the general description with them',
    'Add one "I used to think / I now think" pair to the third paragraph',
    'Read the draft aloud and fix what you stumble over',
  ],
}

/**
 * The samples, built through the real validator.
 *
 * THROWS IF THEY DO NOT VALIDATE, deliberately. A sample that cannot pass
 * parseReview is a sample of something the product cannot produce, and the
 * right moment to find that out is in a test rather than on a screen somebody
 * is approving.
 */
function build(promptAttached: boolean): StatementReview {
  const ids = (Object.keys(SCORES) as CategoryId[])
    .filter((id) => promptAttached || id !== 'prompt-alignment')
  const parsed = parseReview({
    raw: { categories: ids.map((id) => rawCategory(id, SCORES[id])), ...SUMMARY },
    promptAttached,
  })
  if (!parsed.ok) {
    throw new Error(`sample review does not validate: ${parsed.reason}`)
  }
  return parsed.review
}

/** Six categories; prompt alignment is absent and the interface says so. */
export function generalSample(): StatementReview {
  return build(false)
}

/** All seven, scored against a school's question. */
export function schoolSample(): StatementReview {
  return build(true)
}

/** The word counts the samples are presented with, so limits can be seen too. */
export const SAMPLE_GENERAL_WORDS = 612
export const SAMPLE_SCHOOL_WORDS = 1_180
export const SAMPLE_SCHOOL_MAX_WORDS = 1_000
