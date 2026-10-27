/**
 * The parent side: spawn ONE dedicated worker, drive it, and guarantee it dies.
 * TEST-ONLY PROTOTYPE.
 *
 * THE CONTRACT THIS EXISTS TO PROVE
 *
 *   Every call creates its own worker and every call ends with that worker
 *   gone, by one of four routes: it finished, it failed, it was cancelled, or
 *   the budget expired. There is no fifth route and no reuse.
 *
 * ---------------------------------------------------------------------------
 * ONE BUDGET, NOT A DEADLINE PLUS EXTRAS.
 *
 * `PRODUCTION_DEADLINE_MS` (45,000) is the budget for the WHOLE operation. The
 * parent-side copy, the spawn, the pdf.js load, extraction, cooperative
 * cancellation, cleanup and forced termination are all paid out of it. Nothing
 * is added afterwards.
 *
 * It did not work this way before, and the audit showed the cost: the deadline
 * covered extraction only, then 2,000 ms of grace was ADDED, then an UNBOUNDED
 * `await worker.terminate()` was added after that. A frozen worker held the
 * request for 47 seconds with no ceiling, against a 60-second function limit
 * that is not 60 seconds of usable time.
 *
 * limits.planBudget() carves the budget into three:
 *
 *      |<------------------ 45,000 total ------------------>|
 *      |<---- extraction 42,000 ---->|<- 2,000 ->|<- 1,000 ->|
 *       spawn, pdf.js, parse          cooperative  terminate
 *                                     cancel       wait
 *
 * THE ESCALATION, which is the approved design:
 *
 *   1. Ask.   post `cancel`. A parse at a yield point notices, cleans up and
 *             exits on its own terms.
 *   2. Wait.  the cooperative reserve. This is the only window in which pdf.js's
 *             own teardown can run, because `loadingTask.destroy()` awaits a
 *             Terminate round-trip that a stuck parse never answers.
 *   3. Take.  `worker.terminate()`. Tears down the V8 isolate. It does not ask
 *             the parser's permission, which is the whole point of the
 *             fallback -- and it is the ONLY step that works on a stuck parse.
 *
 * ---------------------------------------------------------------------------
 * A RESULT THAT ARRIVES LATE IS NOT A SUCCESS.
 *
 * The extraction allowance is the allowance. Phase 1B caught this the hard way:
 * the deadline expired at +200.7 ms, the worker kept going, and its `done`
 * message arrived at +236 ms -- inside the cooperative grace window, so `finish`
 * had not run yet and the `done` handler resolved the call as `ok: true`. The
 * operation reported success 36 ms after its own extraction deadline.
 *
 * TWO INDEPENDENT TESTS, because either alone has a hole:
 *
 *   `outcome` is set     a stop was already decided (deadline or abort), so a
 *                        later success cannot overturn it.
 *   allowance elapsed    measured from the budget start. A `setTimeout` can
 *                        fire LATE under a congested loop, so a `done` dequeued
 *                        before the timer's callback would otherwise sail
 *                        through with `outcome` still null.
 *
 * JUDGED BY WHEN THE WORKER PRODUCED THE RESULT, not when the parent dequeued
 * it: the worker stamps `at` on its own `done` message. Using receipt time would
 * punish a worker that finished inside its allowance for the parent's own
 * scheduling delay -- which is the scheduling race, not a slow document.
 * ---------------------------------------------------------------------------
 *
 * WHAT STEP 3 CANNOT PROMISE. `worker.terminate()` has no documented upper
 * bound. V8 interrupts JS; it does not interrupt arbitrary native code, and
 * there are native bindings in this dependency tree. So the parent bounds how
 * long it WAITS, not how long the thread takes. Past the bound the call returns
 * with `termination.state === 'unconfirmed'` and `cleanupConfirmed === false`.
 * A wait that timed out is never reported as a successful cleanup.
 * ---------------------------------------------------------------------------
 *
 * ONE WORKER, ONE HANDLE. The terminate call is bound to the handle this call
 * created. There is no registry, no pool and no lookup, so it is not possible
 * for one extraction's deadline to reach another's worker. That property is
 * structural rather than enforced, and isolation.test.mjs asserts it.
 *
 * ALL TIMINGS ARE MEASURED, NEVER ASSUMED. Nothing here contains a performance
 * figure. Phase 1B supplies them.
 */

import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { planBudget } from './limits.mjs'

const WORKER_URL = new URL('./worker.mjs', import.meta.url)
const now = () => performance.timeOrigin + performance.now()

/** This prototype's own directory. Nothing outside it may be run as a worker. */
const PROTOTYPE_DIR = new URL('./', import.meta.url).href

/**
 * Which script to run as the worker. `WORKER_URL` unless a test says otherwise.
 *
 * WHY THIS EXISTS. The parent's late-success rejection path cannot be reached
 * with the real worker: once it receives a `cancel` it throws and posts an
 * `error`, never a late `done`. That is the cooperative-cancellation fix working
 * correctly, and it left `finish()`'s rejected-result construction unexercised.
 * A stub worker that deliberately disobeys is the only way to run that branch.
 *
 * CONTAINED BY CONSTRUCTION, not by convention:
 *   - the default is unconditional; omitting the option cannot select anything else
 *   - the override must resolve INSIDE this prototype directory, and `new URL()`
 *     normalises away `..` segments before the check, so no traversal escapes it
 *   - it must end in `.mjs`
 *   - it is a parameter of a test-only prototype function. No route, request
 *     body, query string or environment variable reaches it, and nothing in
 *     app/ or lib/ imports this module.
 *
 * So the worst a caller can do -- even one wired to untrusted input, which none
 * is -- is run one of the handful of .mjs files sitting next to this one.
 */
function resolveWorkerUrl(override) {
  if (override === undefined || override === null) return WORKER_URL
  const url = override instanceof URL ? override : new URL(String(override), import.meta.url)
  if (!url.href.startsWith(PROTOTYPE_DIR) || !url.href.endsWith('.mjs')) {
    throw new Error('__testWorkerUrl must name an .mjs file inside the prototype directory')
  }
  return url
}

/**
 * A message, bounded, never the object.
 *
 * Same reasoning as worker.mjs: an error raised while parsing can quote the
 * document it was parsing, so only a truncated message crosses this boundary
 * and nothing here is ever logged wholesale.
 */
const safeMessage = (error) => String(error?.message ?? error ?? 'unknown error').slice(0, 200)

/** Milliseconds to three places. Keeps sub-millisecond races legible in a log. */
const round3 = (ms) => Math.round(ms * 1000) / 1000

/**
 * THE DEADLINE RULE, as a pure function. One implementation, two callers:
 * finish() below, and its unit tests.
 *
 * It was inline in finish() until now, which made it unreachable for testing:
 * provoking a rejection end to end requires a worker that is deaf to `cancel`
 * yet still productive, and the cooperative-cancellation fix means no such state
 * exists. A worker that hears a cancel throws and posts an error, never a late
 * `done`. Extracting the rule is what makes the rejection paths assertable at
 * all -- see lateSuccess.test.mjs.
 *
 * NO BEHAVIOUR CHANGED. The predicate is the same `outcome || lateBy > 0` it has
 * always been, on the same two inputs, with the same `reason ?? 'deadline'`
 * fallback. Only the marking and the result shaping stay in finish(), because
 * those are effects rather than decisions.
 *
 * PURE. No clock, no timeline, no worker. Every time it needs is passed in,
 * which is the whole point: the caller supplies `now()`, a test supplies a
 * fixture.
 *
 * @param {object} input
 * @param {number} [input.producedAt]  when the WORKER stamped its result. The
 *                                     allowance is about how long extraction
 *                                     took, not about when the parent got round
 *                                     to reading the message.
 * @param {number} input.receivedAt    fallback for a missing or unusable stamp.
 *                                     Receipt is never earlier than posting, so
 *                                     the fallback can only be stricter.
 * @param {number} input.spawnedAt     when the budget started.
 * @param {number} input.extractionMs  the extraction allowance out of the budget.
 * @param {string|null} [input.outcome] a stop already recorded ('deadline',
 *                                     'aborted'). Once set it cannot be
 *                                     overturned by a later success.
 * @returns {{accepted: boolean, reason: string|null, producedAt: number,
 *            lateByMs: number, late: boolean, usedReceiptFallback: boolean}}
 */
export function judgeSuccess({ producedAt, receivedAt, spawnedAt, extractionMs, outcome }) {
  const stamped = Number.isFinite(producedAt)
  const at = stamped ? producedAt : receivedAt

  // FAILS CLOSED on an unusable pair of times. finish() always passes a finite
  // `now()` as the fallback, so this is unreachable from the parent -- but a
  // decision function that cannot verify timeliness must not claim it.
  if (!Number.isFinite(at) || !Number.isFinite(spawnedAt) || !Number.isFinite(extractionMs)) {
    return {
      accepted: false,
      reason: outcome ?? 'deadline',
      producedAt: at,
      lateByMs: NaN,
      late: true,
      usedReceiptFallback: !stamped,
    }
  }

  const lateByMs = round3(at - spawnedAt - extractionMs)
  const late = lateByMs > 0
  const accepted = !outcome && !late

  return {
    accepted,
    // The recorded stop wins; a bare allowance overrun with nothing recorded is
    // a deadline by definition.
    reason: accepted ? null : (outcome ?? 'deadline'),
    producedAt: at,
    lateByMs,
    late,
    usedReceiptFallback: !stamped,
  }
}

/**
 * Run one extraction in its own worker.
 *
 * @param {Uint8Array} bytes            the PDF, in memory. Never a path.
 * @param {object}     [options]
 * @param {number}     [options.deadlineMs]   TOTAL budget for the whole
 *                                            operation, not an extraction
 *                                            deadline. Omitted, zero, negative,
 *                                            NaN or Infinite falls back to the
 *                                            approved PRODUCTION_DEADLINE_MS --
 *                                            it can never mean "no timeout".
 *                                            Values above the approved ceiling
 *                                            are clamped down to it.
 * @param {number}     [options.graceMs]      TEST ONLY: a shorter cooperative
 *                                            reserve. Clamped so it cannot push
 *                                            the total past the budget.
 * @param {number}     [options.stallMs]      TEST ONLY, needs allowTestStall
 * @param {boolean}    [options.allowTestStall]
 * @param {AbortSignal}[options.signal]       so a caller (or a closed browser) can cancel
 * @param {object}     [options.resourceLimits] passed to Worker; no value is chosen here
 * @param {string|URL}  [options.__testWorkerUrl] TEST ONLY. A stub worker inside
 *                                            this prototype directory, for the
 *                                            one branch the real worker cannot
 *                                            reach. Omit it and the real PDF
 *                                            worker is used, unconditionally.
 *                                            Never wire this to request data.
 */
export function extractInWorker(bytes, options = {}) {
  const {
    deadlineMs,
    graceMs,
    stallMs = 0,
    allowTestStall = false,
    signal,
    resourceLimits,
    __testWorkerUrl,
  } = options

  const plan = planBudget(deadlineMs, graceMs)

  const timeline = []
  const memorySamples = []
  const mark = (name, at = now(), extra = {}) => timeline.push({ name, at, ...extra })

  // THE BUDGET STARTS HERE -- before the copy and before the worker exists, so
  // that both are charged to it. Previously the timer was armed after both, and
  // a 4 MB copy plus an 11 ms spawn were effectively free.
  const spawnedAt = now()
  mark('parent:spawn-requested', spawnedAt, { plan })

  // COPIED, THEN TRANSFERRED. Both steps, in that order.
  //
  // `slice()` ALLOCATES a new ArrayBuffer and copies the bytes into it. It does
  // not alias, and it does not detach anything. What `transferList` then hands
  // to the worker is that new buffer, so it is the COPY that gets detached --
  // `buffer.byteLength` becomes 0 while `bytes` and `bytes.buffer` are left
  // untouched and fully readable in the parent.
  //
  // So the document exists TWICE at peak: the caller's original, plus the copy
  // in flight. The transfer saves the structured-clone the worker boundary
  // would otherwise perform, not the copy itself.
  //
  // WHY IT STAYS THIS WAY FOR NOW. Transferring `bytes.buffer` directly would
  // avoid the second allocation, but it would detach the CALLER's array --
  // every test that reuses one `load()` across iterations would see an empty
  // buffer on the second run, and a production caller would silently lose its
  // own input. Changing that is an architecture decision, not a comment fix,
  // and it has not been made. memory.test.mjs pins the behaviour described
  // here so the two cannot drift apart again.
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)

  // resolveWorkerUrl() returns WORKER_URL whenever the test-only option is
  // absent, so normal operation is byte-for-byte what it was.
  const worker = new Worker(fileURLToPath(resolveWorkerUrl(__testWorkerUrl)), {
    workerData: { bytes: buffer, stallMs, allowTestStall, cleanupDeadlineMs: plan.cleanupDeadlineMs },
    transferList: [buffer],
    ...(resourceLimits ? { resourceLimits } : {}),
  })
  // Marked separately so the copy-plus-spawn cost is visible in the timeline
  // rather than hidden inside the first span.
  mark('parent:worker-created')

  let settled = false
  let deadlineTimer = null
  let graceTimer = null
  let outcome = null

  // Exit is tracked independently of terminate(), because the EVENT is what
  // actually says the thread is gone.
  let workerExited = false
  let workerExitCode = null

  // ---------------------------------------------------------------------------
  // THE CLEANUP REPORT.
  //
  // Recorded into a variable THE MOMENT it arrives, not into a promise created
  // later. The worker posts `worker-finished` immediately after its result, so
  // the report can land before finish() has begun waiting for it -- and a
  // waiter-only design would miss exactly that case. finish() therefore reads
  // the variable first and only waits if it is still empty.
  //
  // PDF.JS CLEANUP IS NOT WORKER EXIT. These fields are deliberately separate
  // from `termination.cleanupConfirmed`, which means "the thread is gone" and
  // nothing else. Keeping them apart is the point; the existing field is not
  // renamed here.
  // ---------------------------------------------------------------------------
  let cleanupReport = null
  let cleanupWaiter = null

  const noteCleanupReport = (msg) => {
    if (cleanupReport) return
    cleanupReport = {
      // Status words only. Anything not recognised is reported as such rather
      // than assumed good.
      status: ['completed', 'timed-out', 'failed'].includes(msg?.cleanup) ? msg.cleanup : 'unrecognised',
      docCleanup: typeof msg?.docCleanup === 'string' ? msg.docCleanup : null,
      taskDestroy: typeof msg?.taskDestroy === 'string' ? msg.taskDestroy : null,
      workerDeadlineMs: Number.isFinite(msg?.cleanupDeadlineMs) ? msg.cleanupDeadlineMs : null,
      at: msg?.at,
    }
    // Wake finish() if it is already waiting. Harmless if it is not.
    cleanupWaiter?.()
  }

  /** Milliseconds left in the budget. May go negative; callers clamp. */
  const remaining = () => plan.budgetMs - (now() - spawnedAt)

  return new Promise((resolve) => {
    /**
     * Request termination and wait a BOUNDED time for confirmation.
     *
     * Returns a description of what is actually known, with five states kept
     * distinct and none of them optimistic:
     *
     *   requestedAt   when terminate() was called
     *   confirmedAt   when exit was CONFIRMED, or null
     *   state         'exited' | 'failed' | 'unconfirmed'
     *   cleanupConfirmed  the only field a caller may read as success
     *   error         why, for the two non-success states
     */
    /**
     * @param {number} allowanceMs  the longest this call may WAIT for
     *   confirmation. The caller decides, because the right answer depends on
     *   the outcome: a cooperative worker has already spent part of the reserve
     *   on its cleanup window, while a forced termination has spent none of it
     *   and gets the whole thing. Always capped by `remaining()` regardless.
     */
    const terminateBounded = async (allowanceMs) => {
      const requestedAt = now()
      mark('parent:terminate-requested', requestedAt)

      // Handlers attached IMMEDIATELY, before the race. If the timer wins, this
      // promise is still observed, so a late rejection can never become an
      // unhandled rejection -- which is what a bare `await` inside a try/catch
      // would have produced once the await was abandoned.
      let attemptError = null
      const attempt = worker.terminate().then(
        () => 'exited',
        (error) => { attemptError = safeMessage(error); return 'failed' },
      )

      // Never wait longer than the budget still permits.
      const boundMs = Math.max(0, Math.min(allowanceMs, remaining()))
      let timer = null
      const bound = new Promise((settle) => {
        timer = setTimeout(() => settle('unconfirmed'), boundMs)
        timer.unref?.()
      })

      const raced = await Promise.race([attempt, bound])
      clearTimeout(timer)

      // The exit event is the authority; terminate() resolving is strong
      // corroboration. Either one confirms. A timer alone confirms nothing.
      const exited = workerExited || raced === 'exited'
      const state = exited ? 'exited' : raced === 'failed' ? 'failed' : 'unconfirmed'

      if (!exited) {
        // Keep observing so the truth reaches the timeline even though the
        // caller has already been answered. THIS DOES NOT MAKE THE WORKER SAFE
        // -- see the limitation noted in the module docblock.
        void attempt.then((late) => {
          mark('parent:terminate-settled-late', now(), {
            late,
            error: attemptError,
            exited: workerExited,
            exitCode: workerExitCode,
          })
        })
      }

      return {
        state,
        cleanupConfirmed: exited,
        requestedAt,
        confirmedAt: exited ? now() : null,
        waitedMs: now() - requestedAt,
        boundMs,
        exitCode: exited ? workerExitCode : null,
        error: exited ? null
          : state === 'failed' ? (attemptError ?? 'terminate() rejected')
            : `worker exit not confirmed within ${boundMs}ms`,
      }
    }

    const finish = async (result) => {
      if (settled) return
      settled = true
      clearTimeout(deadlineTimer)
      clearTimeout(graceTimer)
      signal?.removeEventListener?.('abort', onAbort)

      // THE LATE-SUCCESS GATE. Placed here, in the single funnel every outcome
      // passes through, rather than in the `done` handler -- so no present or
      // future path can resolve a success that its own deadline had already
      // disqualified.
      let outgoing = result
      if (result.ok) {
        // The decision is judgeSuccess()'s. What remains here is only its
        // consequences: a timeline mark, and the shape of what the caller gets.
        const verdict = judgeSuccess({
          producedAt: result.producedAt,
          receivedAt: now(),
          spawnedAt,
          extractionMs: plan.extractionMs,
          outcome,
        })

        if (!verdict.accepted) {
          mark('parent:late-success-rejected', now(), {
            reason: verdict.reason,
            lateByMs: verdict.lateByMs,
            producedAt: verdict.producedAt,
            // Counts only, never the text.
            numPages: result.numPages,
            chars: result.chars,
          })
          outgoing = {
            ok: false,
            reason: verdict.reason,
            // So a caller can tell this apart from a run that produced nothing.
            lateSuccessRejected: true,
            lateByMs: verdict.lateByMs,
            producedAt: verdict.producedAt,
            // The extraction that was thrown away, as COUNTS. The text is
            // deliberately dropped -- a fresh object, so `result.text` cannot
            // ride along. Returning it would be exactly the silent late success
            // this gate exists to prevent.
            rejectedChars: result.chars,
            rejectedNumPages: result.numPages,
            terminatedForcibly: result.terminatedForcibly ?? false,
          }
        } else {
          // The positive half, so a timeline can distinguish "accepted in time"
          // from "rejected late" rather than inferring it from an absence.
          mark('parent:success-within-allowance', now(), {
            producedAt: verdict.producedAt,
            // Negative: how much of the allowance was still unused.
            lateByMs: verdict.lateByMs,
          })
        }
      }

      // ---------------------------------------------------------------------
      // GIVE pdf.js ITS CHANCE -- but only when there is someone to give it to.
      //
      // The audit's finding: the worker posts its result, enters its `finally`,
      // and suspends on the first cleanup await; finish() then reached
      // terminate() with no yield in between, so cleanup got 0.2-0.3 ms and
      // `worker-finished` was absent from every run. This wait is the fix.
      //
      // NOT ON THE FORCED PATH. `terminatedForcibly` means the cooperative grace
      // already expired: the worker is unresponsive by definition and waiting on
      // it would only delay the one mechanism that works. An already-exited
      // worker is skipped for the same reason -- there is nobody left to report.
      //
      // INSIDE THE BUDGET, NEVER BEYOND IT. The window is the cleanup half of
      // the existing reserve, further clamped by what the budget actually has
      // left minus the terminate half. A late-firing deadline shrinks it rather
      // than overrunning the total.
      const mayWaitForCleanup = !result.terminatedForcibly && !workerExited
      if (mayWaitForCleanup && !cleanupReport) {
        const waitMs = Math.max(0, Math.min(plan.cleanupWaitMs, remaining() - plan.terminateWaitMs))
        if (waitMs > 0) {
          mark('parent:cleanup-wait-started', now(), { waitMs })
          await new Promise((resolve) => {
            const timer = setTimeout(() => { cleanupWaiter = null; resolve() }, waitMs)
            timer.unref?.()
            cleanupWaiter = () => { clearTimeout(timer); cleanupWaiter = null; resolve() }
          })
        }
      }

      // Four outcomes, kept distinct, and a fifth for the forced path. A report
      // that arrives after this point still reaches the timeline as
      // `worker:worker-finished`, but it cannot change an outcome already
      // decided -- `settled` was set at the top of finish().
      const pdfjsCleanup = result.terminatedForcibly
        ? 'not-attempted-forced-termination'
        : cleanupReport
          ? cleanupReport.status
          : 'not-reported'
      mark('parent:cleanup-report', now(), {
        pdfjsCleanup,
        docCleanup: cleanupReport?.docCleanup ?? null,
        taskDestroy: cleanupReport?.taskDestroy ?? null,
      })
      // ---------------------------------------------------------------------

      // THE FORCED PATH GETS THE WHOLE RESERVE BACK.
      //
      // WHY IT NEEDED FIXING. Splitting the reserve into a cleanup half and a
      // terminate half was right for a cooperative worker, but it was applied
      // unconditionally -- so the one case that has no cleanup to wait for, and
      // is also the only case where terminate() is genuinely up against an
      // uncooperative thread, had its allowance cut to 40%. At the shortest test
      // budgets that meant 5 ms and 2 ms: the narrowest margin exactly where the
      // widest was wanted.
      //
      // It is not an extension of the budget. The forced path skips the cleanup
      // wait entirely (`mayWaitForCleanup` is false above), so when the grace
      // expires the clock stands at extraction + grace and `remaining()` is
      // precisely `plan.terminateMs`. Handing back the full reserve restores
      // what the split took away; it cannot add to the total, and the
      // `Math.min(allowanceMs, remaining())` inside terminateBounded() is what
      // guarantees that.
      const terminateAllowanceMs = result.terminatedForcibly
        ? plan.terminateMs        // the whole reserve: no cleanup wait was spent
        : plan.terminateWaitMs    // the cooperative share, unchanged

      // Unconditional. Whatever happened, this call tries to end the worker --
      // but what it REPORTS is only what it could confirm.
      const termination = await terminateBounded(terminateAllowanceMs)
      mark('parent:terminated', now(), {
        requestedAt: termination.requestedAt,
        state: termination.state,
        terminateError: termination.error,
      })

      const finishedAt = now()
      resolve({
        ...outgoing,
        // The full, honest picture.
        termination,
        // PDF.JS CLEANUP, SEPARATE FROM WORKER EXIT. One of: 'completed',
        // 'timed-out', 'failed', 'not-reported', 'unrecognised', or
        // 'not-attempted-forced-termination'. `termination.cleanupConfirmed`
        // remains a statement about the THREAD being gone, not about this.
        pdfjsCleanup,
        pdfjsCleanupDetail: cleanupReport
          ? {
            docCleanup: cleanupReport.docCleanup,
            taskDestroy: cleanupReport.taskDestroy,
            workerDeadlineMs: cleanupReport.workerDeadlineMs,
          }
          : null,
        // Kept for existing callers. Null ONLY when exit was confirmed, so an
        // `assert.equal(r.terminateError, null)` still means "cleanly gone".
        terminateError: termination.error,
        timeline,
        memorySamples,
        plan,
        spawnedAt,
        finishedAt,
        elapsedMs: finishedAt - spawnedAt,
        // Measured, not promised: event-loop scheduling can overshoot by a few
        // milliseconds even when every reserve is respected.
        withinBudget: finishedAt - spawnedAt <= plan.budgetMs,
      })
    }

    /** Step 1 and 2 of the escalation. Step 3 is the grace timer firing. */
    const requestStop = (reason) => {
      if (settled || outcome) return
      outcome = reason
      mark('parent:cancel-requested', now(), { reason })
      try {
        worker.postMessage({ type: 'cancel', reason })
      } catch {
        // The worker may already be gone; terminate still runs below.
      }

      // Budget-aware rather than a flat graceMs: if the deadline itself fired
      // late under a congested event loop, the grace shrinks so that the
      // terminate reserve -- and the total budget -- still hold.
      const graceFor = Math.max(0, Math.min(plan.graceMs, remaining() - plan.terminateMs))
      graceTimer = setTimeout(() => {
        mark('parent:grace-expired', now(), { reason, graceFor })
        // Cooperative cancellation did not land. This is the fallback firing,
        // and the ONLY thing that works when a parse never yields.
        void finish({ ok: false, reason, terminatedForcibly: true })
      }, graceFor)
      graceTimer.unref?.()
    }

    const onAbort = () => requestStop('aborted')
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    // ALWAYS ARMED. There is no longer any path on which the timeout is absent.
    // The old guard was `if (deadlineMs > 0)`, and `undefined > 0` is false --
    // so a caller that simply forgot the option got no timer at all and relied
    // entirely on the platform to kill the request.
    //
    // The startup already spent (copy + spawn) is subtracted, because it is
    // inside the budget.
    const startupSoFar = now() - spawnedAt
    deadlineTimer = setTimeout(() => {
      mark('parent:deadline-expired', now(), {
        extractionMs: plan.extractionMs,
        budgetMs: plan.budgetMs,
      })
      requestStop('deadline')
    }, Math.max(0, plan.extractionMs - startupSoFar))
    deadlineTimer.unref?.()

    worker.on('message', (msg) => {
      if (msg?.type === 'phase') {
        mark(`worker:${msg.phase}`, msg.at, msg)
        if (msg.phase === 'worker-finished') noteCleanupReport(msg)
        return
      }
      if (msg?.type === 'memory') {
        memorySamples.push({ label: msg.label, at: msg.at, usage: msg.usage })
        return
      }
      if (msg?.type === 'done') {
        void finish({
          ok: true,
          // When the WORKER produced this, which is what the allowance is about.
          // The gate in finish() decides whether it still counts.
          producedAt: msg.at,
          text: msg.text,
          chars: msg.chars,
          numPages: msg.numPages,
          imageOnly: msg.imageOnly,
          terminatedForcibly: false,
        })
        return
      }
      if (msg?.type === 'error') {
        void finish({
          ok: false,
          reason: msg.cancelled ? (outcome ?? 'cancelled') : 'error',
          errorName: msg.name,
          errorMessage: msg.message,
          // It stopped when asked, so the fallback was not needed.
          terminatedForcibly: false,
        })
      }
    })

    worker.on('error', (error) => {
      mark('parent:worker-error', now())
      void finish({
        ok: false,
        reason: 'worker-error',
        errorName: error?.name ?? 'Error',
        errorMessage: safeMessage(error),
        terminatedForcibly: false,
      })
    })

    worker.on('exit', (code) => {
      // Recorded even when the call has already settled, because
      // terminateBounded() reads these to decide whether exit was CONFIRMED.
      workerExited = true
      workerExitCode = code
      mark('parent:worker-exit', now(), { code })
      void finish({ ok: false, reason: outcome ?? 'exited', exitCode: code, terminatedForcibly: false })
    })
  })
}

/** Convenience for the tests: the gap between two marks, or undefined. */
export function span(timeline, from, to) {
  const a = timeline.find((m) => m.name === from)
  const b = timeline.find((m) => m.name === to)
  return a && b ? b.at - a.at : undefined
}

/** Peak heapUsed across the worker's samples, or undefined if none arrived. */
export function peakHeap(samples) {
  if (!samples.length) return undefined
  return Math.max(...samples.map((s) => s.usage.heapUsed))
}
