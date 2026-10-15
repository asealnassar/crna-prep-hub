import {
  ARIMO_FONT_FACES, ARIMO_STACK, STUDIO_FONT_FACES, STUDIO_STACK, type FontFace,
} from './fonts.ts'
import { ARIMO, TINOS, type FontMetrics } from './fontMetrics.ts'
import type { FormatProfile } from './formatProfile.ts'

/**
 * The fonts an applicant may CHOOSE, and what each school's record allows.
 *
 * ---------------------------------------------------------------------------
 * TWO REGISTRIES, AND THEY ANSWER DIFFERENT QUESTIONS
 * ---------------------------------------------------------------------------
 * fontRegistry.ts answers "a school wrote this family name -- what can the
 * Studio do about it?", and its answers are exact / substituted / unsupported.
 * This module answers "what may this applicant pick, and what happens if they
 * pick it?". The first is about honouring a requirement; the second is about
 * offering a choice, and a choice may only ever be offered from faces this
 * product actually ships.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LIST IS SHORT, AND WHY IT IS NOT A LIST OF SYSTEM FONTS
 * ---------------------------------------------------------------------------
 * The page count is the product. A font that is not bundled renders from
 * whatever the reader's machine happens to have -- so the same essay would be
 * a different number of pages on a Mac and on a Windows laptop, and the number
 * the Studio reports would depend on who was looking. Every entry here is
 * self-hosted in public/fonts under a licence in the same directory.
 *
 * ---------------------------------------------------------------------------
 * EVERY SELECTABLE FACE MUST HAVE A REAL BOLD
 * ---------------------------------------------------------------------------
 * Bold is available on every draft. A family bundled with only a 400 face
 * would leave the browser to invent 700 by smearing the outlines -- which each
 * engine does differently, so a bold sentence would occupy different widths in
 * Chromium and WebKit and the page count would stop being a number. A family
 * without a bundled bold is therefore NOT OFFERED, which is enforced below by
 * boldCapable() and asserted by a test rather than left to reviewer discipline.
 *
 * Inter and Source Serif 4 are bundled in public/fonts and are deliberately
 * absent from this list for exactly that reason: each ships a 400 face only.
 */

export type StudioFontId = 'tinos' | 'arimo'

export interface StudioFont {
  readonly id: StudioFontId
  /** What the applicant sees in the control. */
  readonly label: string
  /** The family this face is metric-compatible with, for the label's suffix. */
  readonly standsFor: string
  readonly cssFamily: string
  readonly faces: readonly FontFace[]
  readonly metrics: FontMetrics
  /**
   * Families this face may be offered for, lowercased.
   *
   * SPELLINGS, NOT GUESSES, exactly as fontRegistry's aliases are: each is a
   * way a school has written or could write the family this face stands in
   * for. An unlisted name does not match.
   */
  readonly satisfies: readonly string[]
  /** Said whenever this face is rendered for a family it is not. */
  readonly substitutionNote: string
}

export const TINOS_STUDIO_FONT: StudioFont = {
  id: 'tinos',
  label: 'Tinos',
  standsFor: 'Times New Roman',
  cssFamily: STUDIO_STACK,
  faces: STUDIO_FONT_FACES,
  metrics: TINOS,
  satisfies: ['times new roman', 'times roman', 'times', 'timesnewroman',
    'liberation serif', 'tinos'],
  substitutionNote:
    'Tinos is a metric-compatible stand-in for Times New Roman, so the page '
    + 'count is dependable. It is not Times New Roman; set that font in the '
    + 'final submitted document.',
}

export const ARIMO_STUDIO_FONT: StudioFont = {
  id: 'arimo',
  label: 'Arimo',
  standsFor: 'Arial',
  cssFamily: ARIMO_STACK,
  faces: ARIMO_FONT_FACES,
  metrics: ARIMO,
  satisfies: ['arial', 'helvetica', 'liberation sans', 'arimo'],
  substitutionNote:
    'Arimo is a metric-compatible stand-in for Arial, so the page count is '
    + 'dependable. It is not Arial; set that font in the final submitted '
    + 'document.',
}

/**
 * Whether a family ships both weights, so Bold is real rather than smeared.
 *
 * A VARIABLE FACE COUNTS, and that is not a loophole: `'400 700'` means the
 * file carries a weight axis the font's designer drew, and the browser
 * instances it. What does not count is a family that declares 400 alone.
 */
export function boldCapable(font: StudioFont): boolean {
  const weights = new Set(font.faces.map((face) => face.weight))
  return weights.has(700) || weights.has('400 700')
}

/** Every face an applicant may pick. Ordered as the control lists them. */
export const STUDIO_FONTS: readonly StudioFont[] = [TINOS_STUDIO_FONT, ARIMO_STUDIO_FONT]

export function studioFontFor(id: unknown): StudioFont | null {
  if (typeof id !== 'string') return null
  return STUDIO_FONTS.find((font) => font.id === id) ?? null
}

/** The Studio's own choice when nothing else decides. */
export const DEFAULT_STUDIO_FONT = TINOS_STUDIO_FONT

/** The comparison key for a family name. Same rule fontRegistry normalises by. */
function normalise(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** The bundled face that stands in for a stated family, or null. */
export function studioFontSatisfying(family: string): StudioFont | null {
  const key = normalise(family)
  return STUDIO_FONTS.find((font) => font.satisfies.includes(key)) ?? null
}

// ---------------------------------------------------------------------------
// what this draft's record allows
// ---------------------------------------------------------------------------

/**
 * Why these options and no others.
 *
 * 'school-required'   the school named one family. Nothing to choose.
 * 'school-permitted'  the school named several. Choose among the ones we ship.
 * 'profile-permitted' a format profile names several. Same, plus its sizes.
 * 'studio-default'    nobody said anything. Choose from everything we ship.
 */
export type FontChoiceReason =
  'school-required' | 'school-permitted' | 'profile-permitted' | 'studio-default'

export interface FontOption {
  readonly font: StudioFont
  /** The family this option is being offered AS, in the source's own words. */
  readonly offeredFor: string | null
  /**
   * The size this option carries, when the source ties one to it.
   *
   * null MEANS THE SIZE IS NOT THIS OPTION'S BUSINESS -- a school that named a
   * font and a size states them as separate fields, and the geometry resolver
   * owns that. It is non-null only where the source pairs them, which today is
   * a format profile: APA permits 11-point Arial, not Arial.
   */
  readonly sizePt: number | null
  /** Said when the rendered face is not the family it is offered for. */
  readonly note: string | null
}

/** A family the source permits that the Studio cannot render. */
export interface UnavailableFont {
  readonly family: string
  readonly why: string
}

export interface DocumentFontChoice {
  readonly reason: FontChoiceReason
  /** True when there is nothing to choose: one permitted family, one face. */
  readonly locked: boolean
  readonly options: readonly FontOption[]
  /** The option in force, after the stored preference is applied. */
  readonly selected: FontOption
  readonly unavailable: readonly UnavailableFont[]
}

const NOT_BUNDLED =
  'Permitted, but CRNAPREPHUB does not bundle this font. Choosing it would '
  + 'make the page count depend on the fonts installed on your own computer.'

function optionFor(font: StudioFont, offeredFor: string | null, sizePt: number | null): FontOption {
  const matched = offeredFor === null || font.satisfies.includes(normalise(offeredFor))
  const stands = normalise(offeredFor ?? '') === normalise(font.standsFor)
  return {
    font,
    offeredFor,
    sizePt,
    // THE NOTE IS ABOUT THE FACE, NOT ABOUT THE CHOICE. It appears whenever the
    // rendered face is standing in for a family that was named, and not when
    // the applicant simply picked a Studio font for a draft nobody constrained.
    note: offeredFor !== null && matched && stands ? font.substitutionNote : null,
  }
}

/**
 * What this draft may be rendered in, and in what.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR CASES ARE THE OWNER'S FOUR RULES, IN THIS ORDER OF PRECEDENCE
 * ---------------------------------------------------------------------------
 * A school's explicit single family beats everything: it is the one thing an
 * admissions reader may actually check. A school's list of permitted families
 * beats a profile's, because the school is the authority over its own
 * application. A profile's list beats the Studio's, because invoking APA is
 * still a statement about the document. Only when nothing has been said does
 * the applicant choose freely.
 *
 * NOTHING HERE INVENTS A PERMISSION. Every option is traceable to the record
 * it came from, and a permitted family the Studio cannot render is reported as
 * unavailable rather than quietly replaced with one it can.
 *
 * THE PREFERENCE IS A PREFERENCE, NOT AN OVERRIDE. A stored font that is not
 * among the options -- because the school's record changed after it was
 * chosen, or because somebody wrote one directly -- is ignored in favour of
 * the first option, never rendered.
 */
export function documentFontChoice(input: {
  /** The school's single stated family, when it stated one. */
  readonly statedFamily: string | null
  /** The school's permitted families, when it listed several. */
  readonly permittedFamilies: readonly string[] | null
  readonly profile: FormatProfile | null
  /** The applicant's stored choice. */
  readonly preferred: unknown
}): DocumentFontChoice {
  const settle = (
    reason: FontChoiceReason,
    options: readonly FontOption[],
    unavailable: readonly UnavailableFont[],
    locked: boolean,
  ): DocumentFontChoice => {
    // NEVER EMPTY. A record that permits nothing we ship still has to render,
    // so the Studio's own face is the floor -- offered as itself, which is why
    // it carries no note claiming to satisfy anything.
    const offered = options.length > 0
      ? options
      : [optionFor(DEFAULT_STUDIO_FONT, null, null)]
    const wanted = studioFontFor(input.preferred)
    const selected = (wanted === null
      ? undefined
      : offered.find((option) => option.font.id === wanted.id)) ?? offered[0]!
    return { reason, locked: locked || offered.length === 1, options: offered, selected, unavailable }
  }

  // ---- A. one family, stated by the school ------------------------------
  const stated = typeof input.statedFamily === 'string' ? input.statedFamily.trim() : ''
  if (stated !== '') {
    const font = studioFontSatisfying(stated)
    if (font === null) {
      return settle('school-required', [], [{ family: stated, why: NOT_BUNDLED }], true)
    }
    return settle('school-required', [optionFor(font, stated, null)], [], true)
  }

  // ---- B. several families, permitted by the school ---------------------
  const permitted = (input.permittedFamilies ?? [])
    .map((name) => (typeof name === 'string' ? name.trim() : ''))
    .filter((name) => name !== '')
  if (permitted.length > 0) {
    return settle('school-permitted', ...partition(permitted, null), false)
  }

  // ---- C. several families, permitted by a format profile ---------------
  if (input.profile !== null) {
    /*
      THE PROFILE'S OWN CHOICE LEADS, THEN THE STANDARD'S ORDER.

      APA lists Calibri first; APA_7.fontFamily is Times New Roman, chosen
      deliberately because the Studio's metrics are calibrated against a
      Times-compatible face. Offering the list in the standard's order would
      make the FIRST option the default for anyone who has not chosen -- so an
      applicant who invoked APA and touched nothing would silently get 11-point
      Arial instead of the combination this product has tested.

      The rest keep the standard's order after it, so the list still reads as
      the standard's list rather than as ours.
    */
    const pairs = [...input.profile.permittedFonts].sort((a, b) => {
      const lead = (pair: { family: string }) =>
        normalise(pair.family) === normalise(input.profile!.fontFamily) ? 0 : 1
      return lead(a) - lead(b)
    })
    const options: FontOption[] = []
    const unavailable: UnavailableFont[] = []
    for (const pair of pairs) {
      const font = studioFontSatisfying(pair.family)
      if (font === null) {
        unavailable.push({ family: `${pair.sizePt}-point ${pair.family}`, why: NOT_BUNDLED })
        continue
      }
      if (options.some((option) => option.font.id === font.id)) continue
      // THE SIZE RIDES THE OPTION, because the profile permits the pair.
      options.push(optionFor(font, pair.family, pair.sizePt))
    }
    return settle('profile-permitted', options, unavailable, false)
  }

  // ---- D. nobody said anything ------------------------------------------
  return settle(
    'studio-default',
    STUDIO_FONTS.map((font) => optionFor(font, null, null)),
    [],
    false,
  )
}

/** Split permitted families into what we ship and what we do not. */
function partition(
  permitted: readonly string[],
  sizePt: number | null,
): [FontOption[], UnavailableFont[]] {
  const options: FontOption[] = []
  const unavailable: UnavailableFont[] = []
  for (const family of permitted) {
    const font = studioFontSatisfying(family)
    if (font === null) {
      unavailable.push({ family, why: NOT_BUNDLED })
      continue
    }
    // TWO PERMITTED NAMES CAN RESOLVE TO ONE FACE -- "Arial or Helvetica" --
    // and the control must not list it twice.
    if (options.some((option) => option.font.id === font.id)) continue
    options.push(optionFor(font, family, sizePt))
  }
  return [options, unavailable]
}
