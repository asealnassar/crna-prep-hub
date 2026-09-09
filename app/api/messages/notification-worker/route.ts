import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import { randomUUID } from 'crypto'
import { isAdminEmail } from '@/lib/apiAuth'
import {
  NOTIFICATION_FROM,
  NOTIFICATION_SUBJECT,
  buildNotificationEmail,
} from '@/lib/messageNotify'
import {
  LEASE_MS,
  runWorker,
  senderNameFor,
  previewFor,
  type JobRow,
  type SendOutcome,
  type WorkerDeps,
} from '@/lib/messaging/notificationWorker'

/**
 * Durable notification worker.
 *
 * NOT SCHEDULED. There is no vercel.json and no cron entry in this phase, so
 * nothing invokes this route -- and it additionally refuses to run at all
 * unless CRON_SECRET is configured, which it is not. Both must change before a
 * single production job is touched.
 *
 * Decision logic lives in lib/messaging/notificationWorker.ts, isolated from
 * Supabase, Resend and Next so every branch is testable without a network call
 * or a real row. This file is the shell: authenticate, wire the effects, run.
 */

export const maxDuration = 60

const resend = new Resend(process.env.RESEND_API_KEY)

/** How many jobs one invocation will take. Bounded so a backlog drains over
 *  several runs rather than one long request that risks the timeout. */
const BATCH = 25

/**
 * Cron only.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` when that variable is set.
 * A browser -- anonymous, member, or the admin's own session -- never carries
 * it, so no browser can reach the queue through this route regardless of who
 * is signed in. There is deliberately no session path at all.
 *
 * Fails CLOSED when the secret is absent: an unconfigured deployment refuses
 * rather than running unauthenticated.
 */
function authorize(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('Notification worker: CRON_SECRET is not configured; refusing to run')
    return NextResponse.json({ error: 'Worker not configured' }, { status: 503 })
  }
  const header = request.headers.get('authorization') ?? ''
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

function serviceClient(): SupabaseClient | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) return null
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/**
 * Take a lease on due jobs.
 *
 * Read-then-write rather than a single atomic statement, because PostgREST
 * offers no UPDATE ... RETURNING over a subquery. The lease is what makes that
 * safe: the update is conditioned on the row still being unleased, so a peer
 * that wrote first keeps it and this worker simply sees fewer rows back.
 */
async function claimJobs(db: SupabaseClient, workerId: string, now: number): Promise<JobRow[]> {
  const nowIso = new Date(now).toISOString()
  const leaseUntil = new Date(now + LEASE_MS).toISOString()

  const { data: candidates } = await db
    .from('email_notification_jobs')
    .select('message_id, recipient_user_id, status, attempts, next_attempt_at, lease_owner, lease_expires_at')
    .in('status', ['pending', 'sending'])
    .lte('next_attempt_at', nowIso)
    .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowIso}`)
    .order('next_attempt_at', { ascending: true })
    .limit(BATCH)

  const claimed: JobRow[] = []
  for (const job of (candidates ?? []) as JobRow[]) {
    const { data: won } = await db
      .from('email_notification_jobs')
      .update({ status: 'sending', lease_owner: workerId, lease_expires_at: leaseUntil })
      .eq('message_id', job.message_id)
      .in('status', ['pending', 'sending'])
      .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowIso}`)
      .select('message_id')

    // No row back means a peer leased it between the read and the write.
    if ((won ?? []).length === 1) claimed.push(job)
  }
  return claimed
}

/** Everything the email needs, from the immutable message and the profiles. */
async function resolvePayload(db: SupabaseClient, job: JobRow) {
  const { data: message } = await db
    .from('thread_messages')
    .select('message_text, sender_id')
    .eq('id', job.message_id)
    .maybeSingle()
  if (!message) return null

  const { data: recipient } = await db
    .from('user_profiles')
    .select('email')
    .eq('id', job.recipient_user_id)
    .maybeSingle()
  if (!recipient?.email) return null

  let senderEmail: string | null = null
  if (message.sender_id) {
    const { data: sender } = await db
      .from('user_profiles')
      .select('email')
      .eq('id', message.sender_id)
      .maybeSingle()
    senderEmail = sender?.email ?? null
  }

  return {
    recipientEmail: recipient.email as string,
    senderName: senderNameFor(senderEmail, isAdminEmail(senderEmail)),
    preview: previewFor(message.message_text as string | null),
  }
}

export async function POST(request: NextRequest) {
  const refused = authorize(request)
  if (refused) return refused

  const db = serviceClient()
  if (!db) {
    console.error('Notification worker: SUPABASE_SERVICE_ROLE_KEY is not configured')
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
  }

  const workerId = `worker-${randomUUID()}`

  const deps: WorkerDeps = {
    now: () => Date.now(),
    claim: (id, now) => claimJobs(db, id, now),
    resolvePayload: (job) => resolvePayload(db, job),
    send: async ({ to, senderName, preview, idempotencyKey }): Promise<SendOutcome> => {
      // The SAME builder the browser notify route uses, so the two renderings
      // cannot drift apart.
      const { error } = await resend.emails.send(
        {
          from: NOTIFICATION_FROM,
          to,
          subject: NOTIFICATION_SUBJECT,
          html: buildNotificationEmail(senderName, preview),
        },
        { idempotencyKey },
      )
      if (!error) return { ok: true }
      return { ok: false, code: error.name ?? 'unknown_error', message: error.message ?? '' }
    },
    // Only the seven columns service_role holds UPDATE on. message_id and
    // recipient_user_id are never in a patch, and the grant would refuse them.
    update: async (messageId, patch) => {
      await db.from('email_notification_jobs').update(patch).eq('message_id', messageId)
    },
  }

  try {
    const results = await runWorker(workerId, deps)
    // Counts only -- never a recipient, a message, or a queue row.
    const tally = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1
      return acc
    }, {})
    return NextResponse.json({ processed: results.length, ...tally })
  } catch (error) {
    console.error('Notification worker error:', error)
    return NextResponse.json({ error: 'Worker failed' }, { status: 500 })
  }
}
