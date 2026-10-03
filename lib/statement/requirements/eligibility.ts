/**
 * Whether a structured requirement's draft is long enough to analyse.
 *
 * THE APPROVED WORD RULES DECIDE, AND NOTHING ELSE DOES. rubric.ts owns
 * MIN_ANALYSIS_WORDS and SHORT_PROMPT_CEILING; this module reads the word
 * maximum out of a structured requirement and hands the decision to
 * eligibilityFor(). It defines no threshold of its own.
 *
 * AN EARLIER VERSION OF THIS FILE DID, and that was wrong. It introduced a
 * 500-character floor and a 300-character short-response ceiling so that a
 * character-limited response would be judged in its own unit. Both numbers were
 * invented here -- no owner approved them -- and inventing an eligibility
 * policy is not a detail: it decides who may spend an analysis and who is told
 * their essay is too short. They are gone.
 *
 * SO A CHARACTER LIMIT CONTROLS MEASURED COMPLIANCE, NOT ELIGIBILITY. The
 * editor counts characters, warns when the stated maximum is passed, and tells
 * the model the exact count -- all of which is measurement against something
 * the school actually stated. None of it moves the floor for analysis, because
 * moving that floor would need a characters-per-word figure nobody published.
 *
 * AND A PAGE LIMIT STILL YIELDS NO FLOOR. A requirement stating only pages, or
 * only characters, or nothing at all, falls through to the ordinary 100-word
 * floor -- the same floor a general statement has always had.
 *
 * ONE CONSEQUENCE IS LEFT UNRESOLVED ON PURPOSE. A school asking for a very
 * short character-limited answer can state a maximum that the 100-word floor
 * cannot fit inside. That is a real gap with no approved answer, so this module
 * DETECTS and EXPLAINS it rather than legislating: see wordFloorFits() below,
 * which changes no decision and only lets the interface say why the button is
 * unavailable instead of showing a target that cannot be reached.
 */

import {
  MIN_ANALYSIS_WORDS, SHORT_PROMPT_CEILING, eligibilityFor, type Eligibility,
} from '../draft/rubric.ts'
import { isStrict, type Constraints } from './constraints.ts'

/**
 * The word figure this requirement publishes, in any register, or null.
 *
 * A DISPLAY ACCESSOR. It answers "did the school publish a word figure?", which
 * is what a card, a counter and a limit line need. It does NOT answer "is there
 * a cap?", and eligibility no longer asks it -- see enforcedWordMaximum().
 *
 * A page count, a character count, a font: none of them is a word figure, and
 * all of them yield null, which every existing path already reads as "the
 * school stated no word limit".
 */
export function statedWordMaximum(constraints: Constraints): number | null {
  return constraints.words?.max ?? null
}

/**
 * The word maximum eligibility may act on: a figure the school made a RULE.
 *
 * THE SHORT-PROMPT EXCEPTION ONLY MAKES SENSE FOR A CAP, and that is the whole
 * reason this function exists separately. The owner-approved policy in rubric.ts
 * says two things about a stated maximum: below 50 words the rubric does not
 * apply at all, and below 100 words the ordinary floor drops to 80% of the
 * maximum. Both exist because A CAP MAKES THE 100-WORD FLOOR UNREACHABLE -- an
 * applicant told "no more than 80 words" cannot write 100 without breaking the
 * rule, so holding them to 100 would be absurd.
 *
 * THAT RATIONALE EVAPORATES FOR A SUGGESTION. A school that SUGGESTS 80 words,
 * or describes an 80-word statement without calling it a limit, has forbidden
 * nothing: the applicant may write 150 and break no rule, so the 100-word floor
 * is perfectly reachable and the exception must not fire. Handing a suggested 80
 * to eligibilityFor() would lower the floor to 64 on the strength of a limit
 * that does not exist, and a suggested 40 would refuse the analysis outright.
 * Both are the "treated as a strict maximum" error.
 *
 * THE APPROVED POLICY IS UNCHANGED AND STILL LIVES IN rubric.ts. Not a constant
 * moves, no threshold is invented, and no character count is converted into
 * words. What narrowed is which figures count as a MAXIMUM for a rule that was
 * only ever about maxima.
 *
 * AND NO EXISTING DRAFT MOVES. A legacy draft's stated_max_words parses as
 * 'enforced', so it reaches this unchanged; statement_requirements has no rows.
 */
export function enforcedWordMaximum(constraints: Constraints): number | null {
  const words = constraints.words
  if (words === null || words.max === null) return null
  return isStrict(words.enforcement) ? words.max : null
}

/**
 * Whether this draft may be analysed, by the approved word rules.
 *
 * IT READS THE ENFORCED MAXIMUM ONLY. See enforcedWordMaximum(): the floor and
 * the short-prompt ceiling are rules about CAPS, and a suggestion is not one.
 *
 * RETURNS rubric.ts's OWN Eligibility TYPE, deliberately. An earlier version
 * returned a parallel type carrying a `unit`, which existed only to describe
 * the character policy that has been removed. One type means the route cannot
 * branch two ways on the same question.
 */
export function eligibilityForRequirement(input: {
  readonly constraints: Constraints
  readonly words: number
}): Eligibility {
  return eligibilityFor({
    words: input.words,
    // THE ENFORCED MAXIMUM, NOT THE PUBLISHED FIGURE. A suggested or target
    // length is not a cap, so it must not trigger a rule that exists only
    // because a cap makes the ordinary floor unreachable.
    statedMaxWords: enforcedWordMaximum(input.constraints),
  })
}

/**
 * The fewest characters 100 words can possibly occupy.
 *
 * NOT A CONVERSION, AND THE DIFFERENCE MATTERS. A conversion would be a claim
 * about typical word length -- "100 words is about 550 characters" -- which is
 * exactly what this feature refuses to invent. This is a LOWER BOUND that is
 * true of every possible text: n words need at least n characters, plus the
 * n - 1 separators between them. One-letter words reach it; nothing is below
 * it. It is used only to decide whether a stated maximum makes the approved
 * floor PROVABLY unreachable, never to estimate how long anything is.
 */
export function minimumCharactersFor(words: number): number {
  if (words <= 0) return 0
  return words + (words - 1)
}

/**
 * Whether the approved word floor can be reached inside this requirement's
 * stated character maximum.
 *
 * TRUE WHENEVER IT IS NOT PROVABLY IMPOSSIBLE. No character limit, a limit
 * above the bound, a limit that excludes spaces and still clears it, or a limit
 * the school did not make a rule: all true. Only an ENFORCED maximum strictly
 * below the bound returns false, and that is a fact rather than a judgement.
 *
 * IT DECIDES NOTHING. eligibilityForRequirement() does not call this, and the
 * route does not gate on it. Its only consumer is the explanation shown beside
 * an unavailable Analyze button, so an applicant reads "this school's limit is
 * shorter than this analysis supports" instead of a word target they cannot
 * reach. What SHOULD happen for such a requirement -- a short-response
 * analyser, a lower floor, a plain refusal -- is an owner decision that has not
 * been made.
 */
export function wordFloorFits(constraints: Constraints): boolean {
  const characters = constraints.characters
  if (characters === null || characters.max === null) return true
  // A SUGGESTED CHARACTER LIMIT MAKES NOTHING UNREACHABLE, for the same reason
  // a suggested word limit does not lower the floor: it forbids nothing. This
  // function's whole output is a REFUSAL -- "your school's limit is shorter than
  // this analysis supports" -- and refusing an applicant an analysis over a
  // figure their school called a suggestion would be the strictest possible
  // reading of the softest possible instruction.
  if (!isStrict(characters.enforcement)) return true
  // Excluding spaces, the separators do not count toward the school's limit,
  // so the bound is the word count itself.
  const bound = characters.spacesCount === false
    ? MIN_ANALYSIS_WORDS
    : minimumCharactersFor(MIN_ANALYSIS_WORDS)
  return characters.max >= bound
}

/** What an applicant is told when the floor cannot be reached. */
export const FLOOR_UNREACHABLE =
  'This school’s stated limit is shorter than the full analysis supports, so it is not '
  + 'available for this response. You can still write and save it here.'

/** What an applicant is told they still need, in words. */
export function shortfallLabel(eligibility: Eligibility): string | null {
  if (eligibility.kind !== 'too-short') return null
  return `${eligibility.words.toLocaleString('en-US')} of `
    + `${eligibility.minimumWords.toLocaleString('en-US')} words needed.`
}

/** Why the rubric does not apply to a very short prompt. */
export function tooShortLabel(eligibility: Eligibility): string | null {
  if (eligibility.kind !== 'prompt-too-short') return null
  return `This requirement asks for at most `
    + `${eligibility.statedMaxWords.toLocaleString('en-US')} words, which is shorter than this `
    + 'analysis is built for.'
}

/** The approved word constants, re-exported so a test can compare the paths. */
export { MIN_ANALYSIS_WORDS, SHORT_PROMPT_CEILING }
