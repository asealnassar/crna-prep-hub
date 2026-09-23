/**
 * Imports advertising spend from a CSV exported from TikTok Ads Manager or
 * Google Ads.
 *
 * WHY A SCRIPT AND NOT AN API CONNECTION. Reading spend directly needs a
 * TikTok Marketing API app and a Google Ads developer token, each with its own
 * OAuth flow, approval process and stored refresh token. That is a project of
 * its own and it needs credentials this repository does not have. A CSV is the
 * honest first step: it makes cost per customer and ROAS real today, and the
 * dashboard shows them as partial because only the days you imported exist.
 *
 * NOTHING IS ESTIMATED. A day you do not import is a day with no spend row,
 * and the dashboard leaves it out rather than interpolating it.
 *
 * USAGE
 *   node --import ./test/register.mjs scripts/import-ad-spend.ts \
 *        --platform tiktok --file ~/Downloads/tiktok-september.csv [--dry-run]
 *
 * THE CSV. Column names are matched case-insensitively and both platforms'
 * usual exports are understood:
 *   date        | day | "Date"            -> YYYY-MM-DD
 *   campaign    | "Campaign name"         -> optional, defaults to all campaigns
 *   spend       | cost | "Cost" | "Amount spent (USD)"
 *   impressions | "Impr."                 -> optional
 *   clicks      | "Clicks"                -> optional
 *
 * Re-importing the same day and campaign REPLACES that row rather than adding
 * a second one, so running this twice cannot double your spend.
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

type Row = {
  platform: 'tiktok' | 'google_ads'
  spend_date: string
  campaign: string
  spend_cents: number
  impressions: number | null
  clicks: number | null
  imported_by: string
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null
}

/** A CSV split that survives quoted fields containing commas. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const character = line[index]
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        cell += '"'
        index++
      } else if (character === '"') {
        quoted = false
      } else {
        cell += character
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === ',') {
      cells.push(cell)
      cell = ''
    } else {
      cell += character
    }
  }
  cells.push(cell)
  return cells.map((value) => value.trim())
}

const HEADERS = {
  date: ['date', 'day', 'date (est)', 'date (account time zone)'],
  campaign: ['campaign', 'campaign name', 'campaign_name'],
  spend: ['spend', 'cost', 'amount spent', 'amount spent (usd)', 'cost (usd)', 'total spend'],
  impressions: ['impressions', 'impr.', 'impr'],
  clicks: ['clicks', 'clicks (all)', 'link clicks'],
}

function columnIndex(headers: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const found = headers.indexOf(candidate)
    if (found >= 0) return found
  }
  return -1
}

/** '$1,234.56' and '1234.56' both become 123456 cents. Never a float total. */
function toCents(value: string): number | null {
  const cleaned = value.replace(/[^0-9.-]/g, '')
  if (cleaned.length === 0) return null
  const amount = Number(cleaned)
  if (!Number.isFinite(amount) || amount < 0) return null
  return Math.round(amount * 100)
}

function toDate(value: string): string | null {
  const trimmed = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  // Google exports 'Sep 12, 2026'; TikTok sometimes uses '2026/09/12'.
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

export function parseSpendCsv(
  text: string,
  platform: 'tiktok' | 'google_ads',
  importedBy: string
): { rows: Row[]; skipped: string[] } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const skipped: string[] = []
  if (lines.length < 2) return { rows: [], skipped: ['the file has no data rows'] }

  // Google Ads prefixes its exports with a title row or two before the header.
  let headerIndex = 0
  for (let index = 0; index < Math.min(5, lines.length); index++) {
    const cells = splitCsvLine(lines[index]).map((cell) => cell.toLowerCase())
    if (columnIndex(cells, HEADERS.date) >= 0 && columnIndex(cells, HEADERS.spend) >= 0) {
      headerIndex = index
      break
    }
  }

  const headers = splitCsvLine(lines[headerIndex]).map((cell) => cell.toLowerCase())
  const dateAt = columnIndex(headers, HEADERS.date)
  const spendAt = columnIndex(headers, HEADERS.spend)
  const campaignAt = columnIndex(headers, HEADERS.campaign)
  const impressionsAt = columnIndex(headers, HEADERS.impressions)
  const clicksAt = columnIndex(headers, HEADERS.clicks)

  if (dateAt < 0 || spendAt < 0) {
    return { rows: [], skipped: [`could not find a date and a spend column in: ${headers.join(', ')}`] }
  }

  const rows: Row[] = []
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = splitCsvLine(line)
    const spendDate = toDate(cells[dateAt] ?? '')
    const cents = toCents(cells[spendAt] ?? '')
    if (!spendDate || cents === null) {
      skipped.push(line.slice(0, 80))
      continue
    }
    const number = (at: number): number | null => {
      if (at < 0) return null
      const value = Number((cells[at] ?? '').replace(/[^0-9]/g, ''))
      return Number.isFinite(value) ? value : null
    }
    rows.push({
      platform,
      spend_date: spendDate,
      campaign: (campaignAt >= 0 ? cells[campaignAt] : '') || '(all campaigns)',
      spend_cents: cents,
      impressions: number(impressionsAt),
      clicks: number(clicksAt),
      imported_by: importedBy,
    })
  }
  return { rows, skipped }
}

async function main() {
  const platform = arg('platform')
  const file = arg('file')
  const dryRun = process.argv.includes('--dry-run')

  if (platform !== 'tiktok' && platform !== 'google_ads') {
    console.error('--platform must be tiktok or google_ads')
    process.exit(1)
  }
  if (!file) {
    console.error('--file is required')
    process.exit(1)
  }

  const { rows, skipped } = parseSpendCsv(readFileSync(file, 'utf8'), platform, 'import-ad-spend.ts')

  console.log(`${rows.length} row(s) parsed from ${file}`)
  const total = rows.reduce((sum, row) => sum + row.spend_cents, 0)
  console.log(`total spend: $${(total / 100).toFixed(2)}`)
  if (rows.length > 0) {
    console.log(`dates: ${rows[0].spend_date} to ${rows[rows.length - 1].spend_date}`)
  }
  for (const line of skipped.slice(0, 5)) console.log(`  skipped: ${line}`)

  if (dryRun) {
    console.log('\n--dry-run: nothing was written.')
    return
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
    process.exit(1)
  }

  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error } = await admin
    .from('analytics_ad_spend')
    .upsert(rows, { onConflict: 'platform,spend_date,campaign' })

  if (error) {
    console.error('import failed:', error.message)
    process.exit(1)
  }
  console.log(`\nimported ${rows.length} row(s).`)
}

// Only run when invoked directly, so the parser can be unit tested.
if (process.argv[1]?.endsWith('import-ad-spend.ts')) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
