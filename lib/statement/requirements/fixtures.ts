/**
 * Worked examples of every writing-requirement shape, for development only.
 *
 * WHERE THESE COME FROM, AND WHAT CHANGED. Each set below was transcribed by
 * hand from one row of the owner's research spreadsheet, "CRNAPREPHUB -- CRNA
 * Personal Statement Prompts (October 2026)". When that spreadsheet was first
 * structured here its Verified column was empty on all 83 rows. It no longer
 * is: all 83 programmes have since been checked against their own published
 * materials, and the record of that is in the research directory
 * (01_verification_master.csv, 02_requirement_details.csv,
 * 05_FIXTURE_CORRECTIONS.md). The sets below have been corrected against it,
 * and FIXTURE_SOURCES names the official page each one was read from.
 *
 * THEY STILL ALL CARRY UNVERIFIED, AND THAT IS NOT AN OVERSIGHT. `verification`
 * is a statement about a CATALOG ENTRY's standing -- whether this product
 * vouches for it to an applicant. A fixture is not a catalog entry: it is a
 * TypeScript constant used to check that the interface renders a shape. No
 * fixture may ever be activatable, whatever the research now says about the
 * school, so `status` stays 'unverified' and `sourceUrl`/`verifiedOn` stay null
 * rather than being populated from the verification record. The URL lives in
 * FIXTURE_SOURCES instead, which nothing reads as provenance.
 * activatableForApplicants() refuses all of them and a test asserts it.
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

import {
  NO_CONSTRAINTS, type Constraints, characterLimit, pageLimit, statedLength, wordLimit,
} from './constraints.ts'
import type { DocumentType, RequirementSet, WritingRequirement } from './requirement.ts'
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

/**
 * Shorthand for the common case: an ENFORCED word maximum and nothing else.
 *
 * THE REGISTER IS IN THE NAME because every call site has to mean it. Each of
 * the schools using this helper publishes an explicit cap -- Albany's "500
 * words EACH", Buffalo's "1,000 words maximum (entire essay)" -- so 'enforced'
 * is a transcription, not a default. A school whose length is softer gets a
 * wordLimit() call with its own register and its own sentence, which is why
 * there is no helper for those: they must not be a one-word change away.
 */
function enforcedMaxWords(max: number): Constraints {
  return { ...NO_CONSTRAINTS, words: wordLimit({ max, enforcement: 'enforced' }) }
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
      constraints: enforcedMaxWords(500),
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
      constraints: enforcedMaxWords(500),
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
      constraints: enforcedMaxWords(500),
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
      constraints: {
        ...NO_CONSTRAINTS,
        pages: pageLimit({ max: 1, spacing: null, enforcement: 'enforced' }),
      },
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
      constraints: {
        ...NO_CONSTRAINTS,
        pages: pageLimit({ max: 1, spacing: null, enforcement: 'enforced' }),
      },
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
      constraints: {
        ...NO_CONSTRAINTS,
        pages: pageLimit({ max: 4, spacing: 'double', enforcement: 'enforced' }),
      },
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
      constraints: enforcedMaxWords(500),
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
      constraints: {
        ...NO_CONSTRAINTS,
        pages: pageLimit({ max: 2, spacing: null, enforcement: 'enforced' }),
      },
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
      constraints: {
        ...NO_CONSTRAINTS,
        pages: pageLimit({ max: 2, spacing: null, enforcement: 'enforced' }),
      },
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
      constraints: enforcedMaxWords(250),
      choiceGroup: null,
      optional: false,
      displayOrder: 2,
      notes: [],
    }),
  ],
  notes: [],
}

// ===========================================================================
// A SUGGESTED LENGTH -- a number that is not a rule
// ===========================================================================
/**
 * UC Davis: SIX separate essays, each with a SUGGESTED maximum of 250 words.
 *
 * THIS FIXTURE WAS WRONG ON BOTH THE COUNT AND THE UNIT AND IS NOW CORRECTED.
 * It previously modelled FIVE essays limited to 2,500 CHARACTERS INCLUDING
 * SPACES, transcribed from the research spreadsheet's Word Count cell. Checked
 * against the school's own essay-prompts document, there is no character limit
 * anywhere in it, there is no mention of 2,500 or of spaces counting, there are
 * SIX prompts rather than five, and the omitted one -- "Describe Current
 * Critical Care Experience" -- is restored below. See 05_FIXTURE_CORRECTIONS.md
 * in the research directory. The character-limit CAPABILITY is unaffected and
 * still demonstrated, by UT Knoxville, which is a school that really has one.
 *
 * AND THE 250 IS A SUGGESTION, WHICH IS THE POINT OF KEEPING THIS FIXTURE. The
 * official wording is "Suggested Length: Maximum of 250 words" -- the words
 * "Suggested" and "Maximum" in one phrase. So the register is 'suggested', the
 * sentence travels in `statedAs`, and the consequences are visible end to end:
 * legacyProjection() writes NO stated_max_words, the editor's counter reads
 * "412 words (250 suggested)" instead of "412 / 250 words", overageMessage()
 * says a suggested length is not a maximum, and the analyser is told in so many
 * words not to call a longer draft non-compliant.
 */
const DAVIS_SUGGESTED = 'Suggested Length: Maximum of 250 words'

export const UC_DAVIS: RequirementSet = {
  id: 'fixture-uc-davis',
  schoolId: 'fixture-school-uc-davis',
  schoolName: 'University of California, Davis',
  applicationCycle: null,
  verification: RESEARCH,
  // THE ORIGINAL SPREADSHEET CELLS, UNALTERED, INCLUDING THEIR ERROR. This
  // field is the evidence trail, not a description of the structure above it:
  // it records what the research file said, and the structure records what the
  // school publishes. Correcting it here would erase the discrepancy that
  // 05_FIXTURE_CORRECTIONS.md exists to document.
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
    ['inspiration', 'additional-response', 'Motivation for Seeking a Career as a CRNA',
      'Reflect on your journey towards pursuing a career as a Certified Registered Nurse '
      + 'Anesthetist (CRNA). Discuss experiences, influences, and personal motivations that '
      + 'have inspired you to choose this path, at this school, and why this point in your '
      + 'life is the right time for you to pursue this career. Please include why you have '
      + 'selected UC Davis for your doctoral studies, highlighting specific aspects of our '
      + 'program that resonate with your career aspirations and personal values.'],
    ['critical-care', 'additional-response', 'Describe Current Critical Care Experience',
      'Detail your current critical care experience. Include the type of acuity you manage, '
      + 'the number of ventilated patients, the use of vasoactive medications, and '
      + 'hemodynamic monitoring techniques you employ.'],
    ['leadership', 'additional-response', 'Leadership Experience',
      'Outline any leadership roles you have held at work or in the community. How have these '
      + 'experiences prepared you for a leadership role in nurse anesthesia?'],
    ['diversity', 'diversity-statement', 'Commitment to Diversity and Inclusion',
      'Explain your commitment to diversity and inclusion. Provide examples of how you have '
      + 'promoted these values in your professional or personal life.'],
    ['challenge', 'additional-response', 'Overcoming Adversity and Resilience',
      'Describe a significant challenge or adversity you have faced. How did you overcome '
      + 'this obstacle, and what did you learn from the experience about resilience?'],
    ['support', 'additional-response', 'Plans for Success',
      "Given this program's full-time, rigorous nature, describe the support systems you have "
      + 'established or plan to establish to manage your studies alongside other competing '
      + 'demands.'],
  ] as readonly (readonly [string, DocumentType, string, string])[])
    .map(([slug, documentType, label, prompt], index) => doc({
      id: `fixture-uc-davis-${slug}`,
      documentType,
      label,
      promptText: prompt,
      components: [],
      // SIX SEPARATE DOCUMENTS, because the length applies per answer. Same
      // reasoning as Albany: a per-item figure describes separate submissions.
      constraints: {
        ...NO_CONSTRAINTS,
        words: wordLimit({ max: 250, enforcement: 'suggested', statedAs: DAVIS_SUGGESTED }),
      },
      choiceGroup: null,
      optional: false,
      displayOrder: index,
      notes: [],
    })),
  notes: [
    'The research spreadsheet recorded five responses limited to 2,500 characters including '
    + 'spaces. The school publishes six prompts with a suggested length of 250 words each and '
    + 'no character limit at all. The structure above follows the school; originalText keeps '
    + 'the spreadsheet cell it was corrected from.',
  ],
}

// ===========================================================================
// A CHARACTER LIMIT, AND A PAGE LIMIT, ON ONE DOCUMENT
// ===========================================================================
/**
 * UT Knoxville: ONE essay, 5,000-18,000 characters EXCLUDING SPACES, also 3-5
 * double-spaced pages, answering two questions.
 *
 * THE CHARACTER-LIMIT DEMONSTRATION, AND A REAL ONE. UC Davis used to hold this
 * role and was not a character-limit school. This is -- the only verified
 * character limit among all 83 programmes -- and it exercises more of the model
 * at once than the fixture it replaces:
 *
 *   - a character MAXIMUM (18,000) and a character MINIMUM (5,000), both
 *     explicit, so shortfalls() has a non-synthetic example
 *   - spacesCount FALSE: "not counting spaces", stated twice. characterCount()
 *     strips all whitespace for this requirement and the counter says
 *     "excluding spaces", because the two readings differ by about a sixth
 *   - a PAGE limit on the SAME document, so both units coexist and the
 *     unmeasured notice fires while the character counter still works
 *   - TWO required questions inside ONE document, each with its own 1-2 page
 *     guidance -- which is guidance about a part, not a per-item limit, so this
 *     stays one document with two components
 *   - no word limit at all, so liveCounts() returns characters and the word
 *     count has nothing to compare against
 *
 * BOTH REGISTERS ARE 'enforced' HERE. The school writes "MINIMUM 5000
 * characters" and "MAXIMUM 18,000 characters" in capitals; nothing about that
 * is advisory. The per-prompt "(1-2 pages)" is guidance inside the components'
 * own text and is not stored as a limit, because the document's limit is the
 * 3-5 pages that covers the whole essay.
 */
const UTK_CHARACTERS =
  'MINIMUM 5000 characters - not counting spaces and MAXIMUM 18,000 characters - not '
  + 'counting spaces'

export const UT_KNOXVILLE: RequirementSet = {
  id: 'fixture-ut-knoxville',
  schoolId: 'fixture-school-ut-knoxville',
  schoolName: 'University of Tennessee, Knoxville',
  applicationCycle: null,
  verification: RESEARCH,
  originalText:
    'The purpose of this three to five double-spaced page essay (MINIMUM 5000 characters - '
    + 'not counting spaces and MAXIMUM 18,000 characters - not counting spaces) is to provide '
    + 'the Admission Committee insight into your professional goals and expectations and to '
    + 'evaluate your written communication skills.'
    + '\n\nWord count: 3-5 double-spaced pages; 5,000-18,000 characters excluding spaces',
  requirements: [
    doc({
      id: 'fixture-ut-knoxville-1',
      documentType: 'personal-statement',
      label: 'DNP Admission Essay',
      promptText:
        'The purpose of this three to five double-spaced page essay is to provide the '
        + 'Admission Committee insight into your professional goals and expectations and to '
        + 'evaluate your written communication skills.',
      components: [
        {
          id: 'phd-versus-dnp',
          text:
            'There are two terminal degrees in the nursing profession. Explain the difference '
            + 'between the PhD and DNP-prepared nurse, and discuss why you chose the DNP '
            + 'degree? (1-2 pages)',
          optional: false,
        },
        {
          id: 'contribution-to-community',
          text:
            'Describe how you will contribute to the College of Nursing community and how '
            + 'that will translate into future contributions to the nursing community. '
            + '(1-2 pages)',
          optional: false,
        },
      ],
      constraints: {
        ...NO_CONSTRAINTS,
        characters: characterLimit({
          min: 5000,
          max: 18000,
          spacesCount: false,
          enforcement: 'enforced',
          statedAs: UTK_CHARACTERS,
        }),
        pages: pageLimit({
          min: 3,
          max: 5,
          spacing: 'double',
          enforcement: 'enforced',
          statedAs: 'this three to five double-spaced page essay',
        }),
      },
      choiceGroup: null,
      optional: false,
      displayOrder: 0,
      notes: [
        'The school states that this essay is used to evaluate written communication skills.',
      ],
    }),
  ],
  notes: [],
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
      constraints: enforcedMaxWords(1000),
      choiceGroup: null,
      optional: false,
      displayOrder: 0,
      notes: [],
    }),
  ],
  notes: [],
}

// ===========================================================================
// A PAGE LIMIT WITH ITS SPACING -- the conflict resolved
// ===========================================================================
/**
 * The Ohio State University: ONE statement, no more than THREE SINGLE-SPACED
 * pages, answering four questions.
 *
 * THIS FIXTURE USED TO BE THE CONFLICTING-SOURCES DEMONSTRATION AND IS NOT ANY
 * MORE. It stored NO page limit and carried `status: 'conflicting'`, because the
 * research spreadsheet recorded two official pages disagreeing about whether
 * three pages were single- or double-spaced -- a difference of about half an
 * essay. Checked against the school's own current page, there is no
 * disagreement left: it states "Keep your statement no longer than three
 * single-spaced pages" and no double-spaced instruction appears anywhere on it.
 * The older page is superseded. So the limit is stored, the spacing is stored,
 * and the status is ordinary research. Loyola New Orleans, below, is the
 * conflicting-sources case now -- and is a genuine one.
 *
 * THE LIMIT IS STILL UNMEASURABLE AND STILL NOT CONVERTED. Three single-spaced
 * pages is a real, enforced instruction that this editor cannot check: it has
 * no pages. So `pages` is stored with its spacing, `words` stays null for ever,
 * UNMEASURED_NOTICE appears, and the analyser is told in so many words not to
 * estimate it. Storing a limit and being unable to check it are different
 * facts and both are now recorded.
 *
 * FOUR QUESTIONS, ONE DOCUMENT. The page limit covers the whole statement, so
 * these are components. The original fixture recorded none of them.
 */
export const OHIO_STATE: RequirementSet = {
  id: 'fixture-ohio-state',
  schoolId: 'fixture-school-ohio-state',
  schoolName: 'The Ohio State University',
  applicationCycle: null,
  verification: RESEARCH,
  originalText:
    'Purpose and goals statement: address why you selected Nurse Anesthesia DNP, how it '
    + 'relates to your professional/educational goals, your specific academic and career '
    + 'goals, life experiences preparing you for doctoral nursing, and why you seek the DNP '
    + 'now.'
    + '\n\nWord count: \u22643 SINGLE-spaced pages on CURRENT /nurseanesthesia page; older '
    + 'official page says \u22643 DOUBLE-spaced pages \u2014 conflicting; verify before '
    + 'enforcing.',
  requirements: [
    doc({
      id: 'fixture-ohio-state-1',
      documentType: 'goal-statement',
      label: 'Purpose and Goals Statement',
      promptText:
        'Upload a statement describing your professional experience, career goals and '
        + 'alignment with the goals of the DNP Nurse Anesthesia program. The statement should '
        + 'demonstrate your writing skills and show alignment between your goals and those of '
        + 'the program.',
      components: [
        {
          id: 'rationale',
          text:
            'Include rationale for selecting the Nurse Anesthesia DNP program and how '
            + 'completing the program will assist you in achieving your professional and '
            + 'educational goals.',
          optional: false,
        },
        {
          id: 'academic-career-goals',
          text:
            'What specifically are your academic and career goals for which the DNP program '
            + 'will prepare you best?',
          optional: false,
        },
        {
          id: 'life-experiences',
          text:
            'How have your life experiences prepared you for being a doctoral-prepared nurse?',
          optional: false,
        },
        {
          id: 'why-now',
          text:
            'Why are you seeking education in the DNP program at this time in your career?',
          optional: false,
        },
      ],
      constraints: {
        ...NO_CONSTRAINTS,
        pages: pageLimit({
          max: 3,
          spacing: 'single',
          enforcement: 'enforced',
          statedAs: 'Keep your statement no longer than three single-spaced pages.',
        }),
      },
      choiceGroup: null,
      optional: false,
      displayOrder: 0,
      notes: [
        'The spreadsheet recorded a conflict between a single-spaced and a double-spaced '
        + 'reading of the three-page limit. The school\u2019s current page states '
        + 'single-spaced and the double-spaced reading came from a page it supersedes, so the '
        + 'limit is stored. The school states that this statement is assessed on writing '
        + 'skills.',
      ],
    }),
  ],
  notes: [],
}

// ===========================================================================
// CONFLICTING SOURCES -- no single correct value
// ===========================================================================
/**
 * Loyola University New Orleans: two live official sources, two different briefs.
 *
 * THE CONFLICTING-SOURCES DEMONSTRATION, AND UNLIKE OHIO STATE IT IS REAL AND
 * UNRESOLVED. Both of these pages were live on the same day:
 *
 *   the programme page    "A Personal Statement (maximum of two pages)
 *                          describing your career goals, your journey thus
 *                          far, and why you would like to be accepted to the
 *                          Loyola Nurse Anesthesia Program."
 *   the graduate bulletin "A writing sample, limited to one page, detailing
 *                          the applicant's journey thus far, and predicted
 *                          path forward, should they be accepted..."
 *
 * They disagree about the document's NAME, its PAGE LIMIT -- two against one --
 * and its TOPICS. Nothing in either establishes which governs.
 *
 * SO NO LIMIT IS STORED, AND THAT IS THE CORRECT OUTCOME RATHER THAN A GAP.
 * One page and two pages differ by the whole essay; picking either silently is
 * the worst option available, and picking the smaller "to be safe" would still
 * be this product inventing a requirement. `status` is 'conflicting', both
 * readings travel verbatim in `notes`, and the applicant decides.
 *
 * ONE DOCUMENT, NOT TWO. This is the trap in the shape: it is tempting to model
 * two conflicting readings as two requirements, which would tell an applicant
 * Loyola wants two pieces of writing. It wants one, described twice. So there
 * is one requirement here, and the second reading is recorded as prose.
 */
export const LOYOLA: RequirementSet = {
  id: 'fixture-loyola',
  schoolId: 'fixture-school-loyola',
  schoolName: 'Loyola University New Orleans',
  applicationCycle: null,
  verification: CONFLICTING,
  originalText:
    'Describe your career goals, your journey thus far, and why you want to be accepted to '
    + 'Loyola.'
    + '\n\nWord count: Not specified (2 pages maximum)',
  requirements: [
    doc({
      id: 'fixture-loyola-1',
      documentType: 'personal-statement',
      label: 'Personal Statement',
      promptText:
        'Describe your career goals, your journey thus far, and why you would like to be '
        + 'accepted to the Loyola Nurse Anesthesia Program.',
      components: [],
      // DELIBERATELY EMPTY. Two official page limits, no basis for choosing.
      constraints: NO_CONSTRAINTS,
      choiceGroup: null,
      optional: false,
      displayOrder: 0,
      notes: [
        'Two official sources disagree about this document and no limit has been stored. The '
        + 'programme page calls it a Personal Statement with a maximum of two pages, covering '
        + 'career goals, your journey thus far, and why you would like to be accepted to the '
        + 'Loyola Nurse Anesthesia Program. The graduate bulletin calls it a writing sample '
        + 'limited to one page, covering the applicant\u2019s journey thus far and predicted '
        + 'path forward should they be accepted. These are one document described two ways, '
        + 'not two documents. Confirm which applies before writing to either.',
      ],
    }),
  ],
  notes: ['Both readings were live on the same official site when checked.'],
}

// ===========================================================================
// A TRUNCATION POLICY -- the school stops reading
// ===========================================================================
/**
 * Southern Mississippi: two double-spaced pages, and only the first two are read.
 *
 * THE STRONGEST REGISTER THERE IS, and the only verified example of it in 83
 * programmes. Most schools state a cap and say nothing about what happens if
 * you pass it. This one says: "Only the first two pages will be read if your
 * essay goes over the limit." Exceeding it does not annoy a reader, it deletes
 * part of the submission.
 *
 * THE POLICY IS REPORTED, NEVER EVALUATED. The truncated bound is a PAGE count,
 * which this editor cannot measure at all, so truncationNotice() states the
 * school's policy and makes no claim about this draft. Nothing anywhere decides
 * that a given draft "will be cut" -- that would need the page conversion this
 * feature exists to refuse.
 *
 * AND THE FONT IS A CHOICE BETWEEN TWO TYPEFACES, which is a second reason the
 * page limit could not be converted even in principle: "Times Roman or Arial 11
 * or 12 font size" has no single words-per-page figure. It is stored as
 * typography and shown, never checked.
 */
export const SOUTHERN_MISS: RequirementSet = {
  id: 'fixture-southern-miss',
  schoolId: 'fixture-school-southern-miss',
  schoolName: 'University of Southern Mississippi',
  applicationCycle: null,
  verification: RESEARCH,
  originalText:
    'Explain why you chose nurse anesthesia, describe your accomplishments, strengths and '
    + 'weaknesses, and discuss your short- and long-term goals.'
    + '\n\nWord count: Not specified (2 double-spaced pages maximum)',
  requirements: [
    doc({
      id: 'fixture-southern-miss-1',
      documentType: 'personal-statement',
      label: 'Personal Statement',
      promptText:
        'You should address: the reason you have chosen nurse anesthesia as a career, your '
        + 'personal/professional accomplishments, your strengths and weaknesses, and your '
        + 'short/long range professional goals.',
      components: [],
      constraints: {
        ...NO_CONSTRAINTS,
        pages: pageLimit({
          max: 2,
          spacing: 'double',
          enforcement: 'truncated',
          statedAs:
            'The essay is limited to two pages double-spaced. (Times Roman or Arial 11 or 12 '
            + 'font size). Only the first two pages will be read if your essay goes over the '
            + 'limit.',
        }),
        /*
          A PERMISSION, NOT A REQUIREMENT.

          This read `fontFamily: 'Times Roman or Arial'` and `fontSizePt: 12`,
          which asserted two things the school never said: that one family named
          "Times Roman or Arial" was required, and that 12 pt was the only size
          allowed. The school permits either of two families and either of two
          sizes, and that is a different fact.

          THE SCHOOL'S OWN WORDING IS KEPT. "Times Roman" is not rewritten to
          "Times New Roman" even though the font registry treats them as
          aliases: what is recorded is what was verified, and alias resolution
          is a rendering decision made later.
        */
        typography: {
          fontSizePt: null,
          fontFamily: null,
          marginsInches: null,
          fontFamilyOptions: ['Arial', 'Times Roman'],
          fontSizePtOptions: [11, 12],
        },
      },
      choiceGroup: null,
      optional: false,
      displayOrder: 0,
      notes: [
        'The school names two acceptable typefaces and two acceptable point sizes, so no '
        + 'single words-per-page figure could apply to this page limit even in principle.',
      ],
    }),
  ],
  notes: [],
}

// ===========================================================================
// A STATED LENGTH THAT IS NOT A LIMIT
// ===========================================================================
/**
 * University of South Dakota: "A written 500 word statement".
 *
 * THE WHOLE FIXTURE EXISTS FOR ONE WORD THAT IS ABSENT. The official sentence,
 * identical in the current and the previous graduate catalogue, is "A written
 * 500 word statement to address advanced practice professional goals." It does
 * not say maximum. It does not say no more than. It does not say or fewer. It
 * states a length.
 *
 * SO 500 IS STORED, AND IS NOT A CAP. The register is 'target':
 * legacyProjection() writes no stated_max_words, the counter reads "620 words
 * (500 the stated length)", and a 620-word draft is told it is longer than the
 * length the school describes and that this is not a breach of a stated limit.
 * Compare North Florida's "500 words or fewer", which is the same number and a
 * real maximum.
 *
 * THE RESEARCH SPREADSHEET SAID 500-1,000 AND WAS WRONG. Two catalogue years
 * carry the single figure; the range appears to have been conflated with
 * Michigan-Flint's genuine "500 to 1000 words". originalText keeps the cell.
 */
export const SOUTH_DAKOTA: RequirementSet = {
  id: 'fixture-south-dakota',
  schoolId: 'fixture-school-south-dakota',
  schoolName: 'University of South Dakota',
  applicationCycle: null,
  verification: RESEARCH,
  originalText:
    'Address your advanced practice professional goals in a written statement.'
    + '\n\nWord count: 500\u20131,000 words',
  requirements: [
    doc({
      id: 'fixture-south-dakota-1',
      documentType: 'goal-statement',
      label: 'Written Statement',
      promptText: 'Address advanced practice professional goals.',
      components: [],
      constraints: {
        ...NO_CONSTRAINTS,
        words: wordLimit({
          max: 500,
          enforcement: 'target',
          statedAs:
            'A written 500 word statement to address advanced practice professional goals.',
        }),
      },
      choiceGroup: null,
      optional: false,
      displayOrder: 0,
      notes: [
        'The spreadsheet recorded 500\u20131,000 words. The official catalogue states a '
        + 'single figure of 500 and does not call it a maximum, in both the current and the '
        + 'preceding year.',
      ],
    }),
  ],
  notes: [],
}

// ===========================================================================
// A LENGTH SHOWN AND NOT ENFORCED -- the approved answer for an unconfirmed one
// ===========================================================================
/**
 * Wayne State: "a summary (1-2 pages) double-spaced", shown and not bounded.
 *
 * THIS FIXTURE CHANGED SHAPE WHEN THE OWNER CHOSE OPTION A. It previously
 * stored pages 1-2 with the register 'unknown', which was honest about the
 * standing of the figure and still put a number in a field that a limit check
 * reads. The approved policy for the nine verified programmes with an
 * unconfirmed length is narrower than that: SHOW THE SCHOOL'S WORDING, STORE NO
 * BOUND. So `pages` is null and the sentence lives in `unenforcedLength`.
 *
 * WHY THE FIGURE IS UNCONFIRMED. The official sentence is "Applicant Personal
 * Statement a summary (1-2 pages) double-spaced highlighting your professional
 * nursing career". A parenthetical range inside the phrase "a summary" is not
 * called a maximum, is not advertised as a suggestion and is not a target
 * either. It could be read any of those ways and the school gives no help.
 *
 * WHAT THE APPLICANT GETS. The sentence, in quotation marks, with "not enforced
 * here, because the school does not say whether it is a limit" beside it; a
 * notice explaining why nothing is counting it; and a plain word counter with
 * no quota, because a word count is honest about itself and is not being
 * compared with anything. What they do NOT get is a page bound that nobody
 * confirmed, a progress bar toward it, or an over-limit warning from it.
 *
 * AND THE DOUBLE SPACING IS GONE WITH THE BOUND. `pages` carried the spacing,
 * and spacing without a page count is a formatting instruction about a page
 * this editor cannot see. It travels in the quoted sentence, where it is the
 * school's words rather than a field something might act on.
 */
export const WAYNE_STATE: RequirementSet = {
  id: 'fixture-wayne-state',
  schoolId: 'fixture-school-wayne-state',
  schoolName: 'Wayne State University',
  applicationCycle: null,
  verification: RESEARCH,
  originalText:
    'Describe your professional nursing career and why you want to pursue nurse anesthesia.'
    + '\n\nWord count: Not specified (1\u20132 double-spaced pages)',
  requirements: [
    doc({
      id: 'fixture-wayne-state-1',
      documentType: 'personal-statement',
      label: 'Applicant Personal Statement',
      promptText:
        'A summary highlighting your professional nursing career, including reasons for '
        + 'desiring the nurse anesthesia profession.',
      components: [],
      constraints: {
        ...NO_CONSTRAINTS,
        // NO pages, NO words, NO characters. The sentence is the whole of what
        // this product says about this document's length.
        unenforcedLength: statedLength({
          text:
            'Applicant Personal Statement a summary (1-2 pages) double-spaced highlighting '
            + 'your professional nursing career',
          // The school's own sentence, read from its admission-requirements
          // page. See FIXTURE_SOURCES.
          verbatim: true,
        }),
      },
      choiceGroup: null,
      optional: false,
      displayOrder: 0,
      notes: [
        'The school publishes a page range without saying whether it is a maximum, a minimum '
        + 'or a suggestion, and publishes no typeface or point size, so the range is not '
        + 'reducible to any word figure either. The wording is shown and no limit is stored.',
      ],
    }),
  ],
  notes: [],
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
 *
 * NOT THE SAME AS WAYNE STATE ABOVE, and the difference is worth keeping both
 * for. Saint Mary's published NO length at all, so there is nothing to show;
 * Wayne State published one whose standing is unconfirmed, so there is a
 * sentence to show and nothing to enforce. Collapsing the two would lose the
 * distinction between silence and an unconfirmed instruction.
 *
 * ITS ESSAYS ARE BLINDED, which is a content constraint and not a length one:
 * "Please do not state any personal identifying information within the essay".
 * That is recorded in the research dataset rather than modelled here.
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
  ALBANY, RUTGERS, MINNESOTA, SIUE, UC_DAVIS, UT_KNOXVILLE, BUFFALO, OHIO_STATE,
  LOYOLA, SOUTHERN_MISS, SOUTH_DAKOTA, WAYNE_STATE, SAINT_MARYS,
]

/** The research file these came from, named wherever they are shown. */
export const FIXTURE_SOURCE =
  'CRNAPREPHUB — CRNA Personal Statement Prompts (October 2026), research file'

/**
 * The official page each set was checked against, by fixture id.
 *
 * DELIBERATELY NOT IN `verification.sourceUrl`. That field is provenance: it is
 * half of what activatableForApplicants() needs, and a fixture must never be
 * one status flip away from being shown to an applicant as a verified
 * requirement. So the URL lives here, where nothing reads it as standing, and
 * the development preview can still show a reviewer where each example came
 * from. A test asserts every fixture's sourceUrl is still null.
 *
 * EVERY ENTRY WAS CHECKED ON 2026-10-02 against the page named. The full
 * record -- including the eight programmes whose prompts could NOT be verified
 * -- is in the research directory, not here. Sets structured before the
 * verification and not revisited by it are absent rather than given a guess.
 */
export const FIXTURE_CHECKED_ON = '2026-10-02'

export const FIXTURE_SOURCES: Readonly<Record<string, string>> = {
  'fixture-uc-davis':
    'https://health.ucdavis.edu/nursing/admissions/pdf/'
    + 'betty-irene-moore-school-of-nursing-DNP-NA-essay-prompts-NCAS-0724.pdf',
  'fixture-ut-knoxville':
    'https://nursing.utk.edu/admissions-and-aid/graduate-admissions/essay-prompts/',
  'fixture-ohio-state': 'https://nursing.osu.edu/nurseanesthesia',
  'fixture-loyola':
    'https://www.loyno.edu/academics/colleges/college-nursing-health/bsn-dnp-nurse-anesthesia',
  'fixture-southern-miss':
    'https://www.usm.edu/leadership-advanced-nursing-practice/'
    + 'nurse_anesthesia_additional_information/nap_faqs.php',
  'fixture-south-dakota': 'https://catalog.usd.edu/preview_entity.php?catoid=41&ent_oid=2389',
  'fixture-wayne-state': 'https://applebaum.wayne.edu/nurse-anesthesia/admission-requirements',
  'fixture-saint-marys':
    'https://www.smumn.edu/degree/doctorate/nursing-practice-in-nurse-anesthesiology-dnp/',
}

/** Said on every screen that renders a fixture. */
export const FIXTURE_NOTICE =
  'Development sample. These are unverified examples from a research file, not current '
  + 'admissions requirements, and they are not in the school catalog.'

export function fixtureById(id: string): RequirementSet | null {
  return FIXTURE_SETS.find((set) => set.id === id) ?? null
}
