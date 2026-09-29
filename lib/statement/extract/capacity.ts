/**
 * How many PDF extractions this ONE Node.js process will run at a time.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A PER-PROCESS LIMIT. IT IS NOT A GLOBAL LIMIT.
 *
 * The counter below lives in one module instance inside one Node process.
 * Vercel runs many instances concurrently and scales them independently, so N
 * instances each admitting K extractions permits N x K simultaneously
 * platform-wide -- and N is not controlled by this code or observable from it.
 * A genuine global cap needs external coordination (a shared counter, a queue),
 * which is deliberately NOT built here.
 *
 * What this DOES buy: no single process can be asked to hold an unbounded number
 * of pdf.js instances at once. That is the failure this module exists to prevent,
 * and it is worth preventing even though it is not the whole problem.
 * ---------------------------------------------------------------------------
 *
 * WHY IMMEDIATE REJECTION AND NOT A QUEUE. A queue inside a function with a hard
 * duration limit spends the caller's budget waiting rather than working, and the
 * queue itself then needs a bound, a timeout and a cancellation path -- three more
 * things to get wrong. Refusing at once with a Retry-After is smaller and
 * correct. A bounded queue is a later, separately approvable change.
 *
 * WHY 1. It is the conservative candidate, not a measured optimum. Local macOS
 * measurements recorded a ~94 MiB process-RSS peak over baseline for ONE 3.9 MB
 * document and ~176 MiB for three small ones. No serverless memory allowance is
 * verified anywhere in this repository, so there is nothing to size against;
 * starting at one and raising it on evidence is the honest direction.
 */

/** The conservative candidate policy. One active PDF extraction per process. */
export const MAX_CONCURRENT_PDF_EXTRACTIONS = 1

/** Why admission was refused. */
export type CapacityRefusal =
  | 'at-capacity'
  /** A previous extraction's worker could not be confirmed gone. See below. */
  | 'unconfirmed-worker'

/**
 * What a completed extraction reports back, so the slot is released only when it
 * is genuinely safe to do so.
 *
 * `exit-confirmed`   the worker thread is gone. The slot returns to the pool.
 * `exit-unconfirmed` `worker.terminate()` could not be confirmed inside its
 *                    reserve. The thread MAY still be running, still holding a
 *                    document, inside a process about to serve somebody else.
 */
export type ReleaseVerdict = 'exit-confirmed' | 'exit-unconfirmed'

export interface CapacitySlot {
  /** Call exactly once, in a `finally`. Repeat calls are ignored. */
  release(verdict: ReleaseVerdict): void
}

export type Admission =
  | { readonly admitted: true; readonly slot: CapacitySlot }
  | { readonly admitted: false; readonly reason: CapacityRefusal }

export interface CapacitySnapshot {
  readonly limit: number
  readonly active: number
  readonly available: number
  /** True once an unconfirmed worker exit has fenced this process off. */
  readonly fenced: boolean
}

export interface PdfCapacity {
  /** Atomic within this process. See the note on atomicity below. */
  tryAcquire(): Admission
  snapshot(): CapacitySnapshot
}

/**
 * Build a capacity gate.
 *
 * Exported as a FACTORY so tests construct their own isolated instance rather
 * than needing a reset hook on the shared one. There is no test-only backdoor on
 * the process-wide gate below.
 */
export function createPdfCapacity(limit: number = MAX_CONCURRENT_PDF_EXTRACTIONS): PdfCapacity {
  const max = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1

  let active = 0
  /**
   * FAIL CLOSED. Set when a worker's exit could not be confirmed.
   *
   * Once set, this process admits no further PDF extraction, for the rest of its
   * life. The reasoning: the only honest thing known about that worker is that
   * nothing could confirm it stopped, so its CPU and its copy of somebody's
   * document may both still be live. Admitting another extraction alongside it
   * would be guessing, and the thing being guessed about is one applicant's
   * document sharing a process with another's.
   *
   * WHAT IT COSTS, stated plainly: this process is degraded until the platform
   * recycles it. Every later PDF upload it receives is refused with a 503, even
   * though the process is otherwise healthy. On a serverless platform that is
   * usually brief -- instances are short-lived -- but on a long-lived server it
   * would persist, and nothing here detects or repairs it. That is a known
   * limitation, not an oversight; the alternative is releasing a slot while an
   * unaccounted thread may still be running, which is worse.
   */
  let fenced = false

  return {
    tryAcquire(): Admission {
      // ATOMIC WITHIN THIS PROCESS, and that is a property of the code shape
      // rather than of a lock. Node runs one JavaScript thread, so the check and
      // the increment below cannot be interleaved by another request as long as
      // NOTHING AWAITS BETWEEN THEM. There is no await in this function, and
      // there must never be one: inserting one would reintroduce exactly the
      // race this guards against, where two simultaneous requests both see a
      // free slot and both take it.
      if (fenced) return { admitted: false, reason: 'unconfirmed-worker' }
      if (active >= max) return { admitted: false, reason: 'at-capacity' }
      active += 1

      let released = false
      return {
        admitted: true,
        slot: {
          release(verdict: ReleaseVerdict): void {
            // Idempotent, so a `finally` that runs twice cannot free a slot twice
            // and let the counter drift below zero.
            if (released) return
            released = true

            if (verdict === 'exit-unconfirmed') {
              // DELIBERATELY DOES NOT DECREMENT. The slot stays held because the
              // resource it represents may still be held. `fenced` then makes the
              // refusal explicit and survives any later change to `max`.
              fenced = true
              return
            }
            active -= 1
          },
        },
      }
    },

    snapshot(): CapacitySnapshot {
      return { limit: max, active, available: Math.max(0, max - active), fenced }
    },
  }
}

/**
 * The gate the route uses. One per Node process, by virtue of module caching.
 *
 * DOCX AND TXT MUST NOT TOUCH THIS. Neither spawns a worker or loads pdf.js, so
 * occupying the PDF slot for them would refuse a PDF upload in order to protect
 * nothing. The dispatcher acquires this only on the PDF path.
 */
export const pdfCapacity: PdfCapacity = createPdfCapacity()
