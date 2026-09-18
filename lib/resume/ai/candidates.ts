/**
 * Which of the model's bullet candidates are worth putting in front of someone.
 *
 * Generation offers several so the choice is the applicant's. That value is
 * lost if three of the five say the same thing in different words, or if one is
 * a bullet they already have -- a list of near-duplicates is not a choice, it is
 * the same suggestion wearing hats.
 *
 * COMPARISON ONLY. What is offered, and what reaches the resume, is the text
 * the model actually wrote. Nothing here rewrites a candidate; it only decides
 * whether one is worth showing. Pure, so both the route and the editor can use
 * it and neither can hold a second idea of what "already said" means.
 */

/**
 * Case, punctuation, bullet glyphs and runs of space removed.
 *
 * Deliberately blunt: "Managed CRRT circuits." and "managed CRRT circuits"
 * are the same bullet, and treating them as two would put both on the list.
 */
export function comparisonKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Whether a candidate says what one of `existing` already says. */
export function isDuplicate(candidate: string, existing: readonly string[]): boolean {
  const key = comparisonKey(candidate)
  if (key === '') return false
  return existing.some((text) => comparisonKey(text) === key)
}

/**
 * The candidates worth offering: blanks gone, repeats of each other collapsed,
 * and anything already written on the resume dropped.
 *
 * Order is the model's, and the first wording of a repeated idea is the one
 * kept -- later duplicates are dropped rather than preferred.
 */
export function usableCandidates(
  candidates: readonly string[],
  existing: readonly string[] = []
): string[] {
  const seen = new Set(existing.map(comparisonKey).filter((key) => key !== ''))
  const out: string[] = []

  for (const candidate of candidates) {
    const text = candidate.trim()
    const key = comparisonKey(text)
    if (text === '' || key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out
}
