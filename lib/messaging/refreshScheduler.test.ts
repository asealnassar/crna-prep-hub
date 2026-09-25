import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createRefreshScheduler,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_MIN_VISIBLE_INTERVAL_MS,
  type Timer,
} from './refreshScheduler.ts'

/**
 * The inbox refresh scheduler, exercised entirely offline.
 *
 * NO REACT, NO DOM, NO NETWORK. The clock and the timer are injected, so these
 * assertions are about coalescing logic only -- none of them can reach
 * Supabase or /api/messages/participants.
 *
 * The property every test here defends: refreshes are COALESCED, never
 * DROPPED, and never postponed without a ceiling.
 */

const REPO = new URL('../../', import.meta.url).pathname
const read = (p: string) => readFileSync(`${REPO}${p}`, 'utf8')
const MODAL = 'components/MessagesModal.tsx'

/** A controllable clock plus timer. Advancing time runs whatever is due. */
function fakeEnv() {
  let t = 1_000_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()

  const timer: Timer = {
    set: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: t + ms, fn })
      return id
    },
    clear: (handle) => {
      timers.delete(handle as number)
    },
  }

  const advance = (ms: number) => {
    const target = t + ms
    for (;;) {
      let nextId: number | null = null
      let nextAt = Infinity
      for (const [id, e] of timers) {
        if (e.at <= target && e.at < nextAt) {
          nextAt = e.at
          nextId = id
        }
      }
      if (nextId === null) break
      const entry = timers.get(nextId)!
      timers.delete(nextId)
      t = entry.at
      entry.fn()
    }
    t = target
  }

  return { now: () => t, timer, advance }
}

function make(over: Partial<Parameters<typeof createRefreshScheduler>[0]> = {}) {
  const env = fakeEnv()
  const runs: number[] = []
  const scheduler = createRefreshScheduler({
    run: () => runs.push(env.now()),
    now: env.now,
    timer: env.timer,
    ...over,
  })
  return { ...env, runs, scheduler }
}

// ------------------------------------------------- 1: realtime debouncing

test('1: a burst of Realtime events produces exactly one refresh', () => {
  const { scheduler, advance, runs } = make()

  // Twenty inserts arriving over two seconds, as a fan-out does.
  for (let i = 0; i < 20; i++) {
    scheduler.onRealtimeEvent()
    advance(100)
  }
  advance(DEFAULT_DEBOUNCE_MS + 1)

  assert.equal(runs.length, 1, '20 events, 1 refresh')
})

test('1b: the refresh happens, it is not swallowed', () => {
  const { scheduler, advance, runs } = make()
  scheduler.onRealtimeEvent()
  assert.equal(runs.length, 0, 'not synchronous')
  advance(DEFAULT_DEBOUNCE_MS)
  assert.equal(runs.length, 1, 'a single event still refreshes')
})

test('1c: separated events each get their own refresh', () => {
  const { scheduler, advance, runs } = make()
  scheduler.onRealtimeEvent()
  advance(DEFAULT_DEBOUNCE_MS + 10)
  scheduler.onRealtimeEvent()
  advance(DEFAULT_DEBOUNCE_MS + 10)
  assert.equal(runs.length, 2, 'two unrelated messages, two refreshes')
})

// ------------------------------------------------- 2: no starvation

test('2: a SUSTAINED stream still refreshes at the max-wait ceiling', () => {
  const { scheduler, advance, runs } = make()

  // An event every 200ms for 12 seconds. A naive trailing debounce would
  // never fire at all, because the timer is pushed back before it expires.
  for (let i = 0; i < 60; i++) {
    scheduler.onRealtimeEvent()
    advance(200)
  }

  assert.ok(runs.length >= 2, `a sustained stream must not starve (got ${runs.length})`)
  // 12s of continuous events, 5s ceiling -> at least every 5s.
  for (let i = 1; i < runs.length; i++) {
    assert.ok(
      runs[i] - runs[i - 1] <= DEFAULT_MAX_WAIT_MS + 1,
      'no gap may exceed the ceiling',
    )
  }
})

test('2b: a new message is never more than maxWaitMs from being visible', () => {
  const { scheduler, advance, runs } = make()
  const firstEventAt = 1_000_000
  scheduler.onRealtimeEvent()
  // Keep the burst alive past the ceiling.
  for (let i = 0; i < 40; i++) {
    scheduler.onRealtimeEvent()
    advance(150)
  }
  assert.ok(runs.length >= 1, 'at least one refresh occurred')
  assert.ok(
    runs[0] - firstEventAt <= DEFAULT_MAX_WAIT_MS + 1,
    'the first refresh lands within the ceiling of the first event',
  )
})

// ------------------------------------------------- 3: visibility throttling

test('3: the mount refresh counts, so an immediate visibilitychange is deferred', () => {
  const { scheduler, advance, runs } = make()

  // Tab switch one second after mount -- the old code did a full reload here.
  advance(1_000)
  scheduler.onVisible()
  advance(1_000)
  assert.equal(runs.length, 0, 'no reload one second after the mount read')
})

test('3b: rapid tab switching collapses to one refresh per window', () => {
  const { scheduler, advance, runs } = make()

  // Fifty switches over ten seconds: editor -> browser -> editor -> ...
  for (let i = 0; i < 50; i++) {
    scheduler.onVisible()
    advance(200)
  }
  assert.equal(runs.length, 0, 'nothing yet: still inside the first window')

  advance(DEFAULT_MIN_VISIBLE_INTERVAL_MS)
  assert.equal(runs.length, 1, '50 switches produced exactly one refresh')
})

test('3c: a deferred visibility refresh is NOT dropped', () => {
  const { scheduler, advance, runs } = make()

  advance(5_000)
  scheduler.onVisible() // inside the 30s window
  assert.equal(runs.length, 0)

  // It must still happen at the window boundary.
  advance(DEFAULT_MIN_VISIBLE_INTERVAL_MS)
  assert.equal(runs.length, 1, 'the deferred refresh fired')
  assert.ok(
    runs[0] <= 1_000_000 + DEFAULT_MIN_VISIBLE_INTERVAL_MS + 1,
    'and fired at the boundary, not later',
  )
})

test('3d: returning after a long absence refreshes immediately', () => {
  const { scheduler, advance, runs } = make()

  advance(DEFAULT_MIN_VISIBLE_INTERVAL_MS + 5_000)
  scheduler.onVisible()
  advance(0)
  assert.equal(runs.length, 1, 'a genuine return is not throttled')
})

test('3e: unread counts can never be stale by more than the window', () => {
  const { scheduler, advance, runs } = make()

  // Pathological: a switch every second for five minutes.
  for (let i = 0; i < 300; i++) {
    scheduler.onVisible()
    advance(1_000)
  }
  assert.ok(runs.length >= 9, `expected ~10 refreshes in 5 minutes, got ${runs.length}`)
  for (let i = 1; i < runs.length; i++) {
    assert.ok(
      runs[i] - runs[i - 1] <= DEFAULT_MIN_VISIBLE_INTERVAL_MS + 1_001,
      'no gap may exceed the visibility window',
    )
  }
})

// ------------------------------------------------- 4: the two triggers cooperate

test('4: a Realtime refresh satisfies a pending visibility refresh', () => {
  const { scheduler, advance, runs } = make()

  advance(1_000)
  scheduler.onVisible() // deferred to t+30s
  scheduler.onRealtimeEvent() // due much sooner
  advance(DEFAULT_DEBOUNCE_MS + 10)

  assert.equal(runs.length, 1, 'the earlier trigger ran')

  // And the deferred visibility refresh must not fire a second time after.
  advance(DEFAULT_MIN_VISIBLE_INTERVAL_MS)
  assert.equal(runs.length, 1, 'one refresh served both triggers')
})

test('4b: the earliest due time always wins', () => {
  const { scheduler, advance, runs } = make()
  advance(40_000)
  scheduler.onRealtimeEvent() // due at +1.5s
  scheduler.onVisible() // eligible immediately, so due now
  advance(1)
  assert.equal(runs.length, 1, 'the immediate visibility refresh ran first')
})

// ------------------------------------------------- 5: lifecycle

test('5: cancel drops anything pending', () => {
  const { scheduler, advance, runs } = make()
  scheduler.onRealtimeEvent()
  scheduler.cancel()
  advance(DEFAULT_MAX_WAIT_MS * 2)
  assert.equal(runs.length, 0, 'unmount must not fire a refresh afterwards')
  assert.equal(scheduler.dueAt(), null)
})

test('5b: runNow refreshes at once and clears what was pending', () => {
  const { scheduler, advance, runs } = make()
  scheduler.onRealtimeEvent()
  scheduler.runNow()
  assert.equal(runs.length, 1)
  advance(DEFAULT_MAX_WAIT_MS * 2)
  assert.equal(runs.length, 1, 'the pending timer was consumed, not left armed')
})

// ------------------------------------------------- 6: the measured win

test('6: the refresh rate is bounded by the window, whatever the trigger rate', () => {
  // This is the guarantee, and it does not depend on a chosen scenario: in any
  // elapsed period, refreshes cannot exceed one per visibility window (plus the
  // one that may be in flight at each edge).
  for (const switchEveryMs of [500, 3_000, 10_000, 29_000]) {
    const { scheduler, advance, runs } = make()
    const elapsed = 4 * 60 * 60 * 1000 // four hours
    const switches = Math.floor(elapsed / switchEveryMs)

    for (let i = 0; i < switches; i++) {
      scheduler.onVisible()
      advance(switchEveryMs)
    }

    const ceiling = Math.ceil(elapsed / DEFAULT_MIN_VISIBLE_INTERVAL_MS) + 1
    assert.ok(
      runs.length <= ceiling,
      `switching every ${switchEveryMs}ms: ${runs.length} refreshes exceeds the ${ceiling} ceiling`,
    )
  }
})

test('6b: a dense working session -- the measured shape -- collapses >10x', () => {
  const { scheduler, advance, runs } = make()

  // Editor -> browser -> Vercel -> Supabase -> editor. Four hours of that is a
  // switch every few seconds, which is what produced 8,999 calls on 2026-09-22.
  let oldBehaviourCalls = 0
  const switchEveryMs = 3_000
  const iterations = (4 * 60 * 60 * 1000) / switchEveryMs

  for (let i = 0; i < iterations; i++) {
    scheduler.onVisible()
    oldBehaviourCalls++
    // 24 messages spread across the same period.
    if (i % 200 === 0) {
      scheduler.onRealtimeEvent()
      oldBehaviourCalls++
    }
    advance(switchEveryMs)
  }

  assert.ok(
    runs.length * 10 < oldBehaviourCalls,
    `expected a >10x reduction, got ${oldBehaviourCalls} -> ${runs.length}`,
  )
})

// ------------------------------------------------- 6c-6h: overlapping runs

/** A scheduler whose run() returns a promise the test resolves by hand. */
function makeAsync(over: Partial<Parameters<typeof createRefreshScheduler>[0]> = {}) {
  const env = fakeEnv()
  const starts: number[] = []
  let settleCurrent: ((v?: unknown) => void) | null = null
  let rejectCurrent: ((e?: unknown) => void) | null = null

  const scheduler = createRefreshScheduler({
    run: () => {
      starts.push(env.now())
      return new Promise((resolve, reject) => {
        settleCurrent = resolve as (v?: unknown) => void
        rejectCurrent = reject as (e?: unknown) => void
      })
    },
    now: env.now,
    timer: env.timer,
    ...over,
  })

  return {
    ...env,
    starts,
    scheduler,
    finish: async () => {
      settleCurrent?.()
      await Promise.resolve()
      await Promise.resolve()
    },
    failCurrent: async () => {
      rejectCurrent?.(new Error('inbox load failed'))
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

test('6c: a second trigger mid-flight does not start an overlapping read', async () => {
  const { scheduler, advance, starts, finish } = makeAsync()

  scheduler.onRealtimeEvent()
  advance(DEFAULT_DEBOUNCE_MS)
  assert.equal(starts.length, 1, 'first read running')

  // More events while it is still in flight.
  scheduler.onRealtimeEvent()
  advance(DEFAULT_MAX_WAIT_MS * 2)
  assert.equal(starts.length, 1, 'no overlapping read was started')

  await finish()
  advance(DEFAULT_DEBOUNCE_MS + 10)
  assert.equal(starts.length, 2, 'the queued trigger ran once the first settled')
})

test('6d: a visibility trigger during a run is deferred by the window, not dropped', async () => {
  const { scheduler, advance, starts, finish } = makeAsync()
  scheduler.onRealtimeEvent()
  advance(DEFAULT_DEBOUNCE_MS)
  assert.equal(starts.length, 1, 'first read running')

  scheduler.onVisible() // arrives mid-flight, inside the throttle window
  await finish()

  // It does NOT queue behind the in-flight run: the throttle already defers it
  // to the end of the visibility window, which is the stronger constraint.
  advance(DEFAULT_DEBOUNCE_MS + 10)
  assert.equal(starts.length, 1, 'still inside the visibility window')

  advance(DEFAULT_MIN_VISIBLE_INTERVAL_MS)
  assert.equal(starts.length, 2, 'and it fired at the window boundary -- not dropped')
})

test('6e: many mid-flight triggers collapse into ONE follow-up run', async () => {
  const { scheduler, advance, starts, finish } = makeAsync()
  scheduler.onRealtimeEvent()
  advance(DEFAULT_DEBOUNCE_MS)
  for (let i = 0; i < 30; i++) scheduler.onRealtimeEvent()
  await finish()
  advance(DEFAULT_MAX_WAIT_MS * 3)
  assert.equal(starts.length, 2, '30 mid-flight events -> exactly one follow-up')
})

test('6f: a REJECTED refresh does not wedge the scheduler', async () => {
  const { scheduler, advance, starts, failCurrent } = makeAsync()

  scheduler.onRealtimeEvent()
  advance(DEFAULT_DEBOUNCE_MS)
  assert.equal(starts.length, 1)

  await failCurrent()

  // A later trigger must still work.
  scheduler.onRealtimeEvent()
  advance(DEFAULT_DEBOUNCE_MS + 10)
  assert.equal(starts.length, 2, 'a failed refresh must not block every later one')
})

test('6g: a synchronous throw also settles', () => {
  const env = fakeEnv()
  let calls = 0
  const scheduler = createRefreshScheduler({
    run: () => {
      calls++
      throw new Error('boom')
    },
    now: env.now,
    timer: env.timer,
  })

  scheduler.onRealtimeEvent()
  env.advance(DEFAULT_DEBOUNCE_MS)
  assert.equal(calls, 1)

  scheduler.onRealtimeEvent()
  env.advance(DEFAULT_DEBOUNCE_MS + 10)
  assert.equal(calls, 2, 'a throwing run must not wedge the scheduler either')
})

test('6h: cancel during a run prevents the queued follow-up', async () => {
  const { scheduler, advance, starts, finish } = makeAsync()
  scheduler.onRealtimeEvent()
  advance(DEFAULT_DEBOUNCE_MS)
  scheduler.onRealtimeEvent() // queued mid-flight
  scheduler.cancel() // unmount
  await finish()
  advance(DEFAULT_MAX_WAIT_MS * 3)
  assert.equal(starts.length, 1, 'unmount must not fire the queued refresh')
})

// ------------------------------------------------- 7: the component is wired to it

test('7: the modal routes both triggers through the scheduler', () => {
  const src = read(MODAL)

  assert.match(src, /createRefreshScheduler/, 'the modal imports the scheduler')
  assert.match(
    src,
    /scheduler\.onRealtimeEvent\(\)/,
    'the Realtime handler goes through the scheduler',
  )
  assert.match(src, /scheduler\.onVisible\(\)/, 'the visibility handler does too')
  assert.match(src, /scheduler\.cancel\(\)/, 'and it is cancelled on unmount')
})

test('7b: neither handler calls loadThreads directly any more', () => {
  const src = read(MODAL)
  const effect = src.slice(
    src.indexOf("const channel = supabase"),
    src.indexOf('// Resolved once, then kept in step'),
  )
  assert.ok(effect.length > 0, 'the subscription effect must still be findable')
  assert.ok(
    !/postgres_changes[\s\S]{0,200}loadThreads\(\)/.test(effect),
    'the Realtime callback must not reload directly',
  )
  assert.ok(
    !/visibilityState === 'visible'\)\s*\{\s*loadThreads\(\)/.test(effect),
    'the visibility handler must not reload directly',
  )
})

test('7c: the mount read is unchanged -- the inbox still loads immediately', () => {
  const src = read(MODAL)
  const effect = src.slice(src.indexOf('useEffect(() => {\n    loadThreads()'))
  assert.ok(
    effect.startsWith('useEffect(() => {\n    loadThreads()'),
    'the mount still calls loadThreads() synchronously, unthrottled',
  )
})

test('7d: exactly one subscription site survives, as singleMount requires', () => {
  const src = read(MODAL)
  const sites = [...src.matchAll(/channel\('thread_messages_live'\)/g)]
  assert.equal(sites.length, 1, 'still exactly one realtime subscription')
  assert.match(src, /event: 'INSERT', schema: 'public', table: 'thread_messages'/,
    'the subscription itself is unchanged -- filtering is NOT part of this phase')
})

test('8: the defaults are the ones the analysis argued for', () => {
  assert.equal(DEFAULT_DEBOUNCE_MS, 1_500)
  assert.equal(DEFAULT_MAX_WAIT_MS, 5_000)
  assert.equal(DEFAULT_MIN_VISIBLE_INTERVAL_MS, 30_000)
  assert.ok(DEFAULT_DEBOUNCE_MS < DEFAULT_MAX_WAIT_MS, 'the ceiling must exceed the debounce')
})
