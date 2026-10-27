/**
 * The font registry, and the line between honouring a font and approximating it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  STUDIO_DEFAULT_FONT, TINOS_FONT, isExactFont, resolveFontChoice,
  resolveSupportedFontFamily,
} from './fontRegistry.ts'
import { TINOS } from './fontMetrics.ts'
import { fontFamilyCapability } from './capabilities.ts'

test('the bundled face declares everything a layout or an export needs', () => {
  assert.equal(TINOS_FONT.family, 'Tinos')
  assert.equal(TINOS_FONT.metrics, TINOS)
  assert.ok(TINOS_FONT.assets.length > 0)
  assert.match(TINOS_FONT.cssFamily, /Tinos/)
  assert.equal(TINOS_FONT.pdfEmbeddable, true)
  // AND THE ASSETS REALLY EXIST. A registry entry naming a file we do not ship
  // would resolve as supported and then render in a fallback face.
  for (const asset of TINOS_FONT.assets) {
    assert.ok(readFileSync(asset).length > 0, asset)
  }
})

test('no family stated resolves to the Studio default, and claims nothing', () => {
  const resolved = resolveSupportedFontFamily(null)
  assert.equal(resolved.support, 'exact')
  assert.equal(resolved.requested, null)
  assert.equal(resolved.rendered, STUDIO_DEFAULT_FONT)
  assert.equal(resolved.disclosure, null)
  assert.deepEqual(resolveSupportedFontFamily('   '), resolved)
})

test('a family we embed is EXACT, and is applied', () => {
  const resolved = resolveSupportedFontFamily('Tinos')
  assert.equal(resolved.support, 'exact')
  assert.equal(resolved.requested, 'Tinos')
  assert.equal(resolved.disclosure, null)
  assert.equal(isExactFont(resolved), true)
  assert.equal(fontFamilyCapability('Tinos'), 'applied')
})

test('TIMES NEW ROMAN IS SUBSTITUTED, AND SAYS SO', () => {
  /*
   * The decision this state exists for. Tinos was chosen because its vertical
   * metrics match our Times New Roman reference and our fixtures wrapped
   * identically -- so the page count holds. That is a fact about line breaking,
   * not about the font being the same one, and a school that asked for Times
   * New Roman has not been given it.
   */
  const resolved = resolveSupportedFontFamily('Times New Roman')
  assert.equal(resolved.support, 'substituted')
  assert.equal(resolved.canonical, 'Times New Roman')
  assert.equal(resolved.rendered, TINOS_FONT)
  assert.match(resolved.disclosure!, /Tinos/)
  // IT MUST SAY THE SUBSTITUTE DOES NOT SATISFY THE REQUIREMENT. Wording that
  // only suggested setting the real font would leave "Tinos is fine here" as a
  // reasonable reading.
  assert.match(resolved.disclosure!, /does not satisfy the font-family requirement/)
  assert.match(resolved.disclosure!, /set Times New Roman in the final submitted document/)
  // AND NOTHING THAT IMPLIES THE SCHOOL ALLOWS TINOS.
  assert.doesNotMatch(resolved.disclosure!, /permit|allow|accept/i)
  // NOT APPLIED. A green state here would be the silent swap.
  assert.equal(fontFamilyCapability('Times New Roman'), 'substituted')
  assert.notEqual(fontFamilyCapability('Times New Roman'), 'applied')
})

test('the spellings a catalog actually uses all resolve', () => {
  // Drawn from the imported catalog's own prose: "Times New Roman",
  // "Times New Roman 12", "Times Roman or Arial".
  for (const spelling of ['Times New Roman', 'times new roman', 'TIMES NEW ROMAN',
    'Times  New  Roman', 'Times Roman', 'Times']) {
    const resolved = resolveSupportedFontFamily(spelling)
    assert.equal(resolved.support, 'substituted', spelling)
    assert.equal(resolved.canonical, 'Times New Roman', spelling)
  }
})

test('AN UNRECOGNISED FAMILY IS NOT MATCHED TO THE NEAREST THING', () => {
  // The failure mode a fuzzy matcher would introduce: Arial is a sans-serif
  // with different metrics, and quietly serving Tinos for it would break both
  // the look and the page count while reporting success.
  for (const family of ['Arial', 'Calibri', 'Garamond', 'Comic Sans MS', 'Helvetica']) {
    const resolved = resolveSupportedFontFamily(family)
    assert.equal(resolved.support, 'unsupported', family)
    assert.equal(resolved.canonical, null, family)
    assert.equal(resolved.disclosure, null, family)
    // The page is still drawn in something, and it is named honestly.
    assert.equal(resolved.rendered, STUDIO_DEFAULT_FONT, family)
    assert.equal(fontFamilyCapability(family), 'manual', family)
  }
})

test('a near-miss is not a match', () => {
  // "Times New Romans" is not Times New Roman. Accepting it would mean the
  // registry was guessing, which is the thing it is built to avoid.
  assert.equal(resolveSupportedFontFamily('Times New Romans').support, 'unsupported')
  assert.equal(resolveSupportedFontFamily('New Roman').support, 'unsupported')
})

test('EVERY REGISTRY ENTRY RENDERS A FACE WE ACTUALLY SHIP', () => {
  // A substitution is only honest if the substitute exists. Asserted on the
  // source so an entry added with no bundled face fails here.
  const source = readFileSync(new URL('./fontRegistry.ts', import.meta.url), 'utf8')
  // The REGISTRY array alone: the resolver's own fallbacks are not entries.
  const start = source.indexOf('const REGISTRY')
  assert.notEqual(start, -1, 'the registry moved')
  const registry = source.slice(start, source.indexOf('\n]', start))
  // Every face the registry declares with a bundled asset list.
  const bundled = [...source.matchAll(/export const ([A-Z][A-Z0-9_]*): BundledFont/g)]
    .map((m) => m[1]!)
  assert.ok(bundled.length > 0, 'no bundled face is declared')
  const rendered = [...registry.matchAll(/rendered:\s*([A-Za-z_][A-Za-z0-9_]*),/g)]
    .map((m) => m[1]!)
  assert.ok(rendered.length >= 3, 'the registry should have entries')
  for (const name of rendered) {
    assert.ok(bundled.includes(name), `${name} is not a declared bundled face`)
  }
})

// ===========================================================================
// PERMITTED SETS
// ===========================================================================

test('a set takes the BEST outcome its members offer', () => {
  // exact beats substituted beats unsupported, whatever order they arrive in.
  assert.equal(resolveFontChoice(['Arial', 'Tinos']).support, 'exact')
  assert.equal(resolveFontChoice(['Tinos', 'Arial']).support, 'exact')
  assert.equal(resolveFontChoice(['Arial', 'Times Roman']).support, 'substituted')
  assert.equal(resolveFontChoice(['Times Roman', 'Arial']).support, 'substituted')
  assert.equal(resolveFontChoice(['Arial', 'Calibri']).support, 'unsupported')
})

test('and names the permitted option it resolved against', () => {
  const resolved = resolveFontChoice(['Arial', 'Times Roman'])
  assert.equal(resolved.chosen, 'Times Roman')
  assert.deepEqual([...resolved.permitted], ['Arial', 'Times Roman'])
  // THE SCHOOL'S SPELLING, not the registry's canonical one.
  assert.equal(resolved.requested, 'Arial or Times Roman')
  assert.equal(resolved.canonical, 'Times New Roman', 'the registry still resolved it')
  assert.match(resolved.disclosure!, /permitted Times Roman option/)
})

test('TIES GO TO THE SCHOOL’S ORDER, so the answer is not array-dependent', () => {
  // Two equally-supported options must resolve to the first one listed, or the
  // same requirement would render differently depending on catalog ordering.
  assert.equal(resolveFontChoice(['Times Roman', 'Liberation Serif']).chosen, 'Times Roman')
  assert.equal(resolveFontChoice(['Liberation Serif', 'Times Roman']).chosen,
    'Liberation Serif')
})

test('an empty or blank set is no set at all', () => {
  for (const options of [[], ['', '   ']]) {
    const resolved = resolveFontChoice(options)
    assert.equal(resolved.support, 'exact', 'nothing was asked, so nothing failed')
    assert.equal(resolved.requested, null)
    assert.equal(resolved.chosen, null)
  }
})

test('NO DISCLOSURE EVER CLAIMS TINOS IS PERMITTED', () => {
  // Across every shape the registry can produce.
  const notes = [
    resolveSupportedFontFamily('Times New Roman').disclosure,
    resolveSupportedFontFamily('Liberation Serif').disclosure,
    resolveFontChoice(['Arial', 'Times Roman']).disclosure,
  ].filter((note): note is string => note !== null)
  assert.equal(notes.length, 3)
  for (const note of notes) {
    assert.doesNotMatch(note, /Tinos,? (is|was|would be)? ?(permitted|allowed|accepted)/i)
    assert.doesNotMatch(note, /(permitted|allowed|accepted) font:? Tinos/i)
    assert.match(note, /final submitted document/)
  }
})
