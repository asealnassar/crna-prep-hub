import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CARD_CLASSES } from '../../../tests/parity/libraryHarness.ts'

/**
 * WK-QA-003 — the pin that makes the auth-free layout harness trustworthy.
 *
 * tests/parity/libraryMobile.parity.spec.ts measures a REPRODUCTION of the
 * draft card, because /statement-studio is admin-gated and driving the real
 * page needs the owner's own credentials. That trade is only safe while the
 * reproduction still matches the component: a harness that has drifted would
 * keep passing while the real library overflowed again.
 *
 * So every class string the harness renders is compared here, character for
 * character, against LibraryClient itself. If the component changes, this test
 * fails and says the harness is stale -- which is the failure you want, rather
 * than a browser spec quietly measuring markup the product no longer ships.
 *
 * THE GRID CLASS IS THE ONE THAT MATTERS. `grid-cols-1` resolves the implicit
 * track to repeat(1, minmax(0, 1fr)); without it the track is `auto`, whose
 * minimum is the item's min-content, and a nowrap title stretched the card to
 * 2,160px inside a 375px viewport.
 */

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const LIBRARY = readFileSync(path('../../../app/statement-studio/components/LibraryClient.tsx'), 'utf8')

test('the draft list grid is the one the harness reproduces', () => {
  assert.ok(
    LIBRARY.includes(`className="${CARD_CLASSES.list}"`),
    `LibraryClient must carry the grid classes the harness renders:\n  ${CARD_CLASSES.list}`,
  )
})

test('grid-cols-1 is present, because the implicit track caused WK-QA-003', () => {
  // Asserted on its own as well as inside the full string, so a reordering of
  // the class list cannot drop it while the pin above is updated to match.
  assert.match(CARD_CLASSES.list, /\bgrid-cols-1\b/)
  assert.match(LIBRARY, /<ul className="[^"]*\bgrid-cols-1\b[^"]*">/)
})

test('the grid item carries min-w-0', () => {
  assert.match(CARD_CLASSES.item, /\bmin-w-0\b/)
  assert.match(LIBRARY, /<li key=\{draft\.id\} className="[^"]*\bmin-w-0\b[^"]*">/)
})

test('every other card class the harness renders is the component’s own', () => {
  for (const [name, value] of Object.entries(CARD_CLASSES)) {
    if (name === 'list' || name === 'listBeforeFix' || name === 'item') continue
    assert.ok(
      LIBRARY.includes(`className="${value}"`),
      `${name}: the harness renders a class string LibraryClient does not have:\n  ${value}`,
    )
  }
})

test('the pre-fix class string is kept only as the harness’s counter-example', () => {
  // The spec re-measures it to prove the layout assertions can fail. It must
  // therefore NOT be what the component ships.
  assert.doesNotMatch(CARD_CLASSES.listBeforeFix, /\bgrid-cols-1\b/)
  assert.ok(
    !LIBRARY.includes(`className="${CARD_CLASSES.listBeforeFix}"`),
    'LibraryClient still carries the pre-fix grid classes',
  )
})

test('the title still truncates, which is what made the track overflow', () => {
  // If the title ever stops being nowrap, the harness's counter-example stops
  // reproducing the defect and the proof-of-failure test becomes vacuous.
  assert.match(CARD_CLASSES.title, /\btruncate\b/)
  assert.match(LIBRARY, /className="[^"]*\btruncate\b[^"]*"/)
})
