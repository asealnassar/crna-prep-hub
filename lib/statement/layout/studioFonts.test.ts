import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import {
  ARIMO_STUDIO_FONT, DEFAULT_STUDIO_FONT, STUDIO_FONTS, TINOS_STUDIO_FONT,
  boldCapable, documentFontChoice, studioFontFor, studioFontSatisfying,
} from './studioFonts.ts'
import { APA_7 } from './formatProfile.ts'
import { ALL_FONT_FACES } from './fonts.ts'

/**
 * WHAT MAY BE CHOSEN, AND WHAT HAPPENS WHEN IT IS.
 *
 * The owner's rule, which these exist to keep true: a school's record
 * constrains WHICH fonts are legal; it never removes the ability to choose, and
 * it never permits a font this product cannot draw.
 */

const choice = (over: Partial<Parameters<typeof documentFontChoice>[0]> = {}) =>
  documentFontChoice({
    statedFamily: null, permittedFamilies: null, profile: null, preferred: null, ...over,
  })

// ===========================================================================
// EVERY OFFERED FACE IS REAL, AND BOLD
// ===========================================================================

test('EVERY SELECTABLE FACE SHIPS A REAL BOLD', () => {
  /*
   * Bold is available on every draft. A family bundled with only a 400 face
   * would leave the browser to invent 700 by smearing the outlines, which each
   * engine does differently -- so the page count would depend on the reader's
   * browser. The rule is enforced in code by boldCapable(); this is what stops
   * a family being added to the list without one.
   */
  for (const font of STUDIO_FONTS) {
    assert.equal(boldCapable(font), true, `${font.id} has no bold face`)
    const weights = new Set(font.faces.map((face) => face.weight))
    assert.ok(weights.has(700) || weights.has('400 700'), `${font.id}`)
  }
})

test('and every face it names is actually in the repository', () => {
  for (const font of STUDIO_FONTS) {
    assert.ok(font.faces.length > 0, `${font.id} declares no faces`)
    for (const face of font.faces) {
      assert.equal(existsSync(`public/fonts/${face.file}`), true,
        `${font.id}: public/fonts/${face.file} is missing`)
    }
    // A LICENCE BESIDE THE BYTES. Self-hosting somebody's font is only
    // defensible with the licence that permits it, in the same directory.
    const licence = `public/fonts/${font.metrics.family}-LICENSE.txt`
    assert.equal(existsSync(licence), true, `${font.id}: ${licence} is missing`)
    assert.match(readFileSync(licence, 'utf8'), /SIL Open Font License/)
  }
})

test('a bundled family with NO bold is deliberately not offered', () => {
  /*
   * Inter and Source Serif 4 are bundled -- the marketing pages use them --
   * and each ships a 400 face only. They are absent from the selectable list
   * for exactly the reason above, and this asserts the absence rather than
   * trusting that nobody adds them.
   */
  for (const unbolded of ['inter', 'source-serif', 'sourceserif4']) {
    assert.equal(STUDIO_FONTS.some((font) => font.id === unbolded), false, unbolded)
  }
  assert.equal(existsSync('public/fonts/inter-latin.woff2'), true, 'the premise')
  assert.equal(existsSync('public/fonts/inter-bold-latin.woff2'), false,
    'Inter gained a bold file; it may now be offered, with its metrics')
  assert.equal(existsSync('public/fonts/source-serif-4-bold-latin.woff2'), false,
    'Source Serif 4 gained a bold file; it may now be offered, with its metrics')
})

test('no face is declared twice, and all of them reach the stylesheet', () => {
  const declared = new Set(ALL_FONT_FACES.map((face) => face.file))
  for (const font of STUDIO_FONTS) {
    for (const face of font.faces) {
      assert.ok(declared.has(face.file), `${face.file} is never declared to the browser`)
    }
  }
  const files = ALL_FONT_FACES.map((face) => face.file)
  assert.equal(new Set(files).size, files.length, 'a face file is declared twice')
})

// ===========================================================================
// RULE A — THE SCHOOL REQUIRES ONE FAMILY
// ===========================================================================

test('A: a required family is LOCKED, and the substitution is disclosed', () => {
  const result = choice({ statedFamily: 'Times New Roman' })
  assert.equal(result.reason, 'school-required')
  assert.equal(result.locked, true)
  assert.equal(result.options.length, 1)
  assert.equal(result.selected.font.id, 'tinos')
  // THE EXISTING DISCLOSURE SURVIVES. Tinos is not Times New Roman, and the
  // applicant is told so where they would otherwise assume compliance.
  assert.match(result.selected.note ?? '', /not Times New Roman/)
  assert.match(result.selected.note ?? '', /metric-compatible/)
})

test('A: a required family we do not ship offers nothing and says why', () => {
  const result = choice({ statedFamily: 'Garamond' })
  assert.equal(result.reason, 'school-required')
  assert.equal(result.locked, true)
  // It still renders -- in the Studio's own face, offered as itself, making no
  // claim to satisfy the requirement.
  assert.equal(result.selected.font.id, DEFAULT_STUDIO_FONT.id)
  assert.equal(result.selected.note, null)
  assert.deepEqual(result.unavailable.map((u) => u.family), ['Garamond'])
  assert.match(result.unavailable[0]!.why, /does not bundle/)
})

test('A: the preference cannot override a required family', () => {
  // The one rule that matters most: a stored choice is a preference, never a
  // permission. A school that requires Times gets Times whatever is stored.
  const result = choice({ statedFamily: 'Times New Roman', preferred: 'arimo' })
  assert.equal(result.selected.font.id, 'tinos')
  assert.equal(result.locked, true)
})

// ===========================================================================
// RULE B — THE SCHOOL PERMITS SEVERAL
// ===========================================================================

test('B: the applicant chooses among the permitted families we ship', () => {
  const result = choice({ permittedFamilies: ['Times Roman', 'Arial'] })
  assert.equal(result.reason, 'school-permitted')
  assert.equal(result.locked, false)
  assert.deepEqual(result.options.map((o) => o.font.id), ['tinos', 'arimo'])
  assert.deepEqual(result.unavailable, [])
  // And the stored preference decides which is in force.
  assert.equal(choice({ permittedFamilies: ['Times Roman', 'Arial'], preferred: 'arimo' })
    .selected.font.id, 'arimo')
})

test('B: a permitted family we cannot draw is LISTED, not silently dropped', () => {
  const result = choice({ permittedFamilies: ['Arial', 'Calibri'] })
  assert.deepEqual(result.options.map((o) => o.font.id), ['arimo'])
  assert.deepEqual(result.unavailable.map((u) => u.family), ['Calibri'])
  // "We cannot do this" is said in terms of the consequence, not of our stack.
  assert.match(result.unavailable[0]!.why, /page count/)
})

test('B: two permitted names that resolve to one face are offered once', () => {
  const result = choice({ permittedFamilies: ['Arial', 'Helvetica'] })
  assert.deepEqual(result.options.map((o) => o.font.id), ['arimo'])
  // One option means nothing to choose, so it reports itself as locked.
  assert.equal(result.locked, true)
})

test('B: permitting only fonts we lack still renders, claiming nothing', () => {
  const result = choice({ permittedFamilies: ['Garamond', 'Book Antiqua'] })
  assert.equal(result.selected.font.id, DEFAULT_STUDIO_FONT.id)
  assert.equal(result.selected.note, null, 'it must not claim to satisfy either')
  assert.equal(result.unavailable.length, 2)
})

// ===========================================================================
// RULE C — A FORMAT PROFILE PERMITS SEVERAL
// ===========================================================================

test('C: APA offers only the permitted fonts we ship, WITH THEIR SIZES', () => {
  const result = choice({ profile: APA_7 })
  assert.equal(result.reason, 'profile-permitted')
  // APA permits 11-point Arial and 12-point Times New Roman, among others.
  const offered = result.options.map((o) => ({ id: o.font.id, sizePt: o.sizePt }))
  /*
   * THE PROFILE'S OWN CHOICE LEADS. APA lists Calibri first and Arial second,
   * but APA_7.fontFamily is 12-point Times New Roman -- the combination this
   * product's metrics are calibrated against. Leaving the standard's order
   * would make 11-point Arial the default for anyone who chose nothing.
   */
  assert.deepEqual(offered, [
    { id: 'tinos', sizePt: 12 },
    { id: 'arimo', sizePt: 11 },
  ])
  assert.equal(result.selected.font.id, 'tinos')
  assert.equal(result.selected.sizePt, 12)
  // And the applicant may still pick the other one.
  assert.equal(choice({ profile: APA_7, preferred: 'arimo' }).selected.sizePt, 11)
  /*
   * THE SIZE IS PART OF THE PERMISSION. APA does not permit "Arial"; it
   * permits 11-point Arial. Offering the font and leaving the size at 12
   * would present a document as APA-compliant in a configuration APA does not
   * list.
   */
  assert.equal(result.options.every((o) => o.sizePt !== null), true)
})

test('C: and the four it permits that we cannot draw are named', () => {
  const result = choice({ profile: APA_7 })
  assert.deepEqual([...result.unavailable.map((u) => u.family)].sort(), [
    '10-point Computer Modern', '10-point Lucida Sans Unicode',
    '11-point Calibri', '11-point Georgia',
  ])
})

test('C: a school field still beats the profile', () => {
  // The school is the authority over its own application; invoking a standard
  // does not hand that over.
  const result = choice({ statedFamily: 'Arial', profile: APA_7 })
  assert.equal(result.reason, 'school-required')
  assert.equal(result.selected.font.id, 'arimo')
  assert.equal(result.selected.sizePt, null, 'a school font carries no profile size')
})

// ===========================================================================
// RULE D — NOBODY SAID ANYTHING
// ===========================================================================

test('D: everything we ship is offered, and Tinos is the default', () => {
  const result = choice()
  assert.equal(result.reason, 'studio-default')
  assert.equal(result.locked, false)
  assert.deepEqual(result.options.map((o) => o.font.id), STUDIO_FONTS.map((f) => f.id))
  assert.equal(result.selected.font.id, DEFAULT_STUDIO_FONT.id)
  assert.equal(DEFAULT_STUDIO_FONT.id, 'tinos')
  // NO SUBSTITUTION NOTE. Nothing was requested, so nothing is being stood in
  // for; saying "this is not Times New Roman" here would be answering a
  // question nobody asked.
  assert.equal(result.selected.note, null)
  assert.equal(choice({ preferred: 'arimo' }).selected.note, null)
})

test('D: an unknown stored preference is ignored, never rendered', () => {
  for (const bogus of ['comic-sans', '', null, 42, { id: 'arimo' }]) {
    const result = choice({ preferred: bogus })
    assert.equal(result.selected.font.id, DEFAULT_STUDIO_FONT.id, String(bogus))
  }
})

// ===========================================================================
// THE REGISTRY ITSELF
// ===========================================================================

test('ids round-trip, and nothing else resolves', () => {
  assert.equal(studioFontFor('tinos'), TINOS_STUDIO_FONT)
  assert.equal(studioFontFor('arimo'), ARIMO_STUDIO_FONT)
  for (const bogus of ['Tinos', 'TINOS', 'times', '', null, undefined, 7]) {
    assert.equal(studioFontFor(bogus), null, String(bogus))
  }
})

test('family names resolve by spelling, not by guesswork', () => {
  for (const name of ['Times New Roman', 'times roman', 'TIMES', 'Liberation Serif']) {
    assert.equal(studioFontSatisfying(name)?.id, 'tinos', name)
  }
  for (const name of ['Arial', 'helvetica', 'Liberation Sans']) {
    assert.equal(studioFontSatisfying(name)?.id, 'arimo', name)
  }
  // Not matched to the nearest thing.
  for (const name of ['Arial Narrow', 'Times Ten', 'Calibri', 'Garamond']) {
    assert.equal(studioFontSatisfying(name), null, name)
  }
})

test('the ids are exactly what migration 015 permits', () => {
  const sql = readFileSync(
    'supabase/migrations/20261013_015_statement_draft_document_font.sql', 'utf8')
  assert.match(sql, /NOT APPLIED/)
  for (const font of STUDIO_FONTS) {
    assert.ok(sql.includes(`'${font.id}'`), `the CHECK does not permit ${font.id}`)
  }
  // AND NOTHING ELSE. A value the database accepts that the Studio cannot draw
  // would render from whatever the reader's machine has.
  const permitted = /document_font in \(([^)]*)\)/.exec(sql)?.[1] ?? ''
  const listed = [...permitted.matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual([...listed].sort(), STUDIO_FONTS.map((f) => f.id).sort())
})
