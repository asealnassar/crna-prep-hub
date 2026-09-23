import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseSpendCsv } from '../../../scripts/import-ad-spend.ts'

/**
 * The ad-spend importer, fed the shapes the two platforms actually export.
 *
 * Money is the reason this is tested: a parser that turns "$1,234.56" into 1234
 * cents, or silently drops a row it could not read, would put a wrong ROAS on
 * the dashboard and there would be nothing on screen to suggest it was wrong.
 */

test('a TikTok export is read, with money kept in whole cents', () => {
  const csv = [
    'Date,Campaign name,Cost,Impressions,Clicks',
    '2026-09-01,September Launch,"$1,234.56",45000,890',
    '2026-09-02,September Launch,$98.40,3000,61',
  ].join('\n')

  const { rows, skipped } = parseSpendCsv(csv, 'tiktok', 'test')

  assert.equal(skipped.length, 0)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].spend_cents, 123456, 'the thousands separator must not truncate the amount')
  assert.equal(rows[1].spend_cents, 9840)
  assert.equal(rows[0].campaign, 'September Launch')
  assert.equal(rows[0].impressions, 45000)
  assert.equal(rows[0].platform, 'tiktok')
})

test('a Google Ads export with title rows above the header still parses', () => {
  const csv = [
    'Campaign report',
    '"Sep 1, 2026 - Sep 2, 2026"',
    'Campaign,Day,Cost,Impr.,Clicks',
    'Brand,2026-09-01,45.00,900,30',
  ].join('\n')

  const { rows } = parseSpendCsv(csv, 'google_ads', 'test')

  assert.equal(rows.length, 1)
  assert.equal(rows[0].spend_cents, 4500)
  assert.equal(rows[0].campaign, 'Brand')
})

test('a written date is normalised to a calendar day', () => {
  const { rows } = parseSpendCsv('Date,Cost\n"Sep 12, 2026",10.00', 'google_ads', 'test')

  assert.equal(rows[0].spend_date, '2026-09-12')
})

test('a campaign with a comma in its name survives the quoting', () => {
  const csv = 'Date,Campaign,Cost\n2026-09-01,"Fall, Winter push",25.00'
  const { rows } = parseSpendCsv(csv, 'tiktok', 'test')

  assert.equal(rows[0].campaign, 'Fall, Winter push')
  assert.equal(rows[0].spend_cents, 2500)
})

test('a row with no campaign is attributed to all campaigns rather than an empty name', () => {
  const { rows } = parseSpendCsv('Date,Cost\n2026-09-01,25.00', 'tiktok', 'test')

  assert.equal(rows[0].campaign, '(all campaigns)')
})

test('an unreadable row is REPORTED as skipped, never imported as zero', () => {
  const csv = ['Date,Cost', '2026-09-01,25.00', 'not-a-date,whatever', '2026-09-03,'].join('\n')

  const { rows, skipped } = parseSpendCsv(csv, 'tiktok', 'test')

  assert.equal(rows.length, 1, 'only the readable row is imported')
  assert.equal(skipped.length, 2, 'and the operator is told about the other two')
})

test('a file with no spend column refuses rather than importing nothing quietly', () => {
  const { rows, skipped } = parseSpendCsv('Date,Impressions\n2026-09-01,900', 'tiktok', 'test')

  assert.equal(rows.length, 0)
  assert.match(skipped[0], /could not find/)
})

test('a negative cost is refused: an ad platform does not pay us', () => {
  const { rows, skipped } = parseSpendCsv('Date,Cost\n2026-09-01,-50.00', 'tiktok', 'test')

  assert.equal(rows.length, 0)
  assert.equal(skipped.length, 1)
})
