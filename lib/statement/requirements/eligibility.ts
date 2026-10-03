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
import type { Constraints } from './constraints.ts'

/**
 * The word maximum this requirement states, or null.
 *
 * THE ONLY FIELD ELIGIBILITY READS. A page count, a character count, a
 * minimum, a font: none of them is a word maximum, and all of them yield null
 * -- which is what the existing code already reads as "the school stated no
 * word limit" and handles correctly.
 */
export function statedWordMaximum(constraints: Constraints): number | null {
  return constraints.words?.max ?? null
}

/**
 * Whether this draft may be analysed, by the approved word rules.
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
    statedMaxWords: statedWordMaximum(input.constraints),
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
 * above the bound, or a limit that excludes spaces and still clears it: all
 * true. Only a maximum strictly below the bound returns false, and that is a
 * fact rather than a judgement.
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
