/**
 * Durable notification worker -- decision logic, isolated from Supabase, Resend
 * and Next so every branch can be exercised without a network call or a real
 * job row.
 *
 * The route is a thin shell around this. Everything the worker decides --
 * whether a job may be claimed, whether a failure is worth retrying, how long
 * to wait, whether a half-finished send may be replayed -- lives here as pure
 * functions plus one orchestrator with injected effects.
 *
 * Constants mirror the broadcast worker exactly. They are not re-derived and
 * not tuned: that system has delivered 510 of 510 in production and its error
 * names come from the provider, not from a guess.
 */

export const MAX_ATTEMPTS = 4
export const BASE_BACKOFF_MS = 1000
export const LEASE_MS = 2 * 60 * 1000

/**
 * How long a job may sit mid-send before replaying it stops being safe.
 * Half of the provider's idempotency retention as this project documents it:
 * being early costs a manual review, being late emails a member twice.
 */
export const SAFE_REPLAY_WINDOW_MS = 12 * 60 * 60 * 1000

/** Provider error names worth another attempt. Taken from the broadcast
 *  worker rather than invented. */
export const RETRYABLE = new Set(['rate_limit_exceeded', 'internal_server_error', 'application_error'])

export type JobStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain'

export type JobRow = {
  message_id: string
  recipient_user_id: string
  status: JobStatus
  attempts: number
  next_attempt_at: string
  lease_owner: string | null
  lease_expires_at: string | null
}

/** What the provider said. `ok` is the only success. */
export type SendOutcome = { ok: true } | { ok: false; code: string; message: string }

export type Payload = { recipientEmail: string; senderName: string; preview: string }

/**
 * The key the browser notify route ALREADY uses for the same message. Both
 * systems presenting it is what lets Phase 1 and this worker overlap without
 * emailing anyone twice.
 */
export const idempotencyKeyFor = (messageId: string) => `message-notification-${messageId}`

export const isRetryable = (code: string) => RETRYABLE.has(code)

/** 1s, 2s, 4s, 8s -- the broadcast worker's ladder. */
export const backoffMs = (attempt: number) => BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1)

/**
 * A job is claimable when it is due and nobody holds it.
 *
 * 'sending' is included deliberately: a worker that died mid-send leaves the
 * row there, and only a later claim can resolve it. Whether that claim is
 * allowed to RE-SEND is a separate question -- see isSafeToReplay.
 */
export function canClaim(job: JobRow, now: number): boolean {
  if (job.status !== 'pending' && job.status !== 'sending') return false
  if (Date.parse(job.next_attempt_at) > now) return false
  if (job.lease_expires_at && Date.parse(job.lease_expires_at) > now) return false
  return true
}

/**
 * May a job left in 'sending' be sent again?
 *
 * The table stores no submitted_at, so the submission time is derived from the
 * lease: a lease is granted for LEASE_MS at the moment of claiming, so
 * lease_expires_at - LEASE_MS is when this job was picked up. That is an
 * approximation of a few seconds against a twelve-hour window, which is well
 * inside the tolerance the window exists to provide.
 *
 * Inside the window the provider still recognises the idempotency key, so a
 * replay is collapsed rather than delivered twice. Outside it, the key may have
 * been forgotten and a replay would be a genuine second email -- so the job is
 * parked as 'uncertain' for a person to look at, never resent.
 */
export function isSafeToReplay(job: JobRow, now: number): boolean {
  if (job.status !== 'sending') return true
  if (!job.lease_expires_at) return true
  const submittedAt = Date.parse(job.lease_expires_at) - LEASE_MS
  return now - submittedAt <= SAFE_REPLAY_WINDOW_MS
}

export type Decision =
  | { kind: 'sent' }
  | { kind: 'retry'; attempts: number; nextAttemptAt: string; lastError: string }
  | { kind: 'failed'; attempts: number; lastError: string }
  | { kind: 'uncertain'; lastError: string }

/**
 * What to record after the provider answered. Attempts always increments, so a
 * job cannot loop forever even if every failure looks retryable.
 */
export function decideAfterSend(
  job: JobRow,
  outcome: SendOutcome,
  now: number,
): Decision {
  if (outcome.ok) return { kind: 'sent' }

  const attempts = job.attempts + 1
  const lastError = `${outcome.code}: ${outcome.message}`.slice(0, 500)

  if (!isRetryable(outcome.code)) return { kind: 'failed', attempts, lastError }
  if (attempts >= MAX_ATTEMPTS) return { kind: 'failed', attempts, lastError }

  return {
    kind: 'retry',
    attempts,
    nextAttemptAt: new Date(now + backoffMs(attempts)).toISOString(),
    lastError,
  }
}

export type WorkerDeps = {
  /** Rows this worker has already leased. */
  claim: (workerId: string, now: number) => Promise<JobRow[]>
  /** Everything the email needs, resolved from the message at send time.
   *  null means the recipient or the message is gone -- permanent. */
  resolvePayload: (job: JobRow) => Promise<Payload | null>
  send: (args: {
    to: string
    senderName: string
    preview: string
    idempotencyKey: string
  }) => Promise<SendOutcome>
  /** Column-scoped update; message_id and recipient_user_id are never passed. */
  update: (messageId: string, patch: Record<string, unknown>) => Promise<void>
  now: () => number
}

export type JobResult = {
  messageId: string
  outcome: 'sent' | 'retry' | 'failed' | 'uncertain' | 'skipped'
  attempts: number
}

/** One job, start to finish. */
export async function processJob(job: JobRow, deps: WorkerDeps): Promise<JobResult> {
  const now = deps.now()

  // A job the previous worker may already have handed to the provider, too
  // long ago to replay safely. Park it rather than risk a second email.
  if (!isSafeToReplay(job, now)) {
    await deps.update(job.message_id, {
      status: 'uncertain',
      last_error: 'submitted outside the safe replay window; not resent',
      lease_owner: null,
      lease_expires_at: null,
    })
    return { messageId: job.message_id, outcome: 'uncertain', attempts: job.attempts }
  }

  const payload = await deps.resolvePayload(job)
  if (!payload) {
    // No recipient address means no email is possible, ever. Retrying would
    // burn attempts against something that cannot change.
    await deps.update(job.message_id, {
      status: 'failed',
      attempts: job.attempts + 1,
      last_error: 'recipient or message could not be resolved',
      lease_owner: null,
      lease_expires_at: null,
    })
    return { messageId: job.message_id, outcome: 'failed', attempts: job.attempts + 1 }
  }

  let outcome: SendOutcome
  try {
    outcome = await deps.send({
      to: payload.recipientEmail,
      senderName: payload.senderName,
      preview: payload.preview,
      idempotencyKey: idempotencyKeyFor(job.message_id),
    })
  } catch (err: any) {
    // A thrown request is a non-answer, not a rejection. Treated as the
    // provider's own transient class so it retries under the same key.
    outcome = { ok: false, code: 'application_error', message: String(err?.message ?? err) }
  }

  const decision = decideAfterSend(job, outcome, deps.now())

  if (decision.kind === 'sent') {
    await deps.update(job.message_id, {
      status: 'sent',
      attempts: job.attempts + 1,
      sent_at: new Date(deps.now()).toISOString(),
      last_error: null,
      lease_owner: null,
      lease_expires_at: null,
    })
    return { messageId: job.message_id, outcome: 'sent', attempts: job.attempts + 1 }
  }

  if (decision.kind === 'retry') {
    await deps.update(job.message_id, {
      status: 'pending',
      attempts: decision.attempts,
      next_attempt_at: decision.nextAttemptAt,
      last_error: decision.lastError,
      lease_owner: null,
      lease_expires_at: null,
    })
    return { messageId: job.message_id, outcome: 'retry', attempts: decision.attempts }
  }

  await deps.update(job.message_id, {
    status: 'failed',
    attempts: (decision as any).attempts,
    last_error: (decision as any).lastError,
    lease_owner: null,
    lease_expires_at: null,
  })
  return { messageId: job.message_id, outcome: 'failed', attempts: (decision as any).attempts }
}

/** Every job this worker leased, in order. */
export async function runWorker(workerId: string, deps: WorkerDeps): Promise<JobResult[]> {
  const jobs = await deps.claim(workerId, deps.now())
  const results: JobResult[] = []
  for (const job of jobs) results.push(await processJob(job, deps))
  return results
}

/**
 * The browser route's rule, applied to a stored sender rather than a session.
 *
 * `isAdmin` is passed in rather than computed: the admin allowlist lives in
 * lib/apiAuth and must have exactly one definition. Keeping the check out of
 * here also keeps this module free of imports, so its every branch can be
 * exercised without pulling in Next, Supabase or Resend.
 */
export function senderNameFor(senderEmail: string | null, isAdmin: boolean): string {
  if (isAdmin) return 'CRNA Prep Hub Admin'
  return senderEmail || 'A CRNA Prep Hub member'
}

/** Preview text, trimmed the same way the browser route trims it. */
export function previewFor(messageText: string | null): string {
  const text = String(messageText ?? '').trim()
  if (!text) return 'You have a new message on CRNA Prep Hub.'
  return text.length > 150 ? `${text.slice(0, 150)}...` : text
}
