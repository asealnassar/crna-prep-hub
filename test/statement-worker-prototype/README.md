# Dedicated PDF worker — Phase 1A prototype

**TEST-ONLY. NOT WIRED TO THE APPLICATION.** No route, page or library imports
anything in this directory. It exists to answer whether one dedicated
`worker_threads` worker per PDF extraction is safe enough to integrate, and the
measurements below are what it answered.

## Why it is here and not in `lib/`

`npm test` globs `lib/**/*.test.ts`. This directory is outside that glob, so
these files cannot join the production suite by accident. They are `.mjs`
rather than `.ts` so they need no loader and no `tsconfig` change.

Its eventual location in the application has NOT been decided. Do not move it
until the integration phase.

## Architecture

One worker per extraction, never pooled, never reused. There is no registry, so
a terminate call can only reach the handle its own call created.

Escalation when an extraction must stop:

1. **Cooperative cancel** — `postMessage({type:'cancel'})`. The worker checks
   between pages and every few stream chunks, yielding with `setImmediate` so
   `parentPort` macrotasks actually land. (pdf.js's `LoopbackPort` dispatches on
   microtasks, which is why plain `await` starved the cancel message.)
2. **Bounded pdf.js cleanup** — `doc.cleanup()` then `loadingTask.destroy()`,
   under a worker-side deadline, with the parent waiting a bounded time for the
   report.
3. **`worker.terminate()`** — the fallback that needs no cooperation from the
   parser. Reached when the cooperative grace expires.

A result produced after the deadline is **rejected, not returned**
(`judgeSuccess()`, which fails closed on non-finite inputs).

**Confirmed worker exit and confirmed pdf.js cleanup are different facts.**
`termination.state === 'exited'` with a finite `confirmedAt` means the thread is
gone. `pdfjsCleanup` says whether cleanup finished: `completed`, `timed-out`,
`failed`, `not-reported`, `unrecognised`, or
`not-attempted-forced-termination` — the last meaning the worker was killed
before cleanup could run.

**Caller buffer ownership.** `extractInWorker()` copies the caller's bytes and
transfers the copy, so the caller's `Uint8Array` is never detached. The document
therefore exists twice at peak. `memory.test.mjs` pins this.

## The 45-second budget

`PRODUCTION_DEADLINE_MS = 45_000` is the **TOTAL** budget for one operation, not
an extraction deadline. Parent-side copy, worker spawn, pdf.js load, document
load, extraction, cooperative cancellation, cleanup and forced termination all
come out of it. Nothing is added afterwards.

`planBudget()` carves it up: extraction 42,000 / cooperative grace 2,000 /
termination reserve 1,000 (cleanup wait 600 + terminate wait 400, worker-side
cleanup deadline 450). An omitted, zero, negative, NaN or Infinite budget falls
back to 45,000 — the timeout cannot be disabled. Larger values clamp down.

## Two different character counts

| | |
|---|---|
| `r.chars` | extracted **content** characters |
| `r.text.length` | the full returned string, `r.chars + r.numPages - 1` |

Pages are joined with `\n`, so the two differ by the page separators. For the
largest fixture: **515,700 content characters, 515,843 including the 143
separators.** `fixtures.mjs` records `estimatedExtracted` as the
**`r.text.length`** figure. Conflating the two has already broken a fixture
once and failed one test run; check which number you mean.

## The worker returns the COMPLETE text

It applies no character ceiling, deliberately. The approved **50,000-character
extraction limit and 20,000-character save limit are the application's job** and
must be enforced outside this directory. Text over the limit must be
**rejected, never silently truncated**.

`limits.mjs` transcribes the approved application limits (`MAX_UPLOAD_BYTES`
4,000,000, `MAX_EXTRACTED_CHARS` 50,000, `MAX_SAVED_CHARS` 20,000) for
reference. Nothing here enforces them.

## Files

| File | Purpose |
|---|---|
| `limits.mjs` | Approved limits, transcribed; the budget and `planBudget()` |
| `worker.mjs` | Worker side: loads pdf.js, extracts, honours cancellation, cleans up |
| `extractInWorker.mjs` | Parent side: one worker, escalation, guaranteed termination, `judgeSuccess()` |
| `fixtures.mjs` | The five synthetic fixtures and the facts recorded about them |
| `simulatedLateWorker.mjs` | A deliberately insubordinate stub worker, for the late-result path |
| `extraction.test.mjs` | Extraction across the fixtures; image-only detection |
| `textBoundary.test.mjs` | Eligibility vs extraction; the no-truncation guard |
| `timeout.test.mjs` | Cooperative cancellation, deadline, forced termination |
| `cleanup.test.mjs` | pdf.js cleanup handshake and its statuses |
| `isolation.test.mjs` | Cross-request isolation, plus the M1 and M2 memory tests |
| `lateSuccess.test.mjs` | Late-result rejection, incl. `judgeSuccess()` unit cases |
| `memory.test.mjs` | Sequential heap behaviour; buffer-ownership pin |
| `startup.test.mjs` | Worker spawn cost |

## Running it

The whole prototype:

```
node --test --expose-gc "test/statement-worker-prototype/*.test.mjs"
```

One test by name (how most measurements below were taken):

```
node --expose-gc --test \
  --test-name-pattern '^isolation: one large PDF process RSS and post-GC$' \
  test/statement-worker-prototype/isolation.test.mjs
```

`--expose-gc` is required by the M1 and M2 tests, which assert `global.gc` is a
function rather than skipping silently.

## Testing status — what has actually been observed

Runs so far were **narrowly filtered single-test or single-suite executions**
under an offline sandbox, not a full-suite pass. **This is not a claim that
every test in every file has been executed.** Anything not listed below should
be treated as unrun.

Extraction has been run against all five fixtures with no drift from the
figures `fixtures.mjs` records. **Those recorded figures are
`r.text.length`, not `r.chars`** — see the two-counts section above. `r.chars`
below is derived as `estimatedExtracted - (pages - 1)`.

| key | size | pages | `r.text.length` | implied `r.chars` | basis |
|---|---|---|---|---|---|
| small | 0.10 MiB | 4 | 14,323 | 14,320 | measured |
| boundary | 0.35 MiB | 14 | 48,525 | 48,512 | estimated |
| mb1 | 0.96 MiB | 37 | 132,524 | 132,488 | projected |
| mb2 | 1.92 MiB | 74 | 265,058 | 264,985 | projected |
| mb4 | 3.73 MiB | 144 | 515,843 | **515,700 (measured)** | projected |

Only **mb4's** `r.chars` has been read directly off a run and written down here;
515,700 + 143 separators = 515,843, which is what `fixtures.mjs` holds. The
other four rows' `r.chars` are arithmetic from the recorded length, not
transcribed measurements — earlier reporting labelled several of these figures
as character counts when they are lengths, so treat any per-fixture `r.chars`
other than mb4's as unconfirmed until a run prints it.

Also observed: cooperative cancellation lands (~0.076 ms receipt latency after
the microtask-starvation fix); the pdf.js cleanup handshake reaches
`pdfjsCleanup === 'completed'` (~0.66 ms teardown); forced termination stays
inside its restored reserve; late results are rejected, including against a
deliberately insubordinate stub worker; concurrent extractions do not disturb
one another.

### M1 and M2 memory measurements

**Local macOS results on Node v25.4.0. They are NOT Vercel measurements and
establish nothing about Vercel capacity.** Both are single observations, both
peaks are **sampled** (10 ms interval, so the true peak is ≥ the figure), and
RSS is process-wide — worker threads share it and their share cannot be
separated out.

| | workers | document | baseline | sampled peak | after 2 × `gc()` |
|---|---|---|---|---|---|
| **M1** | 3 | `small` × 3 | 46.0 MiB | 221.6 MiB | 194.3 MiB |
| **M2** | 1 | `mb4` (3.91 MB) | 46.2 MiB | 140.6 MiB | 130.3 MiB |

M2 ran in 303 ms, 0.67% of the 45-second budget, with cleanup `completed` and
exit confirmed. Parent V8 `heapUsed` fell across both collections in each test.

**Flat RSS after a forced collection is not evidence of a leak**, in either
direction: V8 does not promptly return freed pages to the OS, and a low
`heapUsed` does not prove every native allocation was released. One cycle cannot
answer retention. M3 (2 × `mb4`) and M4 (3 × `mb4`) are unrun.

## Limitations

* **No concurrency limit.** A worker is created per call, with no cap and no
  `resourceLimits`. Unbounded worker creation is possible today. A limit is an
  integration decision, and any per-process semaphore would be **per serverless
  instance, not global**.
* **No production integration.** Nothing imports this. The analyzer still
  accepts `{statement}` JSON only; its upload input is `.txt` read in the
  browser.
* **No verified Vercel compatibility.** Nothing here establishes that
  `worker_threads` is permitted in a deployed function, that the worker file is
  traced into the bundle, or what memory allowance applies — `vercel.json`
  configures no memory at all. All of it needs a preview deployment.
* **No OCR**, and no password-protected or corrupted-PDF fixture exists; those
  error paths are untested.
* No CPU-trap or malicious PDF. The stuck-parse case uses a **test-only**
  synthetic stall inside `worker.mjs`, gated behind `allowTestStall`.
