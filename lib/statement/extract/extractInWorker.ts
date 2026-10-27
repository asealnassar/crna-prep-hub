/**
 * One PDF extraction in its own dedicated worker. THE INTERNAL LAYER.
 *
 * PORTED FROM test/statement-worker-prototype/extractInWorker.mjs. The escalation,
 * the budget arithmetic, the late-success gate and the termination reporting are
 * the logic that was verified there, with types added. The prototype remains the
 * reference implementation.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT THE INTERFACE A ROUTE SHOULD CALL.
 *
 * It exposes test-only controls (`stallMs`, `allowTestStall`, `graceMs`,
 * `__testWorkerUrl`) and returns internal diagnostics (timelines, memory samples,
 * parser error messages). A route calls `extractStatementPdf()` in
 * extractStatementPdf.ts, which exposes none of that.
 * ---------------------------------------------------------------------------
 *
 * THE ESCALATION, in order:
 *
 *   1. cooperative  postMessage({type:'cancel'}); the worker checks at its yield
 *                   points and exits on its own terms.
 *   2. cleanup      the parent waits a BOUNDED time for the worker's pdf.js
 *                   teardown report -- but not on the forced path, where there is
 *                   by definition nobody listening.
 *   3. terminate    worker.terminate(), with a BOUNDED wait for confirmation.
 *
 * WHAT IT CANNOT PROMISE. `worker.terminate()` has no documented upper bound and
 * cannot interrupt arbitrary native code. When exit is not confirmed inside the
 * reserve, this module says `state: 'unconfirmed'` and returns; it does not
 * pretend the thread is gone. A thread that outlives its own termination is a
 * platform-level risk this code can report but not remove.
 *
 * THE CALLER'S BUFFER IS NEVER DETACHED. See the copy-then-transfer note below.
 *
 * NOTHING IS LOGGED HERE. No document bytes, no extracted text, no parser error
 * object. Error messages that cross the worker boundary are bounded strings and
 * are returned to the caller, not written to a log.
 */

import { Worker, type ResourceLimits } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { planBudget, type BudgetPlan } from './limits.ts'

const WORKER_URL = new URL('./worker.mjs', import.meta.url)

/** This directory. Nothing outside it may be run as a worker. */
const EXTRACT_DIR = new URL('./', import.meta.url).href

/** Absolute, comparable across processes, sub-millisecond. */
const now = (): number => performance.timeOrigin + performance.now()

/**
 * Which script to run as the worker. `WORKER_URL` unless a test says otherwise.
 *
 * WHY THIS EXISTS. The late-success rejection path cannot be reached with the real
 * worker: once it receives a `cancel` it throws and posts an `error`, never a late
 * `done`. That is cooperative cancellation working correctly, and it leaves the
 * rejection branch unexercised. A stub worker that deliberately disobeys is the
 * only way to run it.
 *
 * CONTAINED BY CONSTRUCTION, not by convention:
 *   - the default is unconditional; omitting the option cannot select anything else
 *   - the override must resolve INSIDE this directory, and `new URL()` normalises
 *     away `..` segments before the check, so no traversal escapes it
 *   - it must end in `.mjs`
 *   - it is absent from the application-facing options type, so no route, request
 *     body, query string or environment variable can reach it
 */
function resolveWorkerUrl(override?: string | URL | null): URL {
  if (override === undefined || override === null) return WORKER_URL
  const url = override instanceof URL ? override : new URL(String(override), import.meta.url)
  if (!url.href.startsWith(EXTRACT_DIR) || !url.href.endsWith('.mjs')) {
    throw new Error('__testWorkerUrl must name an .mjs file inside lib/statement/extract')
  }
  return url
}

/**
 * A message, bounded, never the object.
 *
 * Same reasoning as worker.mjs: an error raised while parsing can quote the
 * document it was parsing, so only a bounded message crosses this boundary and
 * nothing here is ever logged.
 */
const safeMessage = (error: unknown): string =>
  String((error as { message?: unknown } | null)?.message ?? error ?? 'unknown error').slice(0, 200)

/** Milliseconds to three places. Keeps sub-millisecond races legible. */
const round3 = (ms: number): number => Math.round(ms * 1000) / 1000

/** Why an operation stopped, as recorded internally. */
export type StopReason = 'deadline' | 'aborted' | 'cancelled' | 'error' | 'worker-error' | 'exited'

/**
 * A RECORDED STOP OUTRANKS ANY LATER CLASSIFICATION. EX-QA-001.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO MAKE IMPOSSIBLE
 * ---------------------------------------------------------------------------
 * requestStop() latches `outcome` once and the comment on judgeSuccess says it
 * "cannot be overturned by a later success". That held for successes. It did
 * not hold for errors: two of the three failure paths resolved their reason
 * without consulting the ledger at all.
 *
 *   worker message error:  msg.cancelled ? (outcome ?? 'cancelled') : 'error'
 *   worker thread error:   'worker-error'
 *   worker exit:           outcome ?? 'exited'          <- the only correct one
 *
 * So an abort raised mid-parse, where pdf.js then threw something that is not a
 * Cancelled instance, reported `cancelled: false`; the first line above
 * discarded the latched 'aborted' and returned 'error'; classifyFailure matched
 * no known parser-error name and returned malformed/parser-error. Measured in
 * the full suite: an applicant who cancelled an upload was told their document
 * was unreadable. One failure in five full-suite runs.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, IN ONE PLACE
 * ---------------------------------------------------------------------------
 * If a stop was recorded, that is the reason. Only when nothing was recorded
 * does the event get to classify itself -- which is what keeps a genuine parser
 * error on a genuinely malformed document reporting as malformed.
 *
 * It is a function rather than three inline ternaries because a rule stated
 * three times is a rule that can disagree with itself, and because this way it
 * can be tested directly instead of through a race.
 */
export function stopReasonFor(input: {
  /** The ledger: what requestStop() latched, or null if nothing stopped. */
  readonly recorded: string | null
  /** What this event would call itself, with no stop recorded. */
  readonly fallback: StopReason
}): string {
  return input.recorded ?? input.fallback
}

export interface SuccessVerdict {
  readonly accepted: boolean
  readonly reason: string | null
  readonly producedAt: number
  readonly lateByMs: number
  readonly late: boolean
  readonly usedReceiptFallback: boolean
}

/**
 * THE DEADLINE RULE, as a pure function. One implementation, two callers:
 * finish() below, and its unit tests.
 *
 * PURE. No clock, no timeline, no worker. Every time it needs is passed in, which
 * is the whole point: the caller supplies `now()`, a test supplies a fixture.
 *
 * @param producedAt  when the WORKER stamped its result. The allowance is about
 *                    how long extraction took, not about when the parent got
 *                    round to reading the message.
 * @param receivedAt  fallback for a missing or unusable stamp. Receipt is never
 *                    earlier than posting, so the fallback can only be stricter.
 * @param spawnedAt   when the budget started.
 * @param extractionMs the extraction allowance out of the budget.
 * @param outcome     a stop already recorded. Once set it cannot be overturned by
 *                    a later success.
 */
export function judgeSuccess(input: {
  producedAt?: number
  receivedAt: number
  spawnedAt: number
  extractionMs: number
  outcome?: string | null
}): SuccessVerdict {
  const { producedAt, receivedAt, spawnedAt, extractionMs, outcome } = input
  const stamped = Number.isFinite(producedAt)
  const at = (stamped ? producedAt : receivedAt) as number

  // FAILS CLOSED on an unusable pair of times. finish() always passes a finite
  // now() as the fallback, so this is unreachable from the parent -- but a
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
    // The recorded stop wins; a bare allowance overrun with nothing recorded is a
    // deadline by definition.
    reason: accepted ? null : (outcome ?? 'deadline'),
    producedAt: at,
    lateByMs,
    late,
    usedReceiptFallback: !stamped,
  }
}

/** A timeline entry. Diagnostic only; never leaves the internal layer. */
export interface Mark {
  readonly name: string
  readonly at: number
  readonly [extra: string]: unknown
}

export interface MemorySample {
  readonly label: string
  readonly at: number
  readonly usage: NodeJS.MemoryUsage
}

/**
 * What is known about the worker thread's end.
 *
 * `cleanupConfirmed` is the ONLY field a caller may read as success, and it means
 * the THREAD is gone -- not that pdf.js cleaned up. That is `pdfjsCleanup`.
 */
export interface TerminationReport {
  readonly state: 'exited' | 'failed' | 'unconfirmed'
  readonly cleanupConfirmed: boolean
  readonly requestedAt: number
  readonly confirmedAt: number | null
  readonly waitedMs: number
  readonly boundMs: number
  readonly exitCode: number | null
  readonly error: string | null
}

/** pdf.js teardown, kept separate from worker exit. */
export type PdfjsCleanupStatus =
  | 'completed'
  | 'timed-out'
  | 'failed'
  | 'not-reported'
  | 'unrecognised'
  | 'not-attempted-forced-termination'

export interface PdfjsCleanupDetail {
  readonly docCleanup: string | null
  readonly taskDestroy: string | null
  readonly workerDeadlineMs: number | null
}

interface CommonResult {
  readonly termination: TerminationReport
  readonly pdfjsCleanup: PdfjsCleanupStatus
  readonly pdfjsCleanupDetail: PdfjsCleanupDetail | null
  readonly terminateError: string | null
  readonly timeline: readonly Mark[]
  readonly memorySamples: readonly MemorySample[]
  readonly plan: BudgetPlan
  readonly spawnedAt: number
  readonly finishedAt: number
  readonly elapsedMs: number
  readonly withinBudget: boolean
}

export interface WorkerSuccess extends CommonResult {
  readonly ok: true
  readonly producedAt: number
  /** The COMPLETE extracted text. No ceiling is applied here. */
  readonly text: string
  /** Content characters. NOT the same as text.length, which adds page separators. */
  readonly chars: number
  readonly numPages: number
  readonly imageOnly: boolean
  readonly terminatedForcibly: false
}

export interface WorkerFailure extends CommonResult {
  readonly ok: false
  readonly reason: string
  readonly errorName?: string
  /** A bounded message from the parser. Never logged; may quote the document. */
  readonly errorMessage?: string
  readonly exitCode?: number
  readonly terminatedForcibly: boolean
  /** Set when a result arrived after its own deadline and was thrown away. */
  readonly lateSuccessRejected?: boolean
  readonly lateByMs?: number
  readonly producedAt?: number
  /** Counts only. The discarded text is deliberately not carried. */
  readonly rejectedChars?: number
  readonly rejectedNumPages?: number
}

export type WorkerResult = WorkerSuccess | WorkerFailure

export interface ExtractInWorkerOptions {
  /**
   * TOTAL budget for the whole operation, not an extraction deadline. Omitted,
   * zero, negative, NaN or Infinite falls back to PRODUCTION_DEADLINE_MS -- it can
   * never mean "no timeout". Values above the approved ceiling are clamped down.
   */
  deadlineMs?: number
  /** So a caller, or a closed browser, can cancel. */
  signal?: AbortSignal
  /**
   * Passed straight to Worker. NO VALUE IS CHOSEN HERE, deliberately: nothing has
   * measured what a safe per-worker heap cap would be, and guessing one would turn
   * a working extraction into an out-of-memory crash.
   */
  resourceLimits?: ResourceLimits
  /** TEST ONLY: a shorter cooperative reserve. */
  graceMs?: number
  /** TEST ONLY, requires allowTestStall. */
  stallMs?: number
  /** TEST ONLY. */
  allowTestStall?: boolean
  /** TEST ONLY. A stub worker inside this directory. Never wire to request data. */
  __testWorkerUrl?: string | URL
}

/** Run one extraction in its own worker. Resolves; it does not reject. */
export function extractInWorker(
  bytes: Uint8Array,
  options: ExtractInWorkerOptions = {},
): Promise<WorkerResult> {
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

  const timeline: Mark[] = []
  const memorySamples: MemorySample[] = []
  const mark = (name: string, at: number = now(), extra: Record<string, unknown> = {}): void => {
    timeline.push({ name, at, ...extra } as Mark)
  }

  // THE BUDGET STARTS HERE -- before the copy and before the worker exists, so
  // that both are charged to it.
  const spawnedAt = now()
  mark('parent:spawn-requested', spawnedAt, { plan })

  // COPIED, THEN TRANSFERRED. Both steps, in that order.
  //
  // `slice()` ALLOCATES a new ArrayBuffer and copies the bytes into it. It does
  // not alias, and it does not detach anything. What `transferList` then hands to
  // the worker is that new buffer, so it is the COPY that gets detached --
  // `buffer.byteLength` becomes 0 while `bytes` and `bytes.buffer` are left
  // untouched and fully readable in the caller.
  //
  // So the document exists TWICE at peak. The transfer saves the structured clone
  // the worker boundary would otherwise perform, not the copy itself.
  //
  // WHY IT STAYS THIS WAY. Transferring `bytes.buffer` directly would avoid the
  // second allocation, but it would detach the CALLER's array -- a route that
  // reuses its request body, or retries, would silently lose its own input.
  //
  // WHY NOT `bytes.buffer.slice(...)`, WHICH IS WHAT THE PROTOTYPE DID. A
  // `Uint8Array`'s buffer is typed `ArrayBuffer | SharedArrayBuffer`, and slicing a
  // SharedArrayBuffer yields another SharedArrayBuffer -- which is not
  // transferable, so `transferList` below would have thrown at runtime. Allocating
  // the target explicitly is the same copy for the ordinary case, and it produces a
  // transferable buffer whatever the input was backed by.
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)

  const worker = new Worker(fileURLToPath(resolveWorkerUrl(__testWorkerUrl)), {
    workerData: { bytes: buffer, stallMs, allowTestStall, cleanupDeadlineMs: plan.cleanupDeadlineMs },
    transferList: [buffer],
    ...(resourceLimits ? { resourceLimits } : {}),
  })
  mark('parent:worker-created')

  let settled = false
  let deadlineTimer: NodeJS.Timeout | null = null
  let graceTimer: NodeJS.Timeout | null = null
  let outcome: string | null = null

  // Exit is tracked independently of terminate(), because the EVENT is what
  // actually says the thread is gone.
  let workerExited = false
  let workerExitCode: number | null = null

  // ---------------------------------------------------------------------------
  // THE CLEANUP REPORT.
  //
  // Recorded into a variable THE MOMENT it arrives, not into a promise created
  // later. The worker posts its report immediately after its result, so the report
  // can land before finish() has begun waiting for it -- and a waiter-only design
  // would miss exactly that case. finish() therefore reads the variable first and
  // only waits if it is still empty.
  //
  // PDF.JS CLEANUP IS NOT WORKER EXIT. These fields are deliberately separate from
  // `termination.cleanupConfirmed`, which means "the thread is gone" and nothing
  // else.
  // ---------------------------------------------------------------------------
  interface CleanupReport {
    status: PdfjsCleanupStatus
    docCleanup: string | null
    taskDestroy: string | null
    workerDeadlineMs: number | null
    at: number | undefined
  }
  let cleanupReport: CleanupReport | null = null
  let cleanupWaiter: (() => void) | null = null

  const noteCleanupReport = (msg: Record<string, unknown>): void => {
    if (cleanupReport) return
    const reported = msg?.cleanup
    cleanupReport = {
      // Status words only. Anything not recognised is reported as such rather than
      // assumed good.
      status:
        reported === 'completed' || reported === 'timed-out' || reported === 'failed'
          ? reported
          : 'unrecognised',
      docCleanup: typeof msg?.docCleanup === 'string' ? msg.docCleanup : null,
      taskDestroy: typeof msg?.taskDestroy === 'string' ? msg.taskDestroy : null,
      workerDeadlineMs: Number.isFinite(msg?.cleanupDeadlineMs)
        ? (msg.cleanupDeadlineMs as number)
        : null,
      at: typeof msg?.at === 'number' ? msg.at : undefined,
    }
    // Wake finish() if it is already waiting. Harmless if it is not.
    cleanupWaiter?.()
  }

  /** Milliseconds left in the budget. May go negative; callers clamp. */
  const remaining = (): number => plan.budgetMs - (now() - spawnedAt)

  return new Promise<WorkerResult>((resolve) => {
    /**
     * Request termination and wait a BOUNDED time for confirmation.
     *
     * @param allowanceMs the longest this call may WAIT for confirmation. The
     *   caller decides, because the right answer depends on the outcome: a
     *   cooperative worker has already spent part of the reserve on its cleanup
     *   window, while a forced termination has spent none of it and gets the whole
     *   thing. Always capped by `remaining()` regardless.
     */
    const terminateBounded = async (allowanceMs: number): Promise<TerminationReport> => {
      const requestedAt = now()
      mark('parent:terminate-requested', requestedAt)

      // Handlers attached IMMEDIATELY, before the race. If the timer wins, this
      // promise is still observed, so a late rejection can never become an
      // unhandled rejection.
      let attemptError: string | null = null
      const attempt: Promise<'exited' | 'failed'> = worker.terminate().then(
        () => 'exited' as const,
        (error: unknown) => {
          attemptError = safeMessage(error)
          return 'failed' as const
        },
      )

      // Never wait longer than the budget still permits.
      const boundMs = Math.max(0, Math.min(allowanceMs, remaining()))
      let timer: NodeJS.Timeout | null = null
      const bound = new Promise<'unconfirmed'>((settle) => {
        timer = setTimeout(() => settle('unconfirmed'), boundMs)
        timer.unref?.()
      })

      const raced = await Promise.race([attempt, bound])
      if (timer) clearTimeout(timer)

      // The exit event is the authority; terminate() resolving is strong
      // corroboration. Either one confirms. A timer alone confirms nothing.
      const exited = workerExited || raced === 'exited'
      const state: TerminationReport['state'] = exited
        ? 'exited'
        : raced === 'failed'
          ? 'failed'
          : 'unconfirmed'

      if (!exited) {
        // Keep observing so the truth reaches the timeline even though the caller
        // has already been answered. THIS DOES NOT MAKE THE WORKER SAFE.
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
        error: exited
          ? null
          : state === 'failed'
            ? (attemptError ?? 'terminate() rejected')
            : `worker exit not confirmed within ${boundMs}ms`,
      }
    }

    interface Incoming {
      ok: boolean
      reason?: string
      producedAt?: number
      text?: string
      chars?: number
      numPages?: number
      imageOnly?: boolean
      errorName?: string
      errorMessage?: string
      exitCode?: number
      terminatedForcibly?: boolean
    }

    const finish = async (result: Incoming): Promise<void> => {
      if (settled) return
      settled = true
      if (deadlineTimer) clearTimeout(deadlineTimer)
      if (graceTimer) clearTimeout(graceTimer)
      signal?.removeEventListener?.('abort', onAbort)

      // THE LATE-SUCCESS GATE. Placed here, in the single funnel every outcome
      // passes through, rather than in the `done` handler -- so no present or
      // future path can resolve a success that its own deadline had already
      // disqualified.
      let outgoing: Record<string, unknown> = result as unknown as Record<string, unknown>
      if (result.ok) {
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
            // deliberately dropped -- a fresh object, so `result.text` cannot ride
            // along. Returning it would be exactly the silent late success this
            // gate exists to prevent.
            rejectedChars: result.chars,
            rejectedNumPages: result.numPages,
            terminatedForcibly: result.terminatedForcibly ?? false,
          }
        } else {
          // The positive half, so a timeline can distinguish "accepted in time"
          // from "rejected late" rather than inferring it from an absence.
          mark('parent:success-within-allowance', now(), {
            producedAt: verdict.producedAt,
            lateByMs: verdict.lateByMs,
          })
        }
      }

      // ---------------------------------------------------------------------
      // GIVE pdf.js ITS CHANCE -- but only when there is someone to give it to.
      //
      // NOT ON THE FORCED PATH. `terminatedForcibly` means the cooperative grace
      // already expired: the worker is unresponsive by definition and waiting on
      // it would only delay the one mechanism that works. An already-exited worker
      // is skipped for the same reason -- there is nobody left to report.
      //
      // INSIDE THE BUDGET, NEVER BEYOND IT. The window is the cleanup half of the
      // reserve, further clamped by what the budget actually has left minus the
      // terminate half. A late-firing deadline shrinks it rather than overrunning.
      const mayWaitForCleanup = !result.terminatedForcibly && !workerExited
      if (mayWaitForCleanup && !cleanupReport) {
        const waitMs = Math.max(0, Math.min(plan.cleanupWaitMs, remaining() - plan.terminateWaitMs))
        if (waitMs > 0) {
          mark('parent:cleanup-wait-started', now(), { waitMs })
          await new Promise<void>((done) => {
            const timer = setTimeout(() => {
              cleanupWaiter = null
              done()
            }, waitMs)
            timer.unref?.()
            cleanupWaiter = () => {
              clearTimeout(timer)
              cleanupWaiter = null
              done()
            }
          })
        }
      }

      // Four outcomes, kept distinct, and a fifth for the forced path. A report
      // that arrives after this point still reaches the timeline, but it cannot
      // change an outcome already decided -- `settled` was set at the top.
      const pdfjsCleanup: PdfjsCleanupStatus = result.terminatedForcibly
        ? 'not-attempted-forced-termination'
        : cleanupReport
          ? cleanupReport.status
          : 'not-reported'
      mark('parent:cleanup-report', now(), {
        pdfjsCleanup,
        docCleanup: cleanupReport?.docCleanup ?? null,
        taskDestroy: cleanupReport?.taskDestroy ?? null,
      })

      // THE FORCED PATH GETS THE WHOLE RESERVE.
      //
      // It is not an extension of the budget. The forced path skips the cleanup
      // wait entirely, so when the grace expires the clock stands at extraction +
      // grace and `remaining()` is precisely `plan.terminateMs`. Handing back the
      // full reserve restores what the split took away; it cannot add to the
      // total, and the Math.min(allowanceMs, remaining()) inside terminateBounded()
      // is what guarantees that.
      const terminateAllowanceMs = result.terminatedForcibly
        ? plan.terminateMs // the whole reserve: no cleanup wait was spent
        : plan.terminateWaitMs // the cooperative share

      // Unconditional. Whatever happened, this call tries to end the worker -- but
      // what it REPORTS is only what it could confirm.
      const termination = await terminateBounded(terminateAllowanceMs)
      mark('parent:terminated', now(), {
        requestedAt: termination.requestedAt,
        state: termination.state,
        terminateError: termination.error,
      })

      const finishedAt = now()
      resolve({
        ...outgoing,
        termination,
        pdfjsCleanup,
        pdfjsCleanupDetail: cleanupReport
          ? {
            docCleanup: cleanupReport.docCleanup,
            taskDestroy: cleanupReport.taskDestroy,
            workerDeadlineMs: cleanupReport.workerDeadlineMs,
          }
          : null,
        // Null ONLY when exit was confirmed, so `terminateError === null` still
        // means "cleanly gone".
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
      } as unknown as WorkerResult)
    }

    /** Steps 1 and 2 of the escalation. Step 3 is the grace timer firing. */
    const requestStop = (reason: string): void => {
      if (settled || outcome) return
      outcome = reason
      mark('parent:cancel-requested', now(), { reason })
      try {
        worker.postMessage({ type: 'cancel', reason })
      } catch {
        // The worker may already be gone; terminate still runs below.
      }

      // Budget-aware rather than a flat graceMs: if the deadline itself fired late
      // under a congested event loop, the grace shrinks so that the terminate
      // reserve -- and the total budget -- still hold.
      const graceFor = Math.max(0, Math.min(plan.graceMs, remaining() - plan.terminateMs))
      graceTimer = setTimeout(() => {
        mark('parent:grace-expired', now(), { reason, graceFor })
        // Cooperative cancellation did not land. This is the fallback firing, and
        // the ONLY thing that works when a parse never yields.
        void finish({ ok: false, reason, terminatedForcibly: true })
      }, graceFor)
      graceTimer.unref?.()
    }

    const onAbort = (): void => requestStop('aborted')
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    // ALWAYS ARMED. There is no path on which the timeout is absent. The startup
    // already spent (copy + spawn) is subtracted, because it is inside the budget.
    const startupSoFar = now() - spawnedAt
    deadlineTimer = setTimeout(
      () => {
        mark('parent:deadline-expired', now(), {
          extractionMs: plan.extractionMs,
          budgetMs: plan.budgetMs,
        })
        requestStop('deadline')
      },
      Math.max(0, plan.extractionMs - startupSoFar),
    )
    deadlineTimer.unref?.()

    worker.on('message', (msg: Record<string, unknown>) => {
      if (msg?.type === 'phase') {
        mark(`worker:${String(msg.phase)}`, msg.at as number, msg)
        if (msg.phase === 'worker-finished') noteCleanupReport(msg)
        return
      }
      if (msg?.type === 'memory') {
        memorySamples.push({
          label: String(msg.label),
          at: msg.at as number,
          usage: msg.usage as NodeJS.MemoryUsage,
        })
        return
      }
      if (msg?.type === 'done') {
        void finish({
          ok: true,
          // When the WORKER produced this, which is what the allowance is about.
          producedAt: msg.at as number,
          text: msg.text as string,
          chars: msg.chars as number,
          numPages: msg.numPages as number,
          imageOnly: msg.imageOnly as boolean,
          terminatedForcibly: false,
        })
        return
      }
      if (msg?.type === 'error') {
        void finish({
          ok: false,
          // The ledger first. `msg.cancelled` only decides what this event
          // would have called itself had nothing been recorded.
          reason: stopReasonFor({
            recorded: outcome,
            fallback: msg.cancelled ? 'cancelled' : 'error',
          }),
          errorName: msg.name as string,
          errorMessage: msg.message as string,
          // It stopped when asked, so the fallback was not needed.
          terminatedForcibly: false,
        })
      }
    })

    worker.on('error', (error: Error) => {
      mark('parent:worker-error', now())
      void finish({
        ok: false,
        reason: stopReasonFor({ recorded: outcome, fallback: 'worker-error' }),
        errorName: error?.name ?? 'Error',
        errorMessage: safeMessage(error),
        terminatedForcibly: false,
      })
    })

    worker.on('exit', (code: number) => {
      // Recorded even when the call has already settled, because terminateBounded()
      // reads these to decide whether exit was CONFIRMED.
      workerExited = true
      workerExitCode = code
      mark('parent:worker-exit', now(), { code })
      void finish({
        ok: false,
        reason: stopReasonFor({ recorded: outcome, fallback: 'exited' }),
        exitCode: code,
        terminatedForcibly: false,
      })
    })
  })
}

/** The gap between two marks, or undefined. Diagnostic helper for tests. */
export function span(timeline: readonly Mark[], from: string, to: string): number | undefined {
  const a = timeline.find((m) => m.name === from)
  const b = timeline.find((m) => m.name === to)
  return a && b ? b.at - a.at : undefined
}

/** Peak heapUsed across the worker's samples, or undefined if none arrived. */
export function peakHeap(samples: readonly MemorySample[]): number | undefined {
  if (!samples.length) return undefined
  return Math.max(...samples.map((s) => s.usage.heapUsed))
}
