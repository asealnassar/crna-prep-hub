/**
 * Worked examples of every writing-requirement shape, for development only.
 *
 * WHERE THESE COME FROM. Each set below was transcribed by hand from one row of
 * the owner's research spreadsheet, "CRNAPREPHUB -- CRNA Personal Statement
 * Prompts (October 2026)". The spreadsheet has four columns -- Verified, School
 * Name, Prompt, Word Count -- and on all 83 rows the Verified column is EMPTY.
 * Nothing in it has been checked against a school's own published materials by
 * anybody, which is why every set here carries UNVERIFIED and why
 * activatableForApplicants() refuses all of them. A test asserts that.
 *
 * NOT A CATALOG, AND NOT A SEED. These are TypeScript constants. No migration
 * inserts them, no repository reads them, nothing writes them to
 * statement_requirements, and they are reachable only behind the same
 * development-and-administrator gate the analyser preview uses. The 83 schools
 * are not being imported.
 *
 * THE STRUCTURING WAS DONE BY A HUMAN AND IS THE PART THAT COULD BE WRONG. The
 * spreadsheet's Word Count column is free text -- "500 words EACH; 3
 * statements", "1 page EACH; 2 separate documents (no word count stated)" --
 * and turning that into typed constraints is a judgement. No parser does it:
 * a regex confident enough to read those strings would be confident enough to
 * read them wrongly, silently, at scale. So each set carries `originalText`,
 * the spreadsheet's two cells joined verbatim, and when the structure and the
 * original disagree the original is the evidence.
 *
 * NOTHING HERE IS A CURRENT ADMISSIONS REQUIREMENT. They are examples from a
 * research file, as of October 2026, for checking that the interface renders
 * the shapes correctly.
 */

import { NO_CONSTRAINTS, type Constraints } from './constraints.ts'
import type { RequirementSet, WritingRequirement } from './requirement.ts'
import { UNVERIFIED, type Verification } from './verification.ts'

/** Research with no source and no date, said once. See the header. */
const RESEARCH: Verification = UNVERIFIED

/**
 * Sources that disagree. Still unverified, and additionally flagged.
 *
 * `conflicting` RATHER THAN `unverified` IS THE POINT: the status records that
 * there is no single correct value to store, so nothing downstream can treat
 * the absence of a limit as "not researched yet" and go looking for one.
 */
const CONFLICTING: Verification = { ...UNVERIFIED, status: 'conflicting' }

/** Shorthand for the common case: a word maximum and nothing else. */
function maxWords(max: number): Constraints {
  return { ...NO_CONSTRAINTS, words: { min: null, max } }
}

function doc(requirement: WritingRequirement): WritingRequirement {
  return requirement
}

// ===========================================================================
// CASE C -- several separate documents, each with its own limit
// ===========================================================================
/**
 * Albany Medical College: three statements, 500 words each.
 *
 * THREE DOCUMENTS, NOT ONE ESSAY WITH THREE PARTS, and the spreadsheet says
 * which: "500 words EACH; 3 statements". A per-item limit is the tell -- a
 * school that limits each answer separately is describing separate
 * submissions. Compare Buffalo below, whose 1,000 words covers the whole essay.
 *
 * THE THIRD HAS NO RECORDED QUESTION. The spreadsheet says only to "submit the
 * additional item titled 'Doctor of Nursing Essay'", so promptText holds that
 * instruction and a note says the question itself was not recorded. Writing a
 * plausible prompt for it would be inventing an admissions requirement.
 */
export const ALBANY: RequirementSet = {
  id: 'fixture-albany',
  schoolId: 'fixture-school-albany',
  schoolName: 'Albany Medical College',
  applicationCycle: null,
  verification: RESEARCH,
  originalText:
    'THREE REQUIRED STATEMENTS: (1) Explain your reasons for graduate study and how it '
    + 'connects to your career goals. (2) What specifically attracts you to Albany Medical '
    + 'College? (3) Submit the additional item titled “Doctor of Nursing Essay”'
    + '\n\nWord count: 500 words EACH; 3 statements',
  requirements: [
    doc({
      id: 'fixture-albany-1',
      documentType: 'goal-statement',
      label: 'Reasons for Graduate Study',
      promptText:
        'Explain your reasons for graduate study and how it connects to your career goals.',
      components: [],
      constraints: maxWords(500),
      choiceGroup: null,
      optional: false,
      displayOrder: 0,
      notes: [],
    }),
    doc({
      id: 'fixture-albany-2',
      documentType: 'additional-response',
      label: 'Why Albany Medical College',
      promptText: 'What specifically attracts you to Albany Medical College?',
      components: [],
      constraints: maxWords(500),
      choiceGroup: null,
      optional: false,
      displayOrder: 1,
      notes: [],
    }),
    doc({
      id: 'fixture-albany-3',
      documentType: 'other',
      label: 'Doctor of Nursing Essay',
      promptText: 'Submit the additional item titled “Doctor of Nursing Essay”.',
      components: [],
      constraints: maxWords(500),
      choiceGroup: null,
      optional: false,
      displayOrder: 2,
      notes: [
        'The research file records only the title of this item, not the question it asks. '
        + 'Check your application portal for the prompt.',
      ],
    }),
  ],
  notes: [],
}

// ===========================================================================
// CASE C + PAGE LIMITS -- separate documents measured in pages
// ===========================================================================
/**
 * Rutgers: two separate documents, one page each, no word count anywhere.
 *
 * THE WHOLE POINT OF THIS FIXTURE IS THAT stated_max_words STAYS NULL. The
 * spreadsheet says "1 page EACH; 2 separate documents (no word count stated)",
 * so there is no word limit to store, and legacyProjection() therefore writes
 * null -- which the existing editor already reads as "this school stated no
 * word limit". One page does not become 250 words, or 500, or "about a page".
 */
export const RUTGERS: RequirementSet = {
  id: 'fixture-rutgers',
  schoolId: 'fixture-school-rutgers',
  schoolName: 'Rutgers University',
  applicationCycle: null,
  verification: RESEARCH,
  originalText:
    'TWO SEPARATE WRITING REQUIREMENTS: (1) Personal statement: Describe a significant '
    + 'challenge you have faced in your academic or professional journey. How did you '
    + 'approach it, and what did you learn from the experience? (2) Writing sample: Reflect '
    + 'on an unusual skill or a distinctive background and explain how it influences your '
    + 'work, interactions, or goals.'
    + '\n\nWord count: 1 page EACH; 2 separate documents (no word count stated)',
  requirements: [
    doc({
      id: 'fixture-rutgers-1',
      documentType: 'personal-statement',
      label: 'Personal Statement',
      promptText:
        'Describe a significant challenge you have faced in your academic or professional '
        + 'journey. How did you approach it, and what did you learn from the experience?',
      components: [],
      constraints: { ...NO_CONSTRAINTS, pages: { min: null, max: 1, spacing: null } },
      choiceGroup: null,
      optional: false,
      displayOrder: 0,
      notes: [],
    }),
    doc({
      id: 'fixture-rutgers-2',
      documentType: 'writing-sample',
      label: 'Writing Sample',
      promptText:
        'Reflect on an unusual skill or a distinctive background and explain how it '
        + 'influences your work, interactions, or goals.',
      components: [],
      constraints: { ...NO_CONSTRAINTS, pages: { min: null, max: 1, spacing: null } },
      choiceGroup: null,
      optional: false,
      displayOrder: 1,
      notes: [],
    }),
  ],
  notes: [
    'The research file records a one-page limit for each document and no word count. '
    + 'This editor cannot measure pages.',
  ],
}

// ===========================================================================
// CASE B + C -- a multipart statement AND a separate essay
// ===========================================================================
/**
 * University of Minnesota: one three-part personal statement, plus a separate
 * diversity essay.
 *
 * TWO DOCUMENTS AND FOUR QUESTIONS, which is exactly the distinction this
 * architecture exists for. The spreadsheet gives the personal statement "4
 * double-spaced pages TOTAL (no per-response word count)" -- one limit for the
 * whole document -- so its three prompts are COMPONENTS of one essay. The
 * diversity essay has its own 500-word limit and is its own document.
 *
 * Splitting the three prompts into three drafts would be wrong: the applicant
 * submits one statement. Merging the diversity essay into it would also be
 * wrong: that is a separate submission with a separate limit.
 */
export const MINNESOTA: RequirementSet = {
  id: 'fixture-minnesota',
  schoolId: 'fixture-school-minnesota',
  schoolName: 'University of Minnesota',
  applicationCycle: null,
  verification: RESEARCH,
  originalText:
    'REQUIRED PERSONAL STATEMENT (three prompts): (1) Articulate your understanding of the '
    + 'nurse anesthesia advanced-practice role, skills and competencies you plan to build, '
    + 'and how your background equips you for practice. (2) Describe specific experiences '
    + 'preparing you for the specialty. (3) Explain how your background and experience '
    + 'demonstrate leadership potential, and how doctoral preparation will help you lead '
    + 'healthcare change. ALSO REQUIRED: Explain why understanding diversity, inclusion and '
    + 'equity matters in nursing and how a doctorally prepared nurse can help build a more '
    + 'equitable society.'
    + '\n\nWord count: Personal statement: 4 double-spaced pages TOTAL (no per-response '
    + 'word count); separate diversity essay: 500 words maximum',
  requirements: [
    doc({
      id: 'fixture-minnesota-1',
      documentType: 'personal-statement',
      label: 'Personal Statement',
      promptText:
        'Your personal statement must address all three of the following.',
      components: [
        {
          id: 'role-understanding',
          text:
            'Articulate your understanding of the nurse anesthesia advanced-practice role, '
            + 'skills and competencies you plan to build, and how your background equips you '
            + 'for practice.',
          optional: false,
        },
        {
          id: 'preparing-experiences',
          text: 'Describe specific experiences preparing you for the specialty.',
          optional: false,
        },
        {
          id: 'leadership-potential',
          text:
            'Explain how your background and experience demonstrate leadership potential, and '
            + 'how doctoral preparation will help you lead healthcare change.',
          optional: false,
        },
      ],
      // FOUR PAGES TOTAL, AND NO WORD LIMIT. The three prompts share one page
      // budget, which is itself the evidence that they are one document.
      constraints: { ...NO_CONSTRAINTS, pages: { min: null, max: 4, spacing: 'double' } },
      choiceGroup: null,
      optional: false,
      displayOrder: 0,
      notes: [
        'The research file records four double-spaced pages for the statement as a whole and '
        + 'no word count for the individual prompts.',
      ],
    }),
    doc({
      id: 'fixture-minnesota-2',
      documentType: 'diversity-statement',
      label: 'Diversity, Inclusion and Equity Essay',
      promptText:
        'Explain why understanding diversity, inclusion and equity matters in nursing and how '
        + 'a doctorally prepared nurse can help build a more equitable society.',
      components: [],
      constraints: maxWords(500),
      choiceGroup: null,
      optional: false,
      displayOrder: 1,
      notes: [],
    }),
  ],
  notes: [],
}

// ===========================================================================
// CASE D + C -- choose one of two, plus a required extra response
// ===========================================================================
/**
 * Southern Illinois University Edwardsville: a choice of two prompts, plus one
 * required additional response.
 *
 * THE TWO ALTERNATIVES SHARE A choiceGroup AND THE THIRD DOES NOT. The
 * spreadsheet says "Choose ONE: (1) ... OR (2) ..." and then "PLUS REQUIRED",
 * which is two distinct facts: one decision and one obligation. The checklist
 * therefore shows two entries, not three, and the applicant picks an
 * alternative before a draft exists -- after which the draft answers that
 * alternative and is only ever analysed against it.
 */
export const SIUE: RequirementSet = {
  id: 'fixture-siue',
  schoolId: 'fixture-school-siue',
  schoolName: 'Southern Illinois University Edwardsville',
  applicationCycle: null,
  verification: RESEARCH,
  originalText:
    'Choose ONE: (1) Please tell us what your professional goals are and how your graduate '
    + 'degree will enhance your achievement of these goals? OR (2) Do you have a background, '
    + 'identity, interest or talent that is so meaningful you believe your application would '
    + 'be incomplete without it? Please share your story. PLUS REQUIRED: What steps have you '
    + 'taken or resources have you put in place to move you towards success within the '
    + 'anesthesia specialization?'
    + '\n\nWord count: Choice: 2 pages maximum; additional response: 250 words maximum',
  requirements: [
    doc({
      id: 'fixture-siue-choice-goals',
      documentType: 'goal-statement',
      label: 'Option 1 — Professional Goals',
      promptText:
        'Please tell us what your professional goals are and how your graduate degree will '
        + 'enhance your achievement of these goals?',
      components: [],
      constraints: { ...NO_CONSTRAINTS, pages: { min: null, max: 2, spacing: null } },
      choiceGroup: 'siue-statement',
      optional: false,
      displayOrder: 0,
      notes: [],
    }),
    doc({
      id: 'fixture-siue-choice-background',
      documentType: 'personal-statement',
      label: 'Option 2 — Background, Identity, Interest or Talent',
      promptText:
        'Do you have a background, identity, interest or talent that is so meaningful you '
        + 'believe your application would be incomplete without it? Please share your story.',
      components: [],
      constraints: { ...NO_CONSTRAINTS, pages: { min: null, max: 2, spacing: null } },
      choiceGroup: 'siue-statement',
      optional: false,
      displayOrder: 1,
      notes: [],
    }),
    doc({
      id: 'fixture-siue-steps',
      documentType: 'additional-response',
      label: 'Steps Toward Success in Anesthesia',
      promptText:
        'What steps have you taken or resources have you put in place to move you towards '
        + 'success within the anesthesia specialization?',
      components: [],
      constraints: maxWords(250),
      choiceGroup: null,
      optional: false,
      displayOrder: 2,
      notes: [],
    }),
  ],
  notes: [],
}

// ===========================================================================
// CASE C + CHARACTER LIMITS
// ===========================================================================
/**
 * UC Davis: five NursingCAS essays, 2,500 characters including spaces each.
 *
 * CHARACTERS, AND THE SPREADSHEET SHOUTS IT: "2,500 CHARACTERS INCLUDING SPACES
 * per answer (5 answers; NOT a word limit)". So the editor shows a character
 * counter for these, spacesCount is true, and no word maximum is stored --
 * because none was stated. An applicant writing to a word count here would be
 * watching a number their application portal does not use.
 */
export const UC_DAVIS: RequirementSet = {
  id: 'fixture-uc-davis',
  schoolId: 'fixture-school-uc-davis',
  schoolName: 'University of California, Davis',
  applicationCycle: null,
  verification: RESEARCH,
  originalText:
    'FIVE NURSINGCAS ESSAYS: (1) Reflect on what inspired your CRNA path and why UC Davis is '
    + 'the right program at this stage. (2) Describe workplace/community leadership roles and '
    + 'preparation for leadership in nurse anesthesia. (3) Explain your commitment to '
    + 'diversity and inclusion, with personal or professional examples. (4) Describe a '
    + 'significant challenge, your response and what you learned about resilience. (5) '
    + 'Describe existing or planned support systems for succeeding in rigorous full-time '
    + 'study.'
    + '\n\nWord count: 2,500 CHARACTERS INCLUDING SPACES per answer (5 answers; NOT a word '
    + 'limit)',
  requirements: ([
    ['inspiration', 'Why CRNA, and Why UC Davis',
      'Reflect on what inspired your CRNA path and why UC Davis is the right program at this '
      + 'stage.'],
    ['leadership', 'Leadership Roles and Preparation',
      'Describe workplace/community leadership roles and preparation for leadership in nurse '
      + 'anesthesia.'],
    ['diversity', 'Commitment to Diversity and Inclusion',
      'Explain your commitment to diversity and inclusion, with personal or professional '
      + 'examples.'],
    ['challenge', 'A Significant Challenge',
      'Describe a significant challenge, your response and what you learned about resilience.'],
    ['support', 'Support Systems for Full-Time Study',
      'Describe existing or planned support systems for succeeding in rigorous full-time '
      + 'study.'],
  ] as readonly (readonly [string, string, string])[]).map(([slug, label, prompt], index) => doc({
    id: `fixture-uc-davis-${slug}`,
    documentType: 'additional-response',
    label,
    promptText: prompt,
    components: [],
    constraints: {
      ...NO_CONSTRAINTS,
      characters: { min: null, max: 2500, spacesCount: true },
    },
    choiceGroup: null,
    optional: false,
    displayOrder: index,
    notes: [],
  })),
  notes: [
    'The research file records these as NursingCAS essay answers limited by characters, not '
    + 'words.',
  ],
}

// ===========================================================================
// CASE B + E -- one essay, several required questions, one optional
// ===========================================================================
/**
 * University at Buffalo: ONE essay, 1,000 words, addressing four things, with an
 * optional fifth.
 *
 * ONE DOCUMENT. The spreadsheet's limit is "1,000 words maximum (entire
 * essay)" -- "entire essay" is the phrase that settles it. Four numbered
 * requirements inside one budget are components; they get no drafts of their
 * own, and prompt alignment reports on each of them within the single essay.
 *
 * AND THE FIFTH IS OPTIONAL, which is a different fact from being absent: the
 * analyser is told not to mark the essay down for omitting it.
 */
export const BUFFALO: RequirementSet = {
  id: 'fixture-buffalo',
  schoolId: 'fixture-school-buffalo',
  schoolName: 'University at Buffalo (SUNY)',
  applicationCycle: null,
  verification: RESEARCH,
  originalText:
    'Address: (1) Your reasons and career goals for an advanced-practice degree in your '
    + 'chosen specialty; (2) at least two leadership qualities, illustrated by an example; '
    + '(3) an experience in collaborative teamwork and what you learned; (4) an example of '
    + 'working with diverse populations and how graduate education will develop those skills. '
    + '(5) Optional additional comments.'
    + '\n\nWord count: 1,000 words maximum (entire essay)',
  requirements: [
    doc({
      id: 'fixture-buffalo-1',
      documentType: 'personal-statement',
      label: 'Personal Statement',
      promptText: 'Your essay must address the following.',
      components: [
        {
          id: 'reasons-goals',
          text:
            'Your reasons and career goals for an advanced-practice degree in your chosen '
            + 'specialty.',
          optional: false,
        },
        {
          id: 'leadership-qualities',
          text: 'At least two leadership qualities, illustrated by an example.',
          optional: false,
        },
        {
          id: 'collaborative-teamwork',
          text: 'An experience in collaborative teamwork and what you learned.',
          optional: false,
        },
        {
          id: 'diverse-populations',
          text:
            'An example of working with diverse populations and how graduate education will '
            + 'develop those skills.',
          optional: false,
        },
        { id: 'additional-comments', text: 'Optional additional comments.', optional: true },
      ],
      constraints: maxWords(1000),
      choiceGroup: null,
      optional: false,
      displayOrder: 0,
      notes: [],
    }),
  ],
  notes: [],
}

// ===========================================================================
// CONFLICTING SOURCES -- no single correct value
// ===========================================================================
/**
 * The Ohio State University: two official pages disagree about spacing.
 *
 * NO CONSTRAINT IS STORED FOR THE PAGE LIMIT, and that is the correct outcome
 * rather than a gap. The spreadsheet records "<=3 SINGLE-spaced pages on
 * CURRENT /nurseanesthesia page; older official page says <=3 DOUBLE-spaced
 * pages -- conflicting; verify before enforcing." Three single-spaced pages is
 * roughly twice three double-spaced pages, so picking either would mislead an
 * applicant by about half their essay. Both readings travel in `notes`, the
 * status is `conflicting`, and the applicant decides.
 */
export const OHIO_STATE: RequirementSet = {
  id: 'fixture-ohio-state',
  schoolId: 'fixture-school-ohio-state',
  schoolName: 'The Ohio State University',
  applicationCycle: null,
  verification: CONFLICTING,
  originalText:
    'Purpose and goals statement: address why you selected Nurse Anesthesia DNP, how it '
    + 'relates to your professional/educational goals, your specific academic and career '
    + 'goals, life experiences preparing you for doctoral nursing, and why you seek the DNP '
    + 'now.'
    + '\n\nWord count: ≤3 SINGLE-spaced pages on CURRENT /nurseanesthesia page; older '
    + 'official page says ≤3 DOUBLE-spaced pages — conflicting; verify before '
    + 'enforcing.',
  requirements: [
    doc({
      id: 'fixture-ohio-state-1',
      documentType: 'goal-statement',
      label: 'Purpose and Goals Statement',
      promptText:
        'Address why you selected Nurse Anesthesia DNP, how it relates to your '
        + 'professional/educational goals, your specific academic and career goals, life '
        + 'experiences preparing you for doctoral nursing, and why you seek the DNP now.',
      components: [],
      // DELIBERATELY EMPTY. See the header: there is no single page limit to
      // store, and the spacing is the thing in dispute.
      constraints: NO_CONSTRAINTS,
      choiceGroup: null,
      optional: false,
      displayOrder: 0,
      notes: [
        'Sources disagree on the page limit. The current program page states no more than '
        + 'three SINGLE-spaced pages; an older official page states no more than three '
        + 'DOUBLE-spaced pages. No limit has been stored because the two differ by roughly '
        + 'half the essay. Confirm which applies before writing to either.',
      ],
    }),
  ],
  notes: ['The research file flags this entry as conflicting and not to be enforced.'],
}

// ===========================================================================
// NOTHING STATED
// ===========================================================================
/**
 * Saint Mary's University of Minnesota: no length requirement published.
 *
 * "Not publicly specified" BECOMES NO CONSTRAINTS, not a default. The editor
 * shows a plain word count with nothing to compare it against, and the
 * eligibility floor falls back to the ordinary 100 words -- which is what every
 * general statement already does.
 */
export const SAINT_MARYS: RequirementSet = {
  id: 'fixture-saint-marys',
  schoolId: 'fixture-school-saint-marys',
  schoolName: "Saint Mary's University of Minnesota",
  applicationCycle: null,
  verification: RESEARCH,
  originalText:
    'Include your professional background, educational and professional goals, strengths, '
    + 'areas for growth, and other relevant information in your personal statement.'
    + '\n\nWord count: Not publicly specified',
  requirements: [
    doc({
      id: 'fixture-saint-marys-1',
      documentType: 'personal-statement',
      label: 'Personal Statement',
      promptText:
        'Include your professional background, educational and professional goals, strengths, '
        + 'areas for growth, and other relevant information in your personal statement.',
      components: [],
      constraints: NO_CONSTRAINTS,
      choiceGroup: null,
      optional: false,
      displayOrder: 0,
      notes: ['The research file records no published length requirement.'],
    }),
  ],
  notes: [],
}

/** Every demonstration set, in the order the preview lists them. */
export const FIXTURE_SETS: readonly RequirementSet[] = [
  ALBANY, RUTGERS, MINNESOTA, SIUE, UC_DAVIS, BUFFALO, OHIO_STATE, SAINT_MARYS,
]

/** The research file these came from, named wherever they are shown. */
export const FIXTURE_SOURCE =
  'CRNAPREPHUB — CRNA Personal Statement Prompts (October 2026), research file'

/** Said on every screen that renders a fixture. */
export const FIXTURE_NOTICE =
  'Development sample. These are unverified examples from a research file, not current '
  + 'admissions requirements, and they are not in the school catalog.'

export function fixtureById(id: string): RequirementSet | null {
  return FIXTURE_SETS.find((set) => set.id === id) ?? null
}
