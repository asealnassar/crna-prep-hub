/**
 * The certifications an ICU nurse applying to CRNA school commonly holds.
 *
 * A PICKER, NOT A CLAIM. Nothing here asserts that anyone holds anything. The
 * list exists so that someone with six certifications does not fill in six
 * forms by hand; an entry appears only for what they explicitly select, with
 * the name filled in and every other field -- issuer, number, earned, expires
 * -- left empty, because those are facts only they have. Pre-filling an issuer
 * or a date would be the product inventing a credential detail, which is the
 * one thing this feature must never do.
 *
 * Nothing in scoring reads this file: a certification is worth no points for
 * existing, and an applicant with none is not marked down for it.
 */

export interface CommonCertification {
  /** Stable key for the picker. Never stored on the resume. */
  readonly id: string
  /** What goes in the entry's name field when it is selected. */
  readonly name: string
  /** One line to tell two similar acronyms apart. */
  readonly note: string
}

export const COMMON_CERTIFICATIONS: readonly CommonCertification[] = [
  { id: 'ccrn', name: 'CCRN', note: 'Critical care registered nurse' },
  { id: 'cmc', name: 'CMC', note: 'Cardiac medicine subspecialty' },
  { id: 'csc', name: 'CSC', note: 'Cardiac surgery subspecialty' },
  { id: 'bls', name: 'BLS', note: 'Basic life support' },
  { id: 'acls', name: 'ACLS', note: 'Advanced cardiovascular life support' },
  { id: 'pals', name: 'PALS', note: 'Paediatric advanced life support' },
  { id: 'nrp', name: 'NRP', note: 'Neonatal resuscitation program' },
  { id: 'tncc', name: 'TNCC', note: 'Trauma nursing core course' },
  { id: 'tcrn', name: 'TCRN', note: 'Trauma certified registered nurse' },
]

/**
 * Two names for comparison only.
 *
 * Case, spacing and punctuation vary between "CCRN", "ccrn" and "C.C.R.N." and
 * all three mean the same credential to the person adding it. The stored name
 * is never normalised -- only this comparison is.
 */
export function normaliseCertificationName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Whether the section already carries a certification by that name. */
export function alreadyHasCertification(
  existing: readonly { readonly name: string }[],
  name: string
): boolean {
  const wanted = normaliseCertificationName(name)
  if (wanted === '') return false
  return existing.some((entry) => normaliseCertificationName(entry.name) === wanted)
}

/**
 * The names a bulk selection should actually create.
 *
 * Blanks removed, duplicates within the selection collapsed, and anything the
 * applicant already has left alone -- adding a second CCRN row is a mistake, not
 * a second certification.
 */
export function certificationsToAdd(
  existing: readonly { readonly name: string }[],
  selected: readonly string[]
): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  for (const raw of selected) {
    const name = raw.trim()
    const key = normaliseCertificationName(name)
    if (name === '' || key === '' || seen.has(key)) continue
    if (alreadyHasCertification(existing, name)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}
