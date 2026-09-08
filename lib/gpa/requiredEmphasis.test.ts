import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
/** Source with its prose stripped, so a comment can never satisfy a test. */
const code = (p: string) =>
  read(p).replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '')
const CARD = () => read('app/gpa-calculator/components/SetupCard.tsx')
const HERO = () => read('app/gpa-calculator/components/GpaHero.tsx')
const TABS = () => read('app/gpa-calculator/components/workspace.tsx')
const PAGE = () => read('app/gpa-calculator/page.tsx')
const CSS = () => read('app/globals.css')

/** The required header block, which only renders when something is blocked. */
const requiredHeader = () => {
  const s = CARD()
  return s.slice(s.indexOf('{blocked ? ('), s.indexOf('{/* ------------------'))
}

// ------------------------------------------------------- the danger treatment
test('UX: required items get a danger treatment, not the calm one', () => {
  const card = CARD()
  assert.match(card, /blocked\s*\n?\s*\?\s*`border-rose-300 ring-1 ring-rose-200/,
    'the card border turns red only when blocked')
  const header = requiredHeader()
  assert.match(header, /bg-rose-50/)
  assert.match(header, /border-rose-200/)
  assert.match(header, /text-rose-900/)
})

test('UX: the message never relies on colour alone', () => {
  const header = requiredHeader()
  assert.match(header, /<AlertTriangle/, 'a warning icon')
  assert.match(header, /Action required/, 'and the words')
  assert.match(header, /required before your GPA is complete/, 'and an explicit count')
  assert.match(header, /Some coursework is currently being held out of your calculation/)
  // The count badge is a number, readable without seeing its colour.
  assert.match(header, /bg-rose-600 px-2 py-0\.5 text-xs font-bold text-white tabular-nums/)
})

test('UX: singular and plural are both handled', () => {
  const header = requiredHeader()
  assert.match(header, /\{n\} action\{n === 1 \? '' : 's'\} required/)
})

test('UX: nothing blocked keeps the neutral header', () => {
  const card = CARD()
  // The calm heading still exists, on the other branch of the same ternary.
  assert.match(card, /setupHeading\(state\)/)
  assert.match(card, /setupSummary\(state, courseCount\)/)
  assert.ok(card.indexOf('{blocked ? (') < card.indexOf('setupHeading(state)'),
    'the danger header is the blocked branch; the calm one is the fallback')
})

// -------------------------------------------------------------- the pulse
test('UX: the pulse runs a few cycles and then stops', () => {
  const css = CSS()
  assert.match(css, /@keyframes gpa-attention/)
  // Three cycles, not "infinite".
  assert.match(css, /animation: gpa-attention 700ms ease-in-out 3;/)
  assert.ok(!/gpa-attention[^}]*infinite/.test(css), 'never a loop')

  const card = CARD()
  assert.match(card, /const \[pulse, setPulse\] = useState\(false\)/)
  assert.match(card, /pulse \? 'gpa-attention' : ''/)

  // Two independent ways to stop, so it cannot get stuck on: the animation
  // ending, and a timer that does not depend on the animation running at all.
  assert.match(card, /onAnimationEnd=\{\(\) => setPulse\(false\)\}/)
  assert.match(card, /setTimeout\(\(\) => setPulse\(false\), 2400\)/)
  // The timer hangs off `pulse`, not off the count -- a count-keyed effect
  // re-running cleared the pending timer and the class never came off.
  const stopEffect = card.slice(card.indexOf('if (!pulse) return'))
  assert.match(stopEffect.slice(0, 200), /\}, \[pulse\]\)/)
})

test('UX: the pulse fires on arrival and when a NEW required item appears', () => {
  const card = CARD()
  assert.match(card, /if \(requiredCount > lastCount\.current\)/,
    'more required items than last time, including the first render')
  assert.match(card, /\}, \[requiredCount\]\)/)
  // Resolving one must not re-trigger it.
  assert.ok(!/if \(requiredCount !== lastCount\.current\)/.test(card))
})

test('UX: reduced motion gets the static treatment only', () => {
  const css = CSS()
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
  assert.match(block, /\.gpa-attention\s*\{\s*animation: none;/)
  // The red styling is not inside the media query, so it always applies.
  const header = requiredHeader()
  assert.match(header, /bg-rose-50/)
})

// ------------------------------------------------------------- the GPA card
test('UX: the hero says the coursework is held out, not merely awaiting', () => {
  const hero = code('app/gpa-calculator/components/GpaHero.tsx')
  assert.match(hero, /course\{blocked === 1 \? '' : 's'\} held out pending review/)
  assert.ok(!/more awaiting review/.test(hero), 'the vaguer wording is gone')
  assert.match(hero, /<AlertTriangle/, 'and it carries an icon too')
  // "pending" says temporary; nothing claims a permanent exclusion.
  assert.ok(!/permanently|will not count|never count/i.test(hero))
})

test('UX: the GPA value itself is untouched', () => {
  const hero = HERO()
  assert.match(hero, /\{show\(results\.overall\.display\)\}/)
  assert.match(hero, /results\.overall\.creditsCounted/)
  assert.match(hero, /results\.overall\.coursesCounted/)
})

// ------------------------------------------------------- the Policies badge
test('UX: the Policies badge matches the required card, and clears itself', () => {
  const tabs = TABS()
  assert.match(tabs, /badgeTone\?: 'neutral' \| 'warn' \| 'danger'/)
  assert.match(tabs, /t\.badgeTone === 'danger' \? 'bg-rose-600 text-white'/)
  // A zero badge is not rendered at all, so resolving the last item clears it.
  assert.match(tabs, /typeof t\.badge === 'number' && t\.badge > 0/)

  const page = PAGE()
  assert.match(page, /badge: policyAttention, badgeTone: policyAttention > 0 \? 'danger' : 'warn'/)
})

// ------------------------------------------------- optional stays neutral
test('UX: optional and informational sections stay calm', () => {
  const card = CARD()
  // Quarter-credit coursework.
  const quarter = card.slice(card.indexOf('D57: quarter credit'), card.indexOf('excluded by rule'))
  assert.match(quarter, /bg-slate-50\/70/)
  assert.ok(!/rose|AlertTriangle|Action required/.test(quarter), 'nothing red here')

  // Optional transfer records.
  const optional = card.slice(card.indexOf('Optional: one group per originating school'),
    card.indexOf('D57: quarter credit'))
  assert.match(optional, /bg-slate-50\/70/)
  assert.ok(!/rose|AlertTriangle/.test(optional))

  // Required transfer confirmations are violet, not the card-level danger red.
  const requiredTransfers = card.slice(card.indexOf('Required: coursework here could be'),
    card.indexOf('Optional: one group per originating school'))
  assert.match(requiredTransfers, /bg-violet-50\/50/)
})

test('UX: the review list keeps its amber, well short of danger', () => {
  const card = CARD()
  const review = card.slice(card.indexOf('----- review'), card.indexOf('D57: quarter credit'))
  assert.match(review, /bg-amber-50\/40/)
  assert.ok(!/rose-600|Action required/.test(review))
})
