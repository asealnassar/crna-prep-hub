import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The ingest endpoint's own switch.
 *
 * WHY THIS TEST EXISTS. NEXT_PUBLIC_ANALYTICS_TRACKING gated the browser and
 * nothing else. The moment the tables existed in production, a single POST to
 * /api/track wrote a visitor, a session and an event — while tracking was
 * supposed to be disabled. It was found by actually posting one during the
 * release verification, and the rows had to be deleted out of production.
 *
 * Real visitors were never at risk: their browser sends nothing while the flag
 * is off. But "disabled" has to mean disabled.
 */

const ROUTE = readFileSync(
  fileURLToPath(new URL('../../../app/api/track/route.ts', import.meta.url)),
  'utf8'
)

test('the endpoint refuses to record anything while tracking is disabled', () => {
  assert.match(ROUTE, /process\.env\.NEXT_PUBLIC_ANALYTICS_TRACKING === 'on'/)
  assert.match(ROUTE, /if \(!trackingEnabled\(\)\) return accepted\(\)/)
})

test('that check runs before ANY work, including reading the body', () => {
  const post = ROUTE.slice(ROUTE.indexOf('export async function POST'))

  const gate = post.indexOf('if (!trackingEnabled())')
  assert.ok(gate > 0, 'the gate must be inside POST')

  for (const [marker, what] of [
    ['await request.json()', 'parsing the body'],
    ['validateEvent(', 'validating'],
    ['limiter.allow(', 'rate limiting'],
    ['createClient(', 'building a database client'],
    ['analytics_record_event', 'writing'],
  ] as const) {
    const at = post.indexOf(marker)
    assert.ok(at > 0, `expected to find ${what}`)
    assert.ok(gate < at, `the switch must be checked before ${what}`)
  }
})

test('a refusal is still a 204, so a stale page holding the old bundle sees no error', () => {
  assert.match(ROUTE, /const accepted = \(\) => new NextResponse\(null, \{ status: 204/)
})

test('one variable drives both sides, so enabling tracking stays one decision', () => {
  const client = readFileSync(
    fileURLToPath(new URL('./client.ts', import.meta.url)),
    'utf8'
  )

  assert.match(client, /process\.env\.NEXT_PUBLIC_ANALYTICS_TRACKING === 'on'/)
  assert.match(ROUTE, /process\.env\.NEXT_PUBLIC_ANALYTICS_TRACKING === 'on'/)
})

test('only the exact value "on" enables it', () => {
  // 'true', '1' and 'yes' must not switch collection on by accident.
  assert.doesNotMatch(ROUTE, /NEXT_PUBLIC_ANALYTICS_TRACKING\s*(!==|===)\s*'(true|1|yes)'/)
  assert.doesNotMatch(ROUTE, /NEXT_PUBLIC_ANALYTICS_TRACKING\s*\?\?/)
})
