/**
 * A corrected school name must not retire a public URL.
 *
 * `/schools/{slug}` is published in app/sitemap.ts and the slug is derived
 * from `schools.name`, so correcting "Ceder Crest" moves an indexed address.
 * The correction is applied in the SQL editor, not in a deploy, so the code
 * has to be right on BOTH sides of that moment without being redeployed --
 * which is the only interesting thing about this and the whole reason these
 * tests exist.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  RETIRED_SCHOOL_SLUGS, buildSlugMap, retiredSlugDestination, slugForSchool,
  slugifySchoolName,
} from './schools.ts'

const school = (id: string, name: string) => ({
  id, name, location_state: 'PA', location_city: null,
} as never)

/** The directory as it is TODAY: the misspelling is still the live name. */
const BEFORE = buildSlugMap([
  school('504d74ce-7ab1-44af-a7c2-60b241fbb407', 'Ceder Crest'),
  school('fef27c4e-a9a8-4dd4-82d9-92c8c218ff8f', 'Saint Marys University of Minnesota'),
])

/** The directory AFTER the name corrections are applied. */
const AFTER = buildSlugMap([
  school('504d74ce-7ab1-44af-a7c2-60b241fbb407', 'Cedar Crest College'),
  school('fef27c4e-a9a8-4dd4-82d9-92c8c218ff8f', "Saint Mary's University of Minnesota"),
])

test('BEFORE the rename: the old slug is live and must NOT redirect', () => {
  assert.ok(BEFORE.has('ceder-crest'), 'the live map should still hold it')
  assert.equal(retiredSlugDestination('ceder-crest', BEFORE), null,
    'redirecting while the page still exists would break a working URL')
})

test('AFTER the rename: the old slug redirects to the new one', () => {
  assert.equal(BEFORE.has('cedar-crest-college'), false, 'the destination is new')
  assert.ok(AFTER.has('cedar-crest-college'), 'and exists afterwards')
  assert.equal(AFTER.has('ceder-crest'), false, 'while the old slug is gone')
  assert.equal(retiredSlugDestination('ceder-crest', AFTER), 'cedar-crest-college')
})

test("Saint Mary's retires nothing, because its slug does not move", () => {
  const before = slugifySchoolName('Saint Marys University of Minnesota')
  const after = slugifySchoolName("Saint Mary's University of Minnesota")
  assert.equal(before, after, 'the slugifier strips apostrophes')
  assert.equal(before, 'saint-marys-university-of-minnesota')
  // So it needs no alias, and deliberately has none.
  assert.equal(RETIRED_SCHOOL_SLUGS[before], undefined)
  assert.equal(retiredSlugDestination(before, AFTER), null, 'it is live either way')
})

test('an unknown slug still 404s rather than redirecting somewhere', () => {
  assert.equal(retiredSlugDestination('not-a-school', AFTER), null)
  assert.equal(retiredSlugDestination('', AFTER), null)
})

test('a retired slug whose destination is missing does NOT redirect', () => {
  // Half-applied state, or a destination that was itself renamed later: a
  // redirect to a 404 is worse than a 404.
  const partial = buildSlugMap([school('x', 'Some Other School')])
  assert.equal(retiredSlugDestination('ceder-crest', partial), null)
})

test('the route sends a PERMANENT redirect, and only when resolved', () => {
  const PAGE = readFileSync(
    fileURLToPath(new URL('../app/schools/[slug]/page.tsx', import.meta.url)), 'utf8')
  assert.match(PAGE, /permanentRedirect\(`\/schools\/\$\{destination\}`\)/)
  assert.match(PAGE, /retiredSlugDestination\(slug, live\)/)
  // AND THE 404 IS STILL REACHABLE, for everything that is not an alias.
  assert.match(PAGE, /notFound\(\)/)
})

test('the sitemap publishes only live slugs, never a retired one', () => {
  /*
   * The sitemap is built from buildSlugMap over the CURRENT directory, so it
   * emits whatever the name produces today and never the alias table. Before
   * the rename that is `ceder-crest`; afterwards `cedar-crest-college`. Either
   * way it lists exactly one address per school and it is the canonical one.
   */
  const SITEMAP = readFileSync(
    fileURLToPath(new URL('../app/sitemap.ts', import.meta.url)), 'utf8')
  assert.match(SITEMAP, /buildSlugMap\(allSchools\)/)
  assert.doesNotMatch(SITEMAP, /RETIRED_SCHOOL_SLUGS|retiredSlug/)
  for (const map of [BEFORE, AFTER]) {
    const published = [...map.keys()]
    assert.equal(published.length, 2, 'one address per school')
    assert.equal(new Set(published).size, published.length, 'and no duplicates')
  }
  assert.deepEqual([...AFTER.keys()].sort(),
    ['cedar-crest-college', 'saint-marys-university-of-minnesota'])
})

test('a redirect can never loop, or chain', () => {
  /*
   * TWO DISTINCT WAYS THIS COULD LOOP, and both are closed by construction
   * rather than by inspection of today's table:
   *
   *   SELF. An alias whose destination is itself would redirect for ever.
   *   CHAIN. An alias pointing at another alias would redirect to a 404, or,
   *          if the table ever grew a cycle, for ever.
   *
   * The second is also why `retiredSlugDestination` requires the destination
   * to be LIVE: a destination that is live cannot be looked up in the alias
   * table at all, because the route only consults it when the live map has
   * already missed.
   */
  for (const [from, to] of Object.entries(RETIRED_SCHOOL_SLUGS)) {
    assert.notEqual(from, to, `${from} redirects to itself`)
    assert.equal(RETIRED_SCHOOL_SLUGS[to], undefined,
      `${from} redirects to ${to}, which is itself retired -- a chain`)
  }
  // And following the one alias we have lands somewhere that redirects no
  // further, in the state where it is actually used.
  const destination = retiredSlugDestination('ceder-crest', AFTER)
  assert.equal(destination, 'cedar-crest-college')
  assert.ok(AFTER.has(destination!), 'the destination must be a live page')
  assert.equal(retiredSlugDestination(destination!, AFTER), null,
    'the destination itself redirects, which is a loop')
})

test('internal links point at the canonical route on both sides of the rename', () => {
  /*
   * A redirect that works is not enough: every link the site renders itself
   * must go straight to the live address, or the rename would leave the whole
   * directory pointing through a 301 for ever.
   *
   * THE LINKS DERIVE FROM THE NAME, NOT FROM A LIST. Three call sites build
   * `/schools/{slug}`: the state hub and the sibling list use
   * slugForSchool(school, map), and the directory uses
   * slugifySchoolName(school.name). All three read the CURRENT directory, so
   * they move with the correction and none of them can emit a retired slug.
   */
  const live = (name: string) => ({
    id: '504d74ce-7ab1-44af-a7c2-60b241fbb407', name,
    location_state: 'PA', location_city: null,
  } as never)

  // Before: every route builder agrees on the old address, which is live.
  assert.equal(slugForSchool(live('Ceder Crest'), BEFORE), 'ceder-crest')
  assert.equal(slugifySchoolName('Ceder Crest'), 'ceder-crest')

  // After: every route builder agrees on the new address, and nothing emits
  // the retired one.
  assert.equal(slugForSchool(live('Cedar Crest College'), AFTER), 'cedar-crest-college')
  assert.equal(slugifySchoolName('Cedar Crest College'), 'cedar-crest-college')
  for (const emitted of [
    slugForSchool(live('Cedar Crest College'), AFTER),
    slugifySchoolName('Cedar Crest College'),
  ]) {
    assert.equal(RETIRED_SCHOOL_SLUGS[emitted], undefined,
      'a link builder emitted a retired slug')
  }

  // SOURCE-DERIVED, so a fourth call site that hardcodes an address fails
  // here rather than silently outliving the rename.
  for (const file of [
    '../app/schools/state/[state]/page.tsx',
    '../app/schools/[slug]/page.tsx',
    '../app/schools/SchoolsClient.tsx',
  ]) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
    const links = [...source.matchAll(/href=\{`\/schools\/([^`]*)`\}/g)]
      .map((m) => m[1]!)
      // /schools/state/{slug} is the state hub, a different route whose slug
      // comes from the jurisdiction and has nothing to do with a school name.
      .filter((link) => !link.startsWith('state/'))
    assert.ok(links.length > 0, `${file} no longer links to a school page`)
    for (const link of links) {
      assert.match(link, /^\$\{/,
        `${file} links to a literal /schools/${link} rather than a derived slug`)
    }
  }
})
