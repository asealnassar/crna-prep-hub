import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * What the published Privacy Policy may and may not say.
 *
 * THE FIRST TEST IS THE POINT. The policy is a public page on a public site,
 * and its contact address is the one piece of it that is a real mailbox
 * belonging to a real person. It was asked, explicitly, that the owner's
 * personal address never appear there. A constant is easy to change back by
 * accident; this makes that change fail out loud.
 */

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const PAGE = read('../../app/privacy/page.tsx')
const BUTTON = read('../../app/privacy/PrivacyChoicesButton.tsx')

test('the owner’s personal email address appears nowhere on the privacy page', () => {
  for (const source of [PAGE, BUTTON]) {
    assert.doesNotMatch(source, /asealnassar/i, 'a personal address must never be published here')
    assert.doesNotMatch(source, /@gmail\.com/i, 'nor any personal mailbox')
  }
})

test('the contact address is the support alias, and it is the only one', () => {
  assert.match(PAGE, /support@crnaprephub\.com/)

  const addresses = new Set(PAGE.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [])
  assert.deepEqual([...addresses], ['support@crnaprephub.com'])
})

test('the page actually offers a way to reach that address', () => {
  assert.match(PAGE, /mailto:\$\{CONTACT\}|mailto:support@crnaprephub\.com/)
})

/**
 * The rest of these exist because the policy makes factual claims about the
 * software. If the software changes and the policy does not, the policy
 * becomes untrue — which is worse than having no policy, because somebody
 * relied on it.
 */

test('the retention period on the page matches the one the database enforces', () => {
  const schedule = read('../../supabase/migrations/20260922_002_analytics_retention_schedule.sql')

  assert.match(PAGE, /400 days/, 'the policy states a retention period')
  assert.match(schedule, /analytics_prune\(400\)/, 'and the scheduled job enforces that same number')
})

test('the cookies named on the page are the cookies the code actually sets', () => {
  const tracker = read('../analytics/tracking/client.ts')
  const consent = read('../consent/policy.ts')

  for (const cookie of ['cph_vid', 'cph_sid', 'cph_consent']) {
    assert.match(PAGE, new RegExp(cookie), `${cookie} must be disclosed`)
  }
  assert.match(tracker, /VISITOR_COOKIE = 'cph_vid'/)
  assert.match(tracker, /SESSION_COOKIE = 'cph_sid'/)
  assert.match(consent, /CONSENT_COOKIE = 'cph_consent'/)
})

test('the page discloses that typed content is sent to an AI provider', () => {
  // The interview, resume, personal-statement and transcript features all post
  // user text to OpenAI. Nothing on the site said so before this page existed.
  assert.match(PAGE, /OpenAI/)
})

test('the page discloses both advertising platforms by name', () => {
  assert.match(PAGE, /TikTok/)
  assert.match(PAGE, /Google/)
})

test('the page tells visitors they can change their mind, and gives them the control', () => {
  assert.match(BUTTON, /openPrivacyChoices/)
  assert.match(PAGE, /PrivacyChoicesButton/)
})
